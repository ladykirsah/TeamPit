import { describe, it, expect } from "vitest";
import {
  bangkokToday,
  billTotals,
  moneyMovedOrders,
  orderPlacedAt,
  orderTotals,
  stockLevel,
} from "./homeNumbers";

/**
 * Plan 13.5 (owner, 23 Nov 2026: "show main number too · money in · Den Air repair customers ·
 * AirPlus order … pick for me"): หน้าหลัก's numbers, added up on the server by the SAME rules the
 * app's วันนี้ card and การเงิน use — so moving them here can never make the two disagree.
 */

const H = 60 * 60 * 1000;

describe("bangkokToday > today is Thailand's day, whatever the server's clock", () => {
  it("given 23 Nov 2026 01:30 in Bangkok (22 Nov 18:30 UTC) > then 23 Nov 00:00 to 24 Nov 00:00 Bangkok", () => {
    const now = Date.UTC(2026, 10, 22, 18, 30);
    expect(bangkokToday(now)).toEqual({
      from: Date.UTC(2026, 10, 22, 17, 0),
      to: Date.UTC(2026, 10, 23, 17, 0),
    });
  });

  it("given the last minute of a Bangkok day > then still that day", () => {
    const now = Date.UTC(2026, 10, 23, 16, 59);
    expect(bangkokToday(now).from).toBe(Date.UTC(2026, 10, 22, 17, 0));
  });
});

describe("stockLevel > the shop's one low-stock line (สินค้า's เหลือน้อย / หมด)", () => {
  it("given 0 or less > หมด; 1 to 3 > เหลือน้อย; 4 and up > fine", () => {
    expect([-2, 0, 1, 3, 4].map(stockLevel)).toEqual(["out", "out", "low", "low", "ok"]);
  });
});

describe("billTotals > a refunded bill is no income; only completed bills count", () => {
  it("given completed, refunded and draft bills > then the completed ones", () => {
    expect(
      billTotals([
        { saleStatus: "completed", grandTotalSatang: 100_00, grossProfitSatang: 30_00 },
        { saleStatus: "refunded", grandTotalSatang: 999_00, grossProfitSatang: 9_00 },
        { saleStatus: "completed", grandTotalSatang: 50_00, grossProfitSatang: 10_00 },
        { saleStatus: "draft", grandTotalSatang: 70_00, grossProfitSatang: 7_00 },
      ]),
    ).toEqual({ count: 2, revenueSatang: 150_00, profitSatang: 40_00 });
  });
});

describe("moneyMovedOrders + orderTotals > AirPlus orders that moved money, by the day they were placed", () => {
  const order = (over: Record<string, unknown>) => ({
    channel: "airplus",
    orderStatus: "delivered",
    paymentStatus: "paid",
    orderCreatedAt: Date.UTC(2026, 10, 23, 3, 0),
    importedAt: Date.UTC(2026, 10, 23, 3, 0),
    salesSatang: 1_000_00,
    profitSatang: 200_00,
    refunded: false,
    ...over,
  });
  const day = bangkokToday(Date.UTC(2026, 10, 23, 5, 0));

  it("given a delivered order placed today > then counted", () => {
    const got = moneyMovedOrders([order({})], day);
    expect(orderTotals(got)).toEqual({ count: 1, revenueSatang: 1_000_00, profitSatang: 200_00 });
  });

  it("given an order still on its way, a Shopee order, or one placed yesterday > then not today's money", () => {
    expect(
      moneyMovedOrders(
        [
          order({ orderStatus: "shipped" }),
          order({ channel: "shopee" }),
          order({ orderCreatedAt: Date.UTC(2026, 10, 22, 3, 0) }),
        ],
        day,
      ),
    ).toEqual([]);
  });

  it("given a refunded order > then counted as an order, but no sale (its profit is the shipping lost)", () => {
    const got = moneyMovedOrders(
      [
        order({
          orderStatus: "claimed",
          paymentStatus: "refunded",
          refunded: true,
          profitSatang: -60_00,
        }),
      ],
      day,
    );
    expect(orderTotals(got)).toEqual({ count: 1, revenueSatang: 0, profitSatang: -60_00 });
  });

  it("given an imported order with no placed time > then placed by its import", () => {
    expect(orderPlacedAt({ orderCreatedAt: null, importedAt: 5 })).toBe(5);
    expect(orderPlacedAt({ orderCreatedAt: 3, importedAt: 5 })).toBe(3);
  });

  it("given the hour before today began > then yesterday", () => {
    const got = moneyMovedOrders([order({ orderCreatedAt: day.from - H })], day);
    expect(got).toEqual([]);
  });
});
