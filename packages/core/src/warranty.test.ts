import { describe, it, expect } from "vitest";
import { readWarranty, warrantyEndsOn } from "./warranty";

/**
 * Plan 13.6 (owner, 24 Nov 2026: "repair job can have warranty, but manually decide by super admin
 * car by car > decide > fill to the bill at the create bill stage · and able to select shown on the
 * bill or not"; pick A: a period + a short note, the end date worked out).
 */

// 24 Nov 2026 10:00 in Bangkok.
const PAID = Date.UTC(2026, 10, 24, 3, 0);

describe("readWarranty > what the owner types", () => {
  it("given a period, a note and the switch > then the warranty, the note trimmed", () => {
    expect(
      readWarranty({
        count: 3,
        unit: "month",
        note: "  คอมเพรสเซอร์ + งานติดตั้ง ",
        onBill: false,
      }),
    ).toEqual({
      ok: true,
      warranty: { count: 3, unit: "month", note: "คอมเพรสเซอร์ + งานติดตั้ง", onBill: false },
    });
  });

  it("given no note and no switch > then no note, shown on the bill", () => {
    expect(readWarranty({ count: 7, unit: "day" })).toEqual({
      ok: true,
      warranty: { count: 7, unit: "day", note: null, onBill: true },
    });
  });

  it("given a period that isn't a whole number from 1, or too long > then refused", () => {
    for (const bad of [
      { count: 0, unit: "month" },
      { count: -1, unit: "day" },
      { count: 1.5, unit: "month" },
      { count: "3", unit: "month" },
      { count: 121, unit: "month" },
      { count: 3651, unit: "day" },
      { count: 3, unit: "week" },
      { count: 3 },
    ]) {
      expect(readWarranty(bad)).toEqual({ ok: false, error: "warranty_period" });
    }
  });

  it("given the longest periods > then taken (10 years either way)", () => {
    expect(readWarranty({ count: 120, unit: "month" }).ok).toBe(true);
    expect(readWarranty({ count: 3650, unit: "day" }).ok).toBe(true);
  });

  it("given a note over 200 characters > then refused", () => {
    expect(readWarranty({ count: 1, unit: "month", note: "ก".repeat(201) })).toEqual({
      ok: false,
      error: "warranty_note_too_long",
    });
  });

  it("given a switch that isn't on or off > then refused", () => {
    expect(readWarranty({ count: 1, unit: "month", onBill: "yes" })).toEqual({
      ok: false,
      error: "warranty_on_bill",
    });
  });
});

describe("warrantyEndsOn > the last day, counted from the day it was paid in Thailand", () => {
  it("given 3 months from 24 Nov 2026 > then 24 Feb 2027", () => {
    expect(warrantyEndsOn(PAID, 3, "month")).toBe("2027-02-24");
  });

  it("given 7 days > then a week later", () => {
    expect(warrantyEndsOn(PAID, 7, "day")).toBe("2026-12-01");
  });

  it("given 31 Jan + 1 month > then the month's last day (28 Feb; 29 Feb in a leap year)", () => {
    expect(warrantyEndsOn(Date.UTC(2027, 0, 31, 3, 0), 1, "month")).toBe("2027-02-28");
    expect(warrantyEndsOn(Date.UTC(2028, 0, 31, 3, 0), 1, "month")).toBe("2028-02-29");
  });

  it("given 12 months > then the same day next year", () => {
    expect(warrantyEndsOn(PAID, 12, "month")).toBe("2027-11-24");
  });

  it("given a job paid at 00:30 in Bangkok (still the day before in UTC) > then counted from the Thai day", () => {
    const justAfterMidnight = Date.UTC(2026, 10, 23, 17, 30);
    expect(warrantyEndsOn(justAfterMidnight, 1, "day")).toBe("2026-11-25");
  });
});
