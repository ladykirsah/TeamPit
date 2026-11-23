import { describe, it, expect, vi } from "vitest";
import { addJobPhoto } from "./jobPhotos";
import {
  addJobLine,
  moveRepairJob,
  openRepairJob,
  payRepairJob,
  type JobResult,
  type RepairJobDetail,
} from "./repairJobs";
import { asD1, memoryBucket, memoryKv, migratedDb } from "./testing/realDb";
import worker, { priceBillLines, type Env } from "./index";

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
 * Plan 13.2: the private job page behind every LINE card — the steps, the price lines, the
 * waiting time, the photos and the bill, with the payment QR once the car is ready. Anyone with
 * the card's link can open it (no sign-in); nothing the customer shouldn't see is in it.
 */

const T0 = Date.UTC(2026, 10, 23, 3, 0);
const at = (minutes: number) => ({ userId: "u-kae", now: T0 + minutes * 60_000 });

function ok(r: JobResult): RepairJobDetail {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.job;
}

async function shopWithJob(payment = true) {
  const raw = migratedDb();
  raw
    .prepare(
      "INSERT INTO users (id, name, name_th, email, role, status, created_at) VALUES ('u-kae', 'เก๋', 'เก๋', 'kae@shop.test', 'super_admin', 'active', 0)",
    )
    .run();
  const db = asD1(raw);
  const { kv } = memoryKv({
    "shop:denair:name": "เด่นแอร์",
    ...(payment
      ? {
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
        }
      : {}),
  });
  const { bucket } = memoryBucket();
  const env = { DB: db, KV: kv, IMAGES: bucket } as unknown as Env;
  const job = ok(
    await openRepairJob(
      db,
      { licensePlate: "1กก1234", plateProvince: "ขอนแก่น", problem: "แอร์ไม่เย็น" },
      at(0),
    ),
  );
  const code = (
    raw.prepare("SELECT customer_token AS t FROM repair_jobs WHERE id = ?").get(job.id) as {
      t: string;
    }
  ).t;
  const open = (path: string) =>
    worker.fetch!(new Request(`https://x${path}`), env, {} as ExecutionContext);
  return { raw, db, bucket, env, jobId: job.id, code, open };
}

async function priced(db: D1Database, jobId: string) {
  ok(await moveRepairJob(db, jobId, "check", at(1)));
  ok(
    await addJobLine(
      db,
      jobId,
      { lineType: "service", description: "ล้างแอร์", quantity: 1, unitPriceSatang: 250_000 },
      at(2),
    ),
  );
  ok(
    await addJobLine(
      db,
      jobId,
      {
        lineType: "service",
        description: "เติมน้ำยา",
        quantity: 2,
        unitPriceSatang: 60_025,
        discountSatang: 5_000,
      },
      at(2),
    ),
  );
  ok(await moveRepairJob(db, jobId, "estimate", at(3)));
}

async function ready(db: D1Database, jobId: string) {
  await priced(db, jobId);
  ok(await moveRepairJob(db, jobId, "agreed", at(4)));
  ok(await moveRepairJob(db, jobId, "working", at(5)));
  ok(await moveRepairJob(db, jobId, "ready", at(6)));
}

describe("GET /job-page/<code> > the customer's job page", () => {
  it("given the card's link and no sign-in > then the shop, the car, the steps so far, the lines and the total", async () => {
    const { db, jobId, code, open } = await shopWithJob();
    await priced(db, jobId);
    const res = await open(`/job-page/${code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = (await res.json()) as Record<string, unknown>;
    expect(page).toMatchObject({
      shopName: "เด่นแอร์",
      plate: "1กก 1234",
      province: "ขอนแก่น",
      problem: "แอร์ไม่เย็น",
      status: "estimate",
      totalSatang: 250_000 + 2 * 60_025 - 5_000,
      pay: null,
    });
    expect((page.steps as { step: string }[]).map((s) => s.step)).toEqual([
      "in",
      "check",
      "estimate",
    ]);
    expect(page.lines).toEqual([
      { description: "ล้างแอร์", quantity: 1, unitPriceSatang: 250_000, discountSatang: 0 },
      { description: "เติมน้ำยา", quantity: 2, unitPriceSatang: 60_025, discountSatang: 5_000 },
    ]);
  });

  it("given the page > then nothing the customer shouldn't see: no staff, no cost, no job id", async () => {
    const { db, jobId, code, open } = await shopWithJob();
    await priced(db, jobId);
    const text = await (await open(`/job-page/${code}`)).text();
    for (const hidden of ["เก๋", "u-kae", "Cost", "cost", jobId, "userId", "profit"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("given a code no job has > then not found", async () => {
    const { open } = await shopWithJob();
    expect((await open(`/job-page/${"f".repeat(32)}`)).status).toBe(404);
    expect((await open("/job-page/not-a-code")).status).toBe(404);
    // A broken address is "not found", not a server error.
    expect((await open("/job-page/%E0%A4%A")).status).toBe(404);
    expect((await open("/job-page/%E0%A4%A/photos/%E0%A4%A")).status).toBe(404);
  });

  it("given the car ready > then the shop's PromptPay QR for exactly the bill, with the account name", async () => {
    const { raw, db, jobId, code, open } = await shopWithJob();
    await ready(db, jobId);
    const page = (await (await open(`/job-page/${code}`)).json()) as {
      totalSatang: number;
      pay: { amountSatang: number; promptpayPayload: string; accountName: string };
    };
    expect(page.pay.accountName).toBe("นาย เด่น แอร์");
    expect(page.pay.amountSatang).toBe(page.totalSatang);
    // EMVCo tag 54 = the amount: 3,650.50 baht (7 characters).
    expect(page.pay.amountSatang).toBe(365_050);
    expect(page.pay.promptpayPayload).toContain("54073650.50");

    // The QR's amount is the bill staff then mark paid.
    const paid = ok(
      await payRepairJob(db, jobId, { paymentMethod: "promptpay" }, at(7), (l) =>
        priceBillLines(db, l),
      ),
    );
    const bill = raw
      .prepare("SELECT grand_total_satang AS g FROM onsite_sales WHERE id = ?")
      .get(paid.saleId!) as { g: number };
    expect(bill.g).toBe(page.pay.amountSatang);
  });

  it("given the car ready but no PromptPay set up > then no QR (the page says to pay at the shop)", async () => {
    const { db, jobId, code, open } = await shopWithJob(false);
    await ready(db, jobId);
    const page = (await (await open(`/job-page/${code}`)).json()) as { pay: unknown };
    expect(page.pay).toBeNull();
  });

  it("given the job paid > then no QR any more, and when it was paid", async () => {
    const { db, jobId, code, open } = await shopWithJob();
    await ready(db, jobId);
    ok(
      await payRepairJob(db, jobId, { paymentMethod: "cash" }, at(7), (l) => priceBillLines(db, l)),
    );
    const page = (await (await open(`/job-page/${code}`)).json()) as {
      status: string;
      pay: unknown;
      paidAt: number;
    };
    expect(page.status).toBe("paid");
    expect(page.pay).toBeNull();
    expect(page.paidAt).toBe(T0 + 7 * 60_000);
  });

  it("given no part waiting > then no waiting time", async () => {
    const { db, jobId, code, open } = await shopWithJob();
    await priced(db, jobId);
    const page = (await (await open(`/job-page/${code}`)).json()) as { waitUntil: unknown };
    expect(page.waitUntil).toBeNull();
  });
});

describe("GET /job-page/<code>/photos/<id> > the job's photos on its page", () => {
  it("given a photo of this job > then shown; another job's > not found", async () => {
    const { db, bucket, jobId, code, open } = await shopWithJob();
    const photo = ok(
      await addJobPhoto(
        db,
        bucket,
        jobId,
        { bytes: new Uint8Array([7, 8]).buffer, contentType: "image/jpeg" },
        at(1),
      ),
    ).photos[0]!;
    const page = (await (await open(`/job-page/${code}`)).json()) as { photos: { id: string }[] };
    expect(page.photos.map((p) => p.id)).toEqual([photo.id]);
    const res = await open(`/job-page/${code}/photos/${photo.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 8]));

    const other = ok(
      await openRepairJob(db, { licensePlate: "2ขข2222", plateProvince: "ขอนแก่น" }, at(2)),
    );
    expect(other.id).not.toBe(jobId);
    expect((await open(`/job-page/${"f".repeat(32)}/photos/${photo.id}`)).status).toBe(404);
  });
});
