/**
 * หน้าหลัก's numbers in one quick answer (plan 13.5, owner 23 Nov 2026) — `GET /home/numbers`.
 *
 *  · Alerts: AirPlus orders by step (ออเดอร์'s tabs group them), products เหลือน้อย / หมด (สินค้า's
 *    rule), open repair jobs by step.
 *  · Main numbers (owner: "money in · Den Air repair customers · AirPlus order … pick for me"):
 *    money in today and yesterday — Den Air's bills + AirPlus orders, the same sums as การเงิน and
 *    หน้าหลัก's วันนี้ card, only for whoever can open การเงิน; repair cars in today and in the shop
 *    now; AirPlus orders placed today.
 *
 * Counted with GROUP BY on the server, so the app no longer loads every order to count them. The
 * rules are @l-shopee/core's (homeNumbers.ts), the same ones the app pages use.
 */
import {
  bangkokToday,
  billTotals,
  moneyMovedOrders,
  operationalStatus,
  orderTotals,
  stockLevel,
  type DayRange,
  type JobStatus,
  type MoneyOrderLike,
  type OperationalStatus,
} from "@l-shopee/core";

interface DayMoney {
  salesSatang: number;
  bills: { den: number; air: number };
}

export interface HomeNumbers {
  day: DayRange;
  /** null for anyone who can't open การเงิน. */
  money: { today: DayMoney; yesterday: DayMoney } | null;
  repair: { inToday: number; inShop: number; byStatus: Partial<Record<JobStatus, number>> };
  airplus: { ordersToday: number; byStatus: Partial<Record<OperationalStatus, number>> };
  stock: { low: number; out: number };
}

/** Where the money sums come from: the same reads การเงิน uses (index.ts querySales, listFinanceOrders). */
export interface MoneyReads {
  bills(
    range: DayRange,
  ): Promise<
    readonly { saleStatus: string; grandTotalSatang: number; grossProfitSatang: number }[]
  >;
  orders(): Promise<
    readonly (MoneyOrderLike & {
      salesSatang?: number | null;
      profitSatang?: number | null;
      refunded?: boolean;
    })[]
  >;
}

const DAY = 24 * 60 * 60 * 1000;

async function moneyFor(reads: MoneyReads, today: DayRange) {
  const yesterday = { from: today.from - DAY, to: today.from };
  const orders = await reads.orders();
  const day = async (r: DayRange): Promise<DayMoney> => {
    const den = billTotals(await reads.bills(r));
    const air = orderTotals(moneyMovedOrders(orders, r));
    return {
      salesSatang: den.revenueSatang + air.revenueSatang,
      bills: { den: den.count, air: air.count },
    };
  };
  return { today: await day(today), yesterday: await day(yesterday) };
}

async function repairFor(db: D1Database, today: DayRange): Promise<HomeNumbers["repair"]> {
  const [open, inToday] = await Promise.all([
    db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM repair_jobs
         WHERE status NOT IN ('paid', 'cancelled') GROUP BY status`,
      )
      .all<{ status: JobStatus; n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM repair_jobs WHERE created_at >= ? AND created_at < ?")
      .bind(today.from, today.to)
      .first<{ n: number }>(),
  ]);
  const byStatus: Partial<Record<JobStatus, number>> = {};
  let inShop = 0;
  for (const r of open.results ?? []) {
    byStatus[r.status] = Number(r.n);
    inShop += Number(r.n);
  }
  return { inToday: Number(inToday?.n ?? 0), inShop, byStatus };
}

async function airplusFor(db: D1Database, today: DayRange): Promise<HomeNumbers["airplus"]> {
  const [steps, placed] = await Promise.all([
    db
      .prepare(
        `SELECT order_status AS o, payment_status AS p, COUNT(*) AS n FROM sales_orders
         WHERE channel = 'airplus' GROUP BY order_status, payment_status`,
      )
      .all<{ o: string | null; p: string | null; n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM sales_orders
         WHERE channel = 'airplus' AND COALESCE(order_created_at, imported_at) >= ?
           AND COALESCE(order_created_at, imported_at) < ?`,
      )
      .bind(today.from, today.to)
      .first<{ n: number }>(),
  ]);
  const byStatus: Partial<Record<OperationalStatus, number>> = {};
  for (const r of steps.results ?? []) {
    const s = operationalStatus(r.o, r.p);
    if (s) byStatus[s] = (byStatus[s] ?? 0) + Number(r.n);
  }
  return { ordersToday: Number(placed?.n ?? 0), byStatus };
}

/** สินค้า's เหลือน้อย / หมด: each product's ขายได้ is all its sizes together; deleted ones left out. */
async function stockFor(db: D1Database): Promise<HomeNumbers["stock"]> {
  const rows = await db
    .prepare(
      `SELECT COALESCE(SUM(e.quantity_delta), 0) AS forSale
       FROM products p
       LEFT JOIN product_variants v ON v.product_id = p.id
       LEFT JOIN stock_ledger_entries e ON e.product_variant_id = v.id
       WHERE p.status <> 'archived'
       GROUP BY p.id`,
    )
    .all<{ forSale: number }>();
  const stock = { low: 0, out: 0 };
  for (const r of rows.results ?? []) {
    const level = stockLevel(Number(r.forSale));
    if (level !== "ok") stock[level] += 1;
  }
  return stock;
}

export async function homeNumbersFor(
  db: D1Database,
  now: number,
  money: MoneyReads | null,
): Promise<HomeNumbers> {
  const day = bangkokToday(now);
  const [moneyNumbers, repair, airplus, stock] = await Promise.all([
    money ? moneyFor(money, day) : Promise.resolve(null),
    repairFor(db, day),
    airplusFor(db, day),
    stockFor(db),
  ]);
  return { day, money: moneyNumbers, repair, airplus, stock };
}
