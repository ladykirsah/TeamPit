/**
 * หน้าหลัก's numbers (plan 13.5, owner 23 Nov 2026: "show main number too · money in · Den Air
 * repair customers · AirPlus order … pick for me"). Pure rules, shared by the server that adds them
 * up and the app pages that showed them first (การเงิน, สินค้า) — one rule, so the two never
 * disagree. Moved here from apps/mobile/src/lib/{financePage,productList,orderList}.ts.
 */
import { bangkokDayStart } from "./insights";
import { operationalStatus, type OperationalStatus } from "./operationalStatus";

/** [from, to) in ms. */
export interface DayRange {
  from: number;
  to: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** Today in Thailand, whatever clock the server runs on (a phone in Thailand already counts this way). */
export function bangkokToday(now: number): DayRange {
  const from = bangkokDayStart(now);
  return { from, to: from + DAY };
}

// ── Stock ───────────────────────────────────────────────────────────────────────────────────

/** The shop's one low-stock line (the old web back office used the same 3). */
export const LOW_STOCK = 3;

export type StockLevel = "ok" | "low" | "out";

/** สินค้า's เหลือน้อย and หมด tabs, and หน้าหลัก's alert. */
export function stockLevel(forSale: number): StockLevel {
  if (forSale <= 0) return "out";
  return forSale <= LOW_STOCK ? "low" : "ok";
}

// ── Money ───────────────────────────────────────────────────────────────────────────────────

/** A refunded bill is not income; only completed bills count (the old page's summarize). */
export function billTotals(
  bills: readonly { saleStatus: string; grandTotalSatang: number; grossProfitSatang: number }[],
) {
  const done = bills.filter((b) => b.saleStatus === "completed");
  return {
    count: done.length,
    revenueSatang: done.reduce((n, b) => n + b.grandTotalSatang, 0),
    profitSatang: done.reduce((n, b) => n + b.grossProfitSatang, 0),
  };
}

/** When the order was placed; an imported order without one is placed by its import. */
export function orderPlacedAt(o: { orderCreatedAt: number | null; importedAt: number }): number {
  return o.orderCreatedAt ?? o.importedAt;
}

/** The AirPlus steps where money moved: delivered, and what can follow a delivery. */
const MONEY_MOVED: ReadonlySet<OperationalStatus> = new Set([
  "complete",
  "refunded",
  "claimed",
  "claim_rejected",
]);

export interface MoneyOrderLike {
  channel: string;
  orderStatus: string | null;
  paymentStatus: string | null;
  orderCreatedAt: number | null;
  importedAt: number;
}

/** AirPlus orders that moved money, placed in [from, to). */
export function moneyMovedOrders<T extends MoneyOrderLike>(orders: readonly T[], r: DayRange): T[] {
  return orders.filter((o) => {
    const s = operationalStatus(o.orderStatus, o.paymentStatus);
    const at = orderPlacedAt(o);
    return o.channel === "airplus" && s != null && MONEY_MOVED.has(s) && at >= r.from && at < r.to;
  });
}

/** A refunded order is no sale (as a refunded bill is no income); its profit is the shipping lost. */
export function orderTotals(
  orders: readonly {
    salesSatang?: number | null;
    profitSatang?: number | null;
    refunded?: boolean;
  }[],
) {
  return {
    count: orders.length,
    revenueSatang: orders.reduce((n, o) => n + (o.refunded ? 0 : (o.salesSatang ?? 0)), 0),
    profitSatang: orders.reduce((n, o) => n + (o.profitSatang ?? 0), 0),
  };
}
