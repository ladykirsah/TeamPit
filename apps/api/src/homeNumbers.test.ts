import { describe, it, expect, vi } from "vitest";
import { bangkokToday, billTotals, moneyMovedOrders, orderTotals } from "@l-shopee/core";
import { moveRepairJob, openRepairJob } from "./repairJobs";
import { asD1, migratedDb } from "./testing/realDb";
import worker, { listFinanceOrders, querySales, type Env } from "./index";
import { createStaffSession } from "./staffSession";
import type { HomeNumbers } from "./homeNumbers";

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
 * Plan 13.5 (owner, 23 Nov 2026): หน้าหลัก's numbers in one quick answer, counted on the server —
 * the alerts (AirPlus orders waiting on someone, เหลือน้อย / หมด, repair jobs by step) and the main
 * numbers the owner asked for ("money in · Den Air repair customers · AirPlus order … pick for me"):
 * money in today and yesterday (only whoever can open การเงิน), cars in today and in the shop now,
 * AirPlus orders placed today.
 */

// 23 Nov 2026 12:00 in Bangkok.
const NOW = Date.UTC(2026, 10, 23, 5, 0);
const TODAY = bangkokToday(NOW);
const YESTERDAY = { from: TODAY.from - 86_400_000, to: TODAY.from };

function shop() {
  const raw = migratedDb();
  const people: [string, string][] = [
    ["u-owner", "super_admin"],
    ["u-admin", "admin"],
    ["u-chang", "mechanic"],
  ];
  for (const [id, role] of people) {
    raw
      .prepare(
        "INSERT INTO users (id, name, email, role, status, created_at) VALUES (?, ?, ?, ?, 'active', 0)",
      )
      .run(id, id, `${id}@shop.test`, role);
  }
  const db = asD1(raw);
  const env = { DB: db } as unknown as Env;
  const ask = async (userId: string | null) => {
    const headers: Record<string, string> = {};
    if (userId) headers["X-Staff-Session"] = (await createStaffSession(db, userId, NOW)).token;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      return await worker.fetch!(
        new Request("https://x/home/numbers", { headers }),
        env,
        {} as ExecutionContext,
      );
    } finally {
      vi.useRealTimers();
    }
  };
  return { raw, db, ask };
}

function bill(
  raw: ReturnType<typeof migratedDb>,
  id: string,
  totalSatang: number,
  at: number,
  status = "completed",
) {
  raw
    .prepare(
      `INSERT INTO onsite_sales (id, client_uuid, sale_number, stage, sale_status, grand_total_satang, created_at)
       VALUES (?, ?, ?, 'bill', ?, ?, ?)`,
    )
    .run(id, `c-${id}`, `B-${id}`, status, totalSatang, at);
}

function order(
  raw: ReturnType<typeof migratedDb>,
  id: string,
  o: {
    channel?: string;
    orderStatus: string;
    paymentStatus: string;
    totalSatang?: number;
    at: number;
  },
) {
  raw
    .prepare(
      `INSERT INTO sales_orders (id, channel, external_order_id, order_status, payment_status,
                                 grand_total_satang, subtotal_satang, order_created_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      o.channel ?? "airplus",
      `AP-${id}`,
      o.orderStatus,
      o.paymentStatus,
      o.totalSatang ?? 100_000,
      o.totalSatang ?? 100_000,
      o.at,
      o.at,
    );
}

/** A product with one size per stock number given, each filled to that number. */
function product(
  raw: ReturnType<typeof migratedDb>,
  id: string,
  stocks: number[],
  status = "active",
) {
  raw
    .prepare("INSERT INTO products (id, name, status, created_at) VALUES (?, ?, ?, 0)")
    .run(id, id, status);
  stocks.forEach((qty, i) => {
    const v = `${id}-v${i}`;
    raw
      .prepare("INSERT INTO product_variants (id, product_id, sku, created_at) VALUES (?, ?, ?, ?)")
      .run(v, id, v, i);
    if (qty !== 0) {
      raw
        .prepare(
          `INSERT INTO stock_ledger_entries
             (id, product_variant_id, movement_type, quantity_delta, quantity_after, source_type, created_at)
           VALUES (?, ?, 'receive', ?, 0, 'manual', 0)`,
        )
        .run(`${v}-in`, v, qty);
    }
  });
}

const numbers = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as HomeNumbers;
};

describe("GET /home/numbers > money in (only whoever can open การเงิน)", () => {
  it("given today's and yesterday's bills and AirPlus orders > then the same sums การเงิน makes", async () => {
    const { raw, db, ask } = shop();
    bill(raw, "t1", 450_000, NOW - 3_600_000);
    bill(raw, "t2", 120_000, NOW - 60_000);
    bill(raw, "t3", 999_900, NOW - 60_000, "refunded");
    bill(raw, "y1", 300_000, TODAY.from - 3_600_000);
    order(raw, "o1", {
      orderStatus: "delivered",
      paymentStatus: "paid",
      totalSatang: 250_000,
      at: NOW - 7_200_000,
    });
    order(raw, "o2", { orderStatus: "shipped", paymentStatus: "paid", at: NOW - 7_200_000 });

    const got = await numbers(await ask("u-owner"));

    const sum = async (r: { from: number; to: number }) => {
      const den = billTotals(await querySales(db, r));
      const air = orderTotals(
        moneyMovedOrders((await listFinanceOrders(db)).orders as never[], r) as never[],
      );
      return {
        salesSatang: den.revenueSatang + air.revenueSatang,
        bills: { den: den.count, air: air.count },
      };
    };
    expect(got.money).toEqual({ today: await sum(TODAY), yesterday: await sum(YESTERDAY) });
    expect(got.money?.today.bills).toEqual({ den: 2, air: 1 });
    expect(got.money?.yesterday).toEqual({ salesSatang: 300_000, bills: { den: 1, air: 0 } });
    expect(got.money!.today.salesSatang).toBeGreaterThan(570_000);
  });

  it("given an admin or a ช่าง > then no money, but every other number", async () => {
    const { raw, ask } = shop();
    bill(raw, "t1", 450_000, NOW - 3_600_000);
    for (const who of ["u-admin", "u-chang"]) {
      const got = await numbers(await ask(who));
      expect(got.money).toBeNull();
      expect(got.stock).toEqual({ low: 0, out: 0 });
    }
  });

  it("given no sign-in > then refused", async () => {
    const { ask } = shop();
    expect((await ask(null)).status).toBe(401);
  });
});

describe("GET /home/numbers > Den Air's repair cars", () => {
  it("given jobs opened today and before > then cars in today, cars in the shop now, and each step's count", async () => {
    const { db, ask } = shop();
    const actor = (at: number) => ({ userId: "u-owner", now: at });
    const a = await openRepairJob(
      db,
      { licensePlate: "1กก1234", plateProvince: "ขอนแก่น" },
      actor(NOW - 60_000),
    );
    await openRepairJob(
      db,
      { licensePlate: "2ขข2222", plateProvince: "ขอนแก่น" },
      actor(NOW - 30_000),
    );
    const old = await openRepairJob(
      db,
      { licensePlate: "3คค3333", plateProvince: "ขอนแก่น" },
      actor(TODAY.from - 86_400_000),
    );
    if (!a.ok || !old.ok) throw new Error("open failed");
    await moveRepairJob(db, a.job.id, "check", actor(NOW - 20_000));
    await moveRepairJob(db, old.job.id, "check", actor(TODAY.from - 80_000_000));

    const got = await numbers(await ask("u-chang"));
    expect(got.repair).toEqual({ inToday: 2, inShop: 3, byStatus: { in: 1, check: 2 } });
  });
});

describe("GET /home/numbers > AirPlus orders", () => {
  it("given orders at each step > then each step's count (as ออเดอร์'s tabs count them), and today's new orders", async () => {
    const { raw, ask } = shop();
    order(raw, "a", { orderStatus: "new", paymentStatus: "verifying", at: NOW - 1_000 });
    order(raw, "b", { orderStatus: "new", paymentStatus: "cod", at: NOW - 2_000 });
    order(raw, "c", { orderStatus: "new", paymentStatus: "paid", at: TODAY.from - 5_000 });
    order(raw, "d", { orderStatus: "new", paymentStatus: "paid", at: NOW - 3_000 });
    order(raw, "e", {
      channel: "shopee",
      orderStatus: "new",
      paymentStatus: "paid",
      at: NOW - 4_000,
    });

    const got = await numbers(await ask("u-admin"));
    expect(got.airplus).toEqual({
      ordersToday: 3,
      byStatus: { verifying: 1, cod_pending: 1, to_ship: 2 },
    });
  });
});

describe("GET /home/numbers > stock (สินค้า's เหลือน้อย and หมด)", () => {
  it("given products at each level > then low and out by the same rule, sizes added together, deleted ones left out", async () => {
    const { raw, ask } = shop();
    product(raw, "empty", [0]);
    product(raw, "two-left", [2]);
    product(raw, "plenty", [10]);
    product(raw, "sizes-low", [1, 2]);
    product(raw, "sizes-fine", [0, 4]);
    product(raw, "paused-low", [1], "paused");
    product(raw, "gone", [0], "archived");

    const got = await numbers(await ask("u-admin"));
    expect(got.stock).toEqual({ low: 3, out: 1 });
  });
});
