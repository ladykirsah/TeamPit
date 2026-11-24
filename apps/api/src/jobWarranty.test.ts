import { describe, it, expect, vi } from "vitest";
import {
  addJobLine,
  moveRepairJob,
  openRepairJob,
  type JobResult,
  type RepairJobDetail,
} from "./repairJobs";
import { asD1, memoryBucket, memoryKv, migratedDb } from "./testing/realDb";
import worker, { StockLedger, type Env } from "./index";
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
 * Plan 13.6 (owner, 24 Nov 2026): "repair job can have warranty, but manually decide by super admin
 * car by car > decide > fill to the bill at the create bill stage · and able to select shown on the
 * bill or not" — pick A, a period + a note. Set by the owner alone while the job is at พร้อมรับรถ;
 * it starts the day the job is paid and is locked from then. Shown on the bill and the customer's
 * job page only when แสดงบนบิล is on; staff always see it.
 */

const T0 = Date.UTC(2026, 10, 24, 3, 0);
const at = (minutes: number) => ({ userId: "u-owner", now: T0 + minutes * 60_000 });

function ok(r: JobResult): RepairJobDetail {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.job;
}

async function shopWithReadyJob() {
  const raw = migratedDb();
  for (const [id, role] of [
    ["u-owner", "super_admin"],
    ["u-admin", "admin"],
    ["u-chang", "mechanic"],
  ] as [string, string][]) {
    raw
      .prepare(
        "INSERT INTO users (id, name, email, role, status, created_at) VALUES (?, ?, ?, ?, 'active', 0)",
      )
      .run(id, id, `${id}@shop.test`, role);
  }
  const db = asD1(raw);
  const { kv } = memoryKv({ "shop:denair:name": "เด่นแอร์" });
  const { bucket } = memoryBucket();
  const env = { DB: db, KV: kv, IMAGES: bucket } as unknown as Env;
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

  const job = ok(
    await openRepairJob(db, { licensePlate: "1กก1234", plateProvince: "ขอนแก่น" }, at(0)),
  );
  ok(await moveRepairJob(db, job.id, "check", at(1)));
  ok(
    await addJobLine(
      db,
      job.id,
      {
        lineType: "service",
        description: "เปลี่ยนคอมเพรสเซอร์",
        quantity: 1,
        unitPriceSatang: 850_000,
      },
      at(2),
    ),
  );
  ok(await moveRepairJob(db, job.id, "estimate", at(3)));
  ok(await moveRepairJob(db, job.id, "agreed", at(4)));
  ok(await moveRepairJob(db, job.id, "working", at(5)));
  ok(await moveRepairJob(db, job.id, "ready", at(6)));
  const code = (
    raw.prepare("SELECT customer_token AS t FROM repair_jobs WHERE id = ?").get(job.id) as {
      t: string;
    }
  ).t;

  const send = async (
    userId: string | null,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (userId)
      headers["X-Staff-Session"] = (await createStaffSession(db, userId, Date.now())).token;
    return worker.fetch!(
      new Request(`https://x${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
  };
  const setWarranty = (userId: string, body: unknown) =>
    send(userId, `/repair-jobs/${job.id}/warranty`, { method: "PUT", body });
  const pay = () =>
    send("u-owner", `/repair-jobs/${job.id}/pay`, {
      method: "POST",
      body: { paymentMethod: "cash" },
    });
  const jobOf = async (res: Response) => ((await res.json()) as { job: RepairJobDetail }).job;
  return { raw, db, env, jobId: job.id, code, send, setWarranty, pay, jobOf };
}

const THREE_MONTHS = { count: 3, unit: "month", note: "คอมเพรสเซอร์ + งานติดตั้ง", onBill: true };

describe("PUT /repair-jobs/:id/warranty > the owner sets a job's warranty at พร้อมรับรถ", () => {
  it("given the owner > then the job carries it and its history says who", async () => {
    const { setWarranty, jobOf } = await shopWithReadyJob();
    const res = await setWarranty("u-owner", THREE_MONTHS);
    expect(res.status).toBe(200);
    const job = await jobOf(res);
    expect(job.warranty).toEqual({
      count: 3,
      unit: "month",
      note: "คอมเพรสเซอร์ + งานติดตั้ง",
      onBill: true,
      endsOn: null,
    });
    expect(job.events.at(-1)).toMatchObject({ kind: "warranty_set", userId: "u-owner" });
  });

  it("given an admin or a ช่าง > then refused, and nothing is set", async () => {
    const { setWarranty, send, jobId } = await shopWithReadyJob();
    for (const who of ["u-admin", "u-chang"]) {
      const res = await setWarranty(who, THREE_MONTHS);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: "super_admin_only" });
    }
    const job = (await (await send("u-owner", `/repair-jobs/${jobId}`)).json()) as {
      job?: RepairJobDetail;
    } & RepairJobDetail;
    expect((job.job ?? job).warranty).toBeNull();
  });

  it("given a period that makes no sense > then refused with the reason", async () => {
    const { setWarranty } = await shopWithReadyJob();
    const res = await setWarranty("u-owner", { count: 0, unit: "month" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "warranty_period" });
  });

  it("given the job sent back to กำลังซ่อม > then not yet (the bill isn't made)", async () => {
    const { db, jobId, setWarranty } = await shopWithReadyJob();
    ok(await moveRepairJob(db, jobId, "working", at(7)));
    const res = await setWarranty("u-owner", THREE_MONTHS);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_ready" });
  });

  it("given the owner changes it before payment > then the last one counts; DELETE takes it off", async () => {
    const { setWarranty, send, jobId, jobOf } = await shopWithReadyJob();
    await setWarranty("u-owner", THREE_MONTHS);
    const changed = await jobOf(
      await setWarranty("u-owner", { count: 7, unit: "day", onBill: false }),
    );
    expect(changed.warranty).toMatchObject({ count: 7, unit: "day", note: null, onBill: false });
    const removed = await send("u-owner", `/repair-jobs/${jobId}/warranty`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    const job = await jobOf(removed);
    expect(job.warranty).toBeNull();
    expect(job.events.at(-1)).toMatchObject({ kind: "warranty_removed" });
  });
});

describe("after payment > the warranty starts and is locked", () => {
  it("given the job paid > then its last day is counted from the pay day, and it can't change", async () => {
    const { setWarranty, pay, jobOf, send, jobId } = await shopWithReadyJob();
    await setWarranty("u-owner", THREE_MONTHS);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 24, 5, 0));
    let paid: RepairJobDetail;
    try {
      paid = await jobOf(await pay());
    } finally {
      vi.useRealTimers();
    }
    expect(paid.status).toBe("paid");
    expect(paid.warranty).toMatchObject({ count: 3, unit: "month", endsOn: "2027-02-24" });

    const late = await setWarranty("u-owner", { count: 12, unit: "month" });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ ok: false, error: "closed" });
    const off = await send("u-owner", `/repair-jobs/${jobId}/warranty`, { method: "DELETE" });
    expect(off.status).toBe(409);
  });
});

describe("where it shows > the bill and the customer's job page, only when แสดงบนบิล is on", () => {
  async function paidWith(onBill: boolean) {
    const s = await shopWithReadyJob();
    await s.setWarranty("u-owner", { ...THREE_MONTHS, onBill });
    const paid = await s.jobOf(await s.pay());
    const bill = (await (await s.send("u-owner", `/onsite/sales/${paid.saleId}`)).json()) as {
      warranty?: unknown;
      sale?: { warranty?: unknown };
    };
    const page = (await (await s.send(null, `/job-page/${s.code}`)).json()) as {
      warranty: unknown;
    };
    return { bill: bill.sale ?? bill, page, paid };
  }

  it("given it on > then the bill and the job page show the period, the note and the last day", async () => {
    const { bill, page, paid } = await paidWith(true);
    const shown = {
      count: 3,
      unit: "month",
      note: "คอมเพรสเซอร์ + งานติดตั้ง",
      endsOn: paid.warranty!.endsOn,
    };
    expect(bill.warranty).toEqual(shown);
    expect(page.warranty).toEqual(shown);
  });

  it("given it off > then neither shows it; staff still see it on the job", async () => {
    const { bill, page, paid } = await paidWith(false);
    expect(bill.warranty).toBeNull();
    expect(page.warranty).toBeNull();
    expect(paid.warranty).toMatchObject({ onBill: false, count: 3 });
  });

  it("given a counter bill (no job) > then no warranty", async () => {
    const { raw, send } = await shopWithReadyJob();
    raw
      .prepare(
        `INSERT INTO onsite_sales (id, client_uuid, sale_number, stage, grand_total_satang, created_at)
         VALUES ('s1', 'c1', 'B-1', 'bill', 100, 0)`,
      )
      .run();
    const bill = (await (await send("u-owner", "/onsite/sales/s1")).json()) as {
      warranty?: unknown;
      sale?: { warranty?: unknown };
    };
    expect((bill.sale ?? bill).warranty).toBeNull();
  });
});
