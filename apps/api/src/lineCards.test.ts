import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readApproveData, readLinkCode } from "@l-shopee/core";
import {
  claimNewCards,
  consumeLineCards,
  customerLinksFor,
  handleLineWebhook,
  jobCardFor,
  linkLineToCar,
  queueJobCards,
  unlinkLine,
  type CardMessage,
} from "./lineCards";
import { lineConfig, verifyLineSignature } from "./line";
import {
  addJobLine,
  approveRepairJobPrice,
  moveRepairJob,
  openRepairJob,
  payRepairJob,
  type JobResult,
  type RepairJobDetail,
} from "./repairJobs";
import { asD1, memoryBucket, memoryKv, migratedDb } from "./testing/realDb";
import worker, { priceBillLines, StockLedger, type Env } from "./index";
import { createStaffSession } from "./staffSession";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

/**
 * Plan 13.2 (owner, 21 + 23 Nov 2026): the customer follows their repair job in LINE, from Den
 * Air's own OA. They link their LINE to their car once with the QR on the bill (pick A); a card
 * goes to every LINE linked to the car at each of the six steps (pick A), sent in the background
 * and retried so staff never wait; the price card's อนุมัติราคา moves the job on (pick A); the ready
 * card leads to the payment QR and staff mark the job paid as today. Nothing is sent until the
 * shop connects its OA.
 */

const T0 = Date.UTC(2026, 10, 23, 3, 0);
const at = (minutes: number) => ({ userId: "u-kae", now: T0 + minutes * 60_000 });
const SECRET = "practice-channel-secret";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ok(r: JobResult): RepairJobDetail {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.job;
}

/** A shop with its OA connected (or not), its name and PromptPay, and a queue that keeps what it gets. */
function shop(connected = true) {
  const raw = migratedDb();
  raw
    .prepare(
      "INSERT INTO users (id, name, name_th, email, role, status, created_at) VALUES ('u-kae', 'เก๋', 'เก๋', 'kae@shop.test', 'super_admin', 'active', 0)",
    )
    .run();
  const db = asD1(raw);
  const { kv } = memoryKv({
    "shop:denair:name": "เด่นแอร์",
    "shop:denair:paymentMethods": JSON.stringify([
      {
        id: "m1",
        position: "เจ้าของ",
        label: "ร้าน",
        promptpayId: "0812345678",
        accountName: "นาย เด่น แอร์",
        isDefault: true,
      },
    ]),
  });
  const { bucket } = memoryBucket();
  const queued: CardMessage[] = [];
  const queue = {
    async send(body: CardMessage) {
      queued.push(body);
    },
    async sendBatch(msgs: { body: CardMessage }[]) {
      queued.push(...msgs.map((m) => m.body));
    },
  };
  const env = {
    DB: db,
    KV: kv,
    IMAGES: bucket,
    LINE_CARDS: queue,
    ...(connected
      ? {
          LINE_CHANNEL_SECRET: SECRET,
          LINE_CHANNEL_ACCESS_TOKEN: "oa-token",
          LINE_OA_ID: "@denair",
        }
      : {}),
  } as unknown as Env;
  const objects = new Map<string, StockLedger>();
  (env as { STOCK_LEDGER: unknown }).STOCK_LEDGER = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => {
      let object = objects.get(id.name);
      if (!object) {
        const ctx = { id, blockConcurrencyWhile: (fn: () => unknown) => fn(), storage: {} };
        object = new StockLedger(ctx as never, env as never);
        objects.set(id.name, object);
      }
      return object;
    },
  };
  return { raw, db, kv, env, queued };
}

const tokenOf = (raw: ReturnType<typeof migratedDb>, jobId: string) =>
  (
    raw.prepare("SELECT customer_token AS t FROM repair_jobs WHERE id = ?").get(jobId) as {
      t: string;
    }
  ).t;

async function openJob(db: D1Database, plate = "1กก1234", province = "ขอนแก่น") {
  return ok(await openRepairJob(db, { licensePlate: plate, plateProvince: province }, at(0)));
}

/** เข้าใหม่ → ตรวจเช็ค → a 3,700 ฿ service line → ประเมินราคา. */
async function toEstimate(db: D1Database, jobId: string) {
  ok(await moveRepairJob(db, jobId, "check", at(1)));
  ok(
    await addJobLine(
      db,
      jobId,
      { lineType: "service", description: "ล้างแอร์", quantity: 1, unitPriceSatang: 370_000 },
      at(2),
    ),
  );
  return ok(await moveRepairJob(db, jobId, "estimate", at(3)));
}

async function toReady(db: D1Database, jobId: string) {
  await toEstimate(db, jobId);
  ok(await moveRepairJob(db, jobId, "agreed", at(4)));
  ok(await moveRepairJob(db, jobId, "working", at(5)));
  return ok(await moveRepairJob(db, jobId, "ready", at(6)));
}

/** LINE's own API, faked: answers every call with `status` and keeps what was sent. */
function fakeLine(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response("{}", { status });
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("base64");

function webhook(events: unknown[], secret = SECRET) {
  const body = JSON.stringify({ destination: "Uoa", events });
  return new Request("https://api.test/line/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": sign(body, secret) },
    body,
  });
}

const textFrom = (userId: string, text: string) => ({
  type: "message",
  replyToken: `reply-${userId}`,
  source: { type: "user", userId },
  message: { type: "text", id: "m1", text },
});

const postbackFrom = (userId: string, data: string) => ({
  type: "postback",
  replyToken: `reply-${userId}`,
  source: { type: "user", userId },
  postback: { data },
});

const links = (raw: ReturnType<typeof migratedDb>) =>
  raw
    .prepare(
      "SELECT line_user_id AS u, license_plate AS plate, plate_province AS province FROM line_links ORDER BY u",
    )
    .all() as { u: string; plate: string; province: string }[];

// ── The job's private code ───────────────────────────────────────────────────────────────────

describe("openRepairJob > every job gets its own private code", () => {
  it("given two jobs > then each has a different 32-character code", async () => {
    const { raw, db } = shop();
    const a = await openJob(db);
    const b = await openJob(db, "2ขข2222");
    expect(tokenOf(raw, a.id)).toMatch(/^[0-9a-f]{32}$/);
    expect(tokenOf(raw, b.id)).toMatch(/^[0-9a-f]{32}$/);
    expect(tokenOf(raw, a.id)).not.toBe(tokenOf(raw, b.id));
  });
});

// ── Linking ─────────────────────────────────────────────────────────────────────────────────

describe("linkLineToCar > the customer links their LINE to their car once", () => {
  it("given the job's code > then the LINE is linked to that car, and linking again changes nothing", async () => {
    const { raw, db } = shop();
    const job = await openJob(db);
    const code = tokenOf(raw, job.id);
    expect(await linkLineToCar(db, code, "U-somchai", T0)).toMatchObject({
      ok: true,
      jobId: job.id,
      plate: "1กก 1234",
      province: "ขอนแก่น",
    });
    await linkLineToCar(db, code, "U-somchai", T0 + 1);
    expect(links(raw)).toEqual([{ u: "U-somchai", plate: "1กก 1234", province: "ขอนแก่น" }]);
  });

  it("given a code no job has > then not found and nothing linked", async () => {
    const { raw, db } = shop();
    await openJob(db);
    expect(await linkLineToCar(db, "f".repeat(32), "U-x", T0)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(links(raw)).toEqual([]);
  });

  it("given the customer blocks the OA > then only their links go", async () => {
    const { raw, db } = shop();
    const job = await openJob(db);
    await linkLineToCar(db, tokenOf(raw, job.id), "U-a", T0);
    await linkLineToCar(db, tokenOf(raw, job.id), "U-b", T0);
    await unlinkLine(db, "U-a");
    expect(links(raw).map((l) => l.u)).toEqual(["U-b"]);
  });
});

// ── Which steps send a card ─────────────────────────────────────────────────────────────────

describe("claimNewCards > each card step is taken for sending exactly once", () => {
  it("given a new job > then its received card, once", async () => {
    const { db } = shop();
    const job = await openJob(db);
    expect((await claimNewCards(db, job.id, T0)).map((c) => c.step)).toEqual(["in"]);
    expect(await claimNewCards(db, job.id, T0)).toEqual([]);
  });

  it("given the owner's steps > then checked and the price send a card; agreed and กำลังซ่อม don't", async () => {
    const { db } = shop();
    const job = await openJob(db);
    await claimNewCards(db, job.id, T0);
    await toEstimate(db, job.id);
    expect((await claimNewCards(db, job.id, T0)).map((c) => c.step)).toEqual(["check", "estimate"]);
    ok(await moveRepairJob(db, job.id, "agreed", at(4)));
    ok(await moveRepairJob(db, job.id, "working", at(5)));
    expect(await claimNewCards(db, job.id, T0)).toEqual([]);
    ok(await moveRepairJob(db, job.id, "ready", at(6)));
    expect((await claimNewCards(db, job.id, T0)).map((c) => c.step)).toEqual(["ready"]);
  });

  it("given the job is paid > then the paid card with the bill", async () => {
    const { db } = shop();
    const job = await openJob(db);
    await toReady(db, job.id);
    await claimNewCards(db, job.id, T0);
    const paid = ok(
      await payRepairJob(db, job.id, { paymentMethod: "promptpay" }, at(7), (l) =>
        priceBillLines(db, l),
      ),
    );
    expect(paid.events.at(-1)).toMatchObject({ kind: "paid", customerUpdate: "paid" });
    expect((await claimNewCards(db, job.id, T0)).map((c) => c.step)).toEqual(["paid"]);
  });
});

describe("queueJobCards > new cards go on the queue; staff never wait for LINE", () => {
  it("given the OA connected > then one queue message per new card", async () => {
    const { db, env, queued } = shop();
    const job = await openJob(db);
    await queueJobCards(env, job.id, T0);
    expect(queued).toEqual([{ shop: "denair", eventId: job.events[0]!.id }]);
    await queueJobCards(env, job.id, T0);
    expect(queued).toHaveLength(1);
  });

  it("given the OA not connected > then nothing is queued, and those steps never send later", async () => {
    const { db, env, queued } = shop(false);
    const job = await openJob(db);
    await queueJobCards(env, job.id, T0);
    expect(queued).toEqual([]);
    expect(await claimNewCards(db, job.id, T0)).toEqual([]);
  });

  it("given the queue fails > then the cards are kept for the next try", async () => {
    const { db, env } = shop();
    const job = await openJob(db);
    (env as { LINE_CARDS: unknown }).LINE_CARDS = {
      sendBatch: async () => {
        throw new Error("queue down");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await queueJobCards(env, job.id, T0);
    expect((await claimNewCards(db, job.id, T0)).map((c) => c.step)).toEqual(["in"]);
  });
});

// ── The card ────────────────────────────────────────────────────────────────────────────────

describe("jobCardFor > who gets the card, and what it says", () => {
  it("given LINEs linked to the car > then each of them, and no one linked to the same plate in another province", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    const other = await openJob(db, "1กก1234", "เชียงใหม่");
    await linkLineToCar(db, tokenOf(raw, job.id), "U-mine", T0);
    await linkLineToCar(db, tokenOf(raw, other.id), "U-other", T0);
    const card = await jobCardFor(env, job.events[0]!.id);
    expect(card?.recipients).toEqual(["U-mine"]);
    expect(card?.message.altText).toContain("เด่นแอร์");
    expect(card?.message.altText).toContain("1กก 1234 ขอนแก่น");
    expect(JSON.stringify(card?.message)).toContain(`/j/${tokenOf(raw, job.id)}`);
  });

  it("given the price card > then อนุมัติราคา carries the job's price", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    const est = await toEstimate(db, job.id);
    await linkLineToCar(db, tokenOf(raw, job.id), "U-mine", T0);
    const card = await jobCardFor(env, est.events.at(-1)!.id);
    const data = /"data":"([^"]+)"/.exec(JSON.stringify(card?.message))![1]!;
    expect(readApproveData(data)).toEqual({ token: tokenOf(raw, job.id), totalSatang: 370_000 });
  });

  it("given no LINE linked > then no one to send to", async () => {
    const { db, env } = shop();
    const job = await openJob(db);
    expect((await jobCardFor(env, job.events[0]!.id))?.recipients).toEqual([]);
  });
});

describe("consumeLineCards > the background sender", () => {
  function batchOf(...bodies: CardMessage[]) {
    const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
    return { messages, batch: { messages } as unknown as MessageBatch<CardMessage> };
  }

  async function linkedJob() {
    const s = shop();
    const job = await openJob(s.db);
    await linkLineToCar(s.db, tokenOf(s.raw, job.id), "U-a", T0);
    await linkLineToCar(s.db, tokenOf(s.raw, job.id), "U-b", T0);
    return { ...s, job, msg: { shop: "denair", eventId: job.events[0]!.id } };
  }

  it("given linked LINEs > then the card is pushed to each, with a retry key that stays the same", async () => {
    const { env, msg } = await linkedJob();
    const line = fakeLine(200);
    const { messages, batch } = batchOf(msg);
    await consumeLineCards(batch, env, line.fetchFn);
    expect(line.calls.map((c) => c.url)).toEqual([
      "https://api.line.me/v2/bot/message/push",
      "https://api.line.me/v2/bot/message/push",
    ]);
    expect(line.calls.map((c) => c.body.to)).toEqual(["U-a", "U-b"]);
    expect(line.calls[0]!.headers.authorization).toBe("Bearer oa-token");
    const key = line.calls[0]!.headers["x-line-retry-key"];
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(messages[0]!.ack).toHaveBeenCalled();

    const again = fakeLine(200);
    await consumeLineCards(batchOf(msg).batch, env, again.fetchFn);
    expect(again.calls[0]!.headers["x-line-retry-key"]).toBe(key);
  });

  it("given LINE busy or down > then the message is tried again later", async () => {
    for (const status of [429, 500, 503]) {
      const { env, msg } = await linkedJob();
      const { messages, batch } = batchOf(msg);
      await consumeLineCards(batch, env, fakeLine(status).fetchFn);
      expect(messages[0]!.retry).toHaveBeenCalled();
      expect(messages[0]!.ack).not.toHaveBeenCalled();
    }
  });

  it("given LINE already has this card (a retry) > then it counts as sent", async () => {
    const { env, msg } = await linkedJob();
    const { messages, batch } = batchOf(msg);
    await consumeLineCards(batch, env, fakeLine(409).fetchFn);
    expect(messages[0]!.ack).toHaveBeenCalled();
  });

  it("given LINE refuses the card for good > then it is dropped and logged, not retried forever", async () => {
    const { env, msg } = await linkedJob();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { messages, batch } = batchOf(msg);
    await consumeLineCards(batch, env, fakeLine(400).fetchFn);
    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
  });

  it("given the OA disconnected since > then nothing is sent and the message is done", async () => {
    const { env, msg } = await linkedJob();
    const off = { ...env, LINE_CHANNEL_ACCESS_TOKEN: undefined } as unknown as Env;
    const line = fakeLine(200);
    const { messages, batch } = batchOf(msg);
    await consumeLineCards(batch, off, line.fetchFn);
    expect(line.calls).toEqual([]);
    expect(messages[0]!.ack).toHaveBeenCalled();
  });
});

// ── อนุมัติราคา ──────────────────────────────────────────────────────────────────────────────

describe("approveRepairJobPrice > the customer approves the price in LINE", () => {
  it("given the price on the card > then ลูกค้าตกลงราคา, and the history says it was approved in LINE", async () => {
    const { db } = shop();
    const job = await openJob(db);
    await toEstimate(db, job.id);
    const agreed = ok(
      await approveRepairJobPrice(db, job.id, 370_000, { userId: null, now: T0 + 10 * 60_000 }),
    );
    expect(agreed.status).toBe("agreed");
    expect(agreed.events.at(-1)).toMatchObject({
      kind: "status",
      fromStatus: "estimate",
      toStatus: "agreed",
      note: "approved_in_line",
      userId: null,
    });
  });

  it("given the price changed since the card > then refused, the job stays at the price step", async () => {
    const { db } = shop();
    const job = await openJob(db);
    await toEstimate(db, job.id);
    expect(
      await approveRepairJobPrice(db, job.id, 300_000, { userId: null, now: T0 + 10 * 60_000 }),
    ).toMatchObject({ ok: false, status: 409, error: "price_changed" });
  });

  it("given the job is past the price step > then refused", async () => {
    const { db } = shop();
    const job = await openJob(db);
    expect(
      await approveRepairJobPrice(db, job.id, 0, { userId: null, now: T0 + 10 * 60_000 }),
    ).toMatchObject({ ok: false, status: 409, error: "not_estimate" });
  });
});

// ── The webhook ─────────────────────────────────────────────────────────────────────────────

describe("handleLineWebhook > what the customer sends to the OA", () => {
  const approveVia = (db: D1Database) =>
    vi.fn((jobId: string, total: number) =>
      approveRepairJobPrice(db, jobId, total, { userId: null, now: T0 + 99 * 60_000 }),
    );

  it("given a body LINE did not sign > then refused and nothing changes", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    const line = fakeLine();
    const res = await handleLineWebhook(
      webhook([textFrom("U-x", tokenOf(raw, job.id))], "someone-else"),
      env,
      approveVia(db),
      line.fetchFn,
    );
    expect(res.status).toBe(401);
    expect(links(raw)).toEqual([]);
    expect(line.calls).toEqual([]);
  });

  it("given a body far bigger than LINE ever sends > then refused before it is read", async () => {
    const { db, env } = shop();
    const req = new Request("https://api.test/line/webhook", {
      method: "POST",
      headers: { "content-length": String(2 * 1024 * 1024), "x-line-signature": "x" },
      body: "{}",
    });
    const res = await handleLineWebhook(req, env, approveVia(db), fakeLine().fetchFn);
    expect(res.status).toBe(413);
  });

  it("given the OA not connected > then there is no such address", async () => {
    const { db, env } = shop(false);
    const res = await handleLineWebhook(webhook([]), env, approveVia(db), fakeLine().fetchFn);
    expect(res.status).toBe(404);
  });

  it("given the QR's message > then the LINE is linked, and the reply confirms it with the job's card", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    const line = fakeLine();
    const res = await handleLineWebhook(
      webhook([textFrom("U-somchai", `แจ้งสถานะ (รหัส ${tokenOf(raw, job.id)})`)]),
      env,
      approveVia(db),
      line.fetchFn,
    );
    expect(res.status).toBe(200);
    expect(links(raw)).toEqual([{ u: "U-somchai", plate: "1กก 1234", province: "ขอนแก่น" }]);
    expect(line.calls).toHaveLength(1);
    expect(line.calls[0]!.url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(line.calls[0]!.body.replyToken).toBe("reply-U-somchai");
    const reply = JSON.stringify(line.calls[0]!.body.messages);
    expect(reply).toContain("1กก 1234 ขอนแก่น");
    expect(reply).toContain("รับรถเข้าซ่อมแล้ว");
  });

  it("given an ordinary chat message > then no reply and nothing linked (staff answer it themselves)", async () => {
    const { raw, db, env } = shop();
    await openJob(db);
    const line = fakeLine();
    const res = await handleLineWebhook(
      webhook([textFrom("U-x", "รถเสร็จยังครับ")]),
      env,
      approveVia(db),
      line.fetchFn,
    );
    expect(res.status).toBe(200);
    expect(links(raw)).toEqual([]);
    expect(line.calls).toEqual([]);
  });

  it("given a code no job has > then the reply says so", async () => {
    const { db, env } = shop();
    const line = fakeLine();
    await handleLineWebhook(
      webhook([textFrom("U-x", "f".repeat(32))]),
      env,
      approveVia(db),
      line.fetchFn,
    );
    expect(JSON.stringify(line.calls[0]!.body.messages)).toContain("ไม่พบงานซ่อม");
  });

  it("given อนุมัติราคา from a linked LINE > then the job moves on and the reply confirms the price", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    await toEstimate(db, job.id);
    const code = tokenOf(raw, job.id);
    await linkLineToCar(db, code, "U-somchai", T0);
    const approve = approveVia(db);
    const line = fakeLine();
    await handleLineWebhook(
      webhook([postbackFrom("U-somchai", `approve=${code}&total=370000`)]),
      env,
      approve,
      line.fetchFn,
    );
    expect(approve).toHaveBeenCalledWith(job.id, 370_000);
    expect(raw.prepare("SELECT status FROM repair_jobs WHERE id = ?").get(job.id)).toEqual({
      status: "agreed",
    });
    expect(JSON.stringify(line.calls[0]!.body.messages)).toContain("฿3,700");
  });

  it("given อนุมัติราคา from a LINE not linked to the car > then nothing moves", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    await toEstimate(db, job.id);
    const approve = approveVia(db);
    await handleLineWebhook(
      webhook([postbackFrom("U-stranger", `approve=${tokenOf(raw, job.id)}&total=370000`)]),
      env,
      approve,
      fakeLine().fetchFn,
    );
    expect(approve).not.toHaveBeenCalled();
  });

  it("given the price changed since the card > then the reply sends them to the latest price", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    await toEstimate(db, job.id);
    const code = tokenOf(raw, job.id);
    await linkLineToCar(db, code, "U-somchai", T0);
    const line = fakeLine();
    await handleLineWebhook(
      webhook([postbackFrom("U-somchai", `approve=${code}&total=100`)]),
      env,
      approveVia(db),
      line.fetchFn,
    );
    const reply = JSON.stringify(line.calls[0]!.body.messages);
    expect(reply).toContain("ราคาเปลี่ยน");
    expect(reply).toContain(`/j/${code}`);
  });

  it("given the customer blocks the OA > then their links go", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    await linkLineToCar(db, tokenOf(raw, job.id), "U-gone", T0);
    await handleLineWebhook(
      webhook([{ type: "unfollow", source: { type: "user", userId: "U-gone" } }]),
      env,
      approveVia(db),
      fakeLine().fetchFn,
    );
    expect(links(raw)).toEqual([]);
  });
});

describe("verifyLineSignature", () => {
  it("given LINE's signature > then true; anything else > false", async () => {
    const body = '{"events":[]}';
    expect(await verifyLineSignature(SECRET, body, sign(body))).toBe(true);
    expect(await verifyLineSignature(SECRET, body, sign(body, "x"))).toBe(false);
    expect(await verifyLineSignature(SECRET, body, "")).toBe(false);
    expect(await verifyLineSignature(SECRET, `${body} `, sign(body))).toBe(false);
  });
});

describe("lineConfig > only a connected shop sends", () => {
  it("given Den Air with all three settings > then connected; one missing > not", () => {
    const { env } = shop();
    expect(lineConfig(env)).toMatchObject({ oaId: "@denair" });
    expect(lineConfig({ ...env, LINE_OA_ID: undefined } as unknown as Env)).toBeNull();
  });

  it("given the practice copy's fake LINE > then on the practice copy only", () => {
    const { env } = shop();
    expect(lineConfig({ ...env, LINE_FAKE: "1", PRACTICE_COPY: "1" } as unknown as Env)?.fake).toBe(
      true,
    );
    expect(lineConfig({ ...env, LINE_FAKE: "1", PRACTICE_COPY: "0" } as unknown as Env)?.fake).toBe(
      false,
    );
  });

  it("given the fake LINE > then nothing reaches LINE and the card counts as sent", async () => {
    const s = shop();
    const env = { ...s.env, LINE_FAKE: "1", PRACTICE_COPY: "1" } as unknown as Env;
    const job = await openJob(s.db);
    await linkLineToCar(s.db, tokenOf(s.raw, job.id), "U-a", T0);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const line = fakeLine(500);
    const message = {
      body: { shop: "denair", eventId: job.events[0]!.id },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeLineCards(
      { messages: [message] } as unknown as MessageBatch<CardMessage>,
      env,
      line.fetchFn,
    );
    expect(line.calls).toEqual([]);
    expect(message.ack).toHaveBeenCalled();
  });

  it("given another shop > then never Den Air's OA", () => {
    const { env } = shop();
    const other = { ...env, SHOP: { id: "two" } } as unknown as Env;
    expect(lineConfig(other)).toBeNull();
  });
});

// ── Through the Worker ──────────────────────────────────────────────────────────────────────

describe("LINE addresses, through the Worker", () => {
  it("given LINE's webhook > then it is answered without a staff sign-in", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    vi.stubGlobal("fetch", fakeLine().fetchFn);
    const res = await worker.fetch!(webhook([textFrom("U-somchai", tokenOf(raw, job.id))]), env, {
      waitUntil: () => {},
    } as unknown as ExecutionContext);
    expect(res.status).toBe(200);
    expect(links(raw)).toHaveLength(1);
  });

  it("given a staff job step > then its card goes on the queue", async () => {
    const { db, env, queued } = shop();
    const { token } = await createStaffSession(db, "u-kae", Date.now());
    const pending: Promise<unknown>[] = [];
    const res = await worker.fetch!(
      new Request("https://x/repair-jobs", {
        method: "POST",
        headers: { "X-Staff-Session": token, "content-type": "application/json" },
        body: JSON.stringify({ licensePlate: "1กก1234", plateProvince: "ขอนแก่น" }),
      }),
      env,
      { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(queued).toHaveLength(1);
  });

  it("given staff opening the job's links > then the job page and, with the OA connected, the QR's address", async () => {
    const { raw, db, env } = shop();
    const job = await openJob(db);
    await linkLineToCar(db, tokenOf(raw, job.id), "U-a", T0);
    const { token } = await createStaffSession(db, "u-kae", Date.now());
    const send = (session: boolean) =>
      worker.fetch!(
        new Request(`https://x/repair-jobs/${job.id}/customer-links`, {
          headers: session ? { "X-Staff-Session": token } : {},
        }),
        env,
        {} as ExecutionContext,
      );
    const res = await send(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pageUrl: string;
      lineLinkUrl: string;
      linkedLines: number;
    };
    const code = tokenOf(raw, job.id);
    expect(body.pageUrl).toBe(`https://teampit.formulal.cc/j/${code}`);
    expect(readLinkCode(decodeURIComponent(body.lineLinkUrl))).toBe(code);
    expect(body.linkedLines).toBe(1);
    expect((await send(false)).status).toBe(401);
  });

  it("given the OA not connected > then the job page only; no QR address", async () => {
    const { db, env } = shop(false);
    const job = await openJob(db);
    expect(await customerLinksFor(env, job.id)).toMatchObject({ lineLinkUrl: null });
  });
});

describe("the deployed Worker config > the card queue", () => {
  it("given wrangler.jsonc > then the cards queue is bound, consumed here, and has a dead-letter queue", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "../../../wrangler.jsonc"), "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")) as {
      queues?: {
        producers?: { binding: string; queue: string }[];
        consumers?: { queue: string; max_retries?: number; dead_letter_queue?: string }[];
      };
    };
    const producer = config.queues?.producers?.find((p) => p.binding === "LINE_CARDS");
    expect(producer?.queue).toBe("teampit-line-cards");
    const consumer = config.queues?.consumers?.find((c) => c.queue === "teampit-line-cards");
    expect(consumer?.dead_letter_queue).toBe("teampit-line-cards-dlq");
    expect(consumer?.max_retries).toBeGreaterThan(0);
  });
});
