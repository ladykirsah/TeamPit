import { describe, it, expect } from "vitest";
import {
  approveData,
  jobCardMessage,
  jobTotalSatang,
  lineLinkText,
  lineLinkUrl,
  readApproveData,
  readLinkCode,
  type JobCardInput,
} from "./jobCard";

/**
 * Plan 13.2 (owner, 21 + 23 Nov 2026): LINE job cards from Den Air's own OA. The customer links
 * their LINE to their car once (QR on the bill, pick A); a card goes out at each of the owner's six
 * steps (pick A); the price card has อนุมัติราคา (pick A); the ready card leads to the payment QR.
 * The look is drawn with Stage 12 — these rules hold whatever it looks like.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";

const card = (over: Partial<JobCardInput> = {}): JobCardInput => ({
  step: "in",
  shopName: "เด่นแอร์",
  jobNumber: "J691123-001",
  plate: "1กก1234",
  province: "ขอนแก่น",
  totalSatang: 0,
  waitUntil: null,
  pageUrl: `https://teampit.formulal.cc/j/${TOKEN}`,
  token: TOKEN,
  ...over,
});

const flat = (v: unknown) => JSON.stringify(v);

/** Every action a card offers, wherever it sits in the card. */
function actionsOf(
  message: unknown,
): { type: string; label?: string; uri?: string; data?: string }[] {
  const out: { type: string; label?: string; uri?: string; data?: string }[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.action && typeof o.action === "object") out.push(o.action as never);
      Object.values(o).forEach(walk);
    }
  };
  walk(message);
  return out;
}

describe("jobTotalSatang > what the customer is asked to pay", () => {
  it("given lines > then price × quantity less each discount, removed lines left out", () => {
    expect(
      jobTotalSatang([
        { state: "taken", quantity: 2, unitPriceSatang: 150_000, discountSatang: 10_000 },
        { state: "taken", quantity: 1, unitPriceSatang: 80_000, discountSatang: 0 },
        { state: "removed", quantity: 1, unitPriceSatang: 999_900, discountSatang: 0 },
      ]),
    ).toBe(370_000);
  });

  it("given an estimate still being priced > then its estimate and waiting lines count too", () => {
    expect(
      jobTotalSatang([
        { state: "estimate", quantity: 1, unitPriceSatang: 120_000, discountSatang: null },
        { state: "waiting", quantity: 1, unitPriceSatang: 50_000, discountSatang: null },
      ]),
    ).toBe(170_000);
  });

  it("given no lines > then nothing to pay", () => {
    expect(jobTotalSatang([])).toBe(0);
  });
});

describe("lineLinkUrl > the QR on the bill (owner's pick A)", () => {
  it("given the OA and the job > then LINE opens a chat with Den Air's OA holding the ready message", () => {
    const url = lineLinkUrl("@denair", "J691123-001", TOKEN);
    expect(url.startsWith("https://line.me/R/oaMessage/%40denair/?")).toBe(true);
    const text = decodeURIComponent(url.split("/?")[1]!);
    expect(text).toBe(lineLinkText("J691123-001", TOKEN));
    expect(text).toContain("J691123-001");
  });

  it("given the message the customer sends > then the job's code is read back from it", () => {
    expect(readLinkCode(lineLinkText("J691123-001", TOKEN))).toBe(TOKEN);
  });

  it("given capitals or extra words around it > then the code is still read", () => {
    expect(readLinkCode(`สวัสดีครับ ${TOKEN.toUpperCase()} ขอบคุณ`)).toBe(TOKEN);
  });

  it("given an ordinary chat message > then there is no code", () => {
    for (const text of ["สวัสดีครับ", "รถเสร็จยังครับ", "0123456789abcdef", ""]) {
      expect(readLinkCode(text)).toBeNull();
    }
  });
});

describe("approveData > the อนุมัติราคา button carries the price it approves", () => {
  it("given a job and its price > then the same job and price are read back", () => {
    expect(readApproveData(approveData(TOKEN, 370_000))).toEqual({
      token: TOKEN,
      totalSatang: 370_000,
    });
  });

  it("given anything else > then nothing is read", () => {
    for (const data of [
      "",
      "approve=abc&total=1",
      `approve=${TOKEN}`,
      `approve=${TOKEN}&total=-5`,
      `x=${TOKEN}&total=5`,
    ]) {
      expect(readApproveData(data)).toBeNull();
    }
  });

  it("given LINE's limit > then the data stays under 300 characters", () => {
    expect(approveData(TOKEN, 99_999_999_99).length).toBeLessThanOrEqual(300);
  });
});

describe("jobCardMessage > one card per step", () => {
  it("given any step > then the card names the shop, the car and the step, and opens the job page", () => {
    for (const step of ["in", "check", "estimate", "waiting_parts", "ready", "paid"] as const) {
      const msg = jobCardMessage(card({ step, totalSatang: 370_000 }));
      expect(msg.type).toBe("flex");
      expect(msg.altText.length).toBeLessThanOrEqual(400);
      expect(msg.altText).toContain("1กก1234 ขอนแก่น");
      expect(flat(msg.contents)).toContain("เด่นแอร์");
      expect(actionsOf(msg).some((a) => a.type === "uri" && a.uri === card().pageUrl)).toBe(true);
    }
  });

  it("given the price step > then it shows the price and offers อนุมัติราคา for that price", () => {
    const msg = jobCardMessage(card({ step: "estimate", totalSatang: 370_000 }));
    expect(msg.altText).toContain("฿3,700");
    const approve = actionsOf(msg).find((a) => a.type === "postback");
    expect(approve?.label).toBe("อนุมัติราคา");
    expect(readApproveData(approve!.data!)).toEqual({ token: TOKEN, totalSatang: 370_000 });
  });

  it("given any other step > then there is nothing to approve", () => {
    for (const step of ["in", "check", "waiting_parts", "ready", "paid"] as const) {
      expect(actionsOf(jobCardMessage(card({ step }))).some((a) => a.type === "postback")).toBe(
        false,
      );
    }
  });

  it("given waiting for parts with a time > then the date and the clock time in Thailand", () => {
    // 24 Nov 2026 07:00 UTC = 14:00 in Bangkok.
    const msg = jobCardMessage(
      card({ step: "waiting_parts", waitUntil: Date.UTC(2026, 10, 24, 7, 0) }),
    );
    expect(flat(msg)).toContain("24 พ.ย.");
    expect(flat(msg)).toContain("14:00");
  });

  it("given waiting for parts with no time yet > then the card says the shop will tell them", () => {
    const msg = jobCardMessage(card({ step: "waiting_parts", waitUntil: null }));
    expect(flat(msg)).toContain("ร้านจะแจ้งเวลาอีกครั้ง");
  });

  it("given the car is ready > then it shows the amount and leads to paying", () => {
    const msg = jobCardMessage(card({ step: "ready", totalSatang: 370_050 }));
    expect(msg.altText).toContain("฿3,700.50");
    expect(actionsOf(msg).find((a) => a.type === "uri")?.label).toBe("ชำระเงิน");
  });

  it("given a car with no province > then only the plate", () => {
    expect(jobCardMessage(card({ province: "" })).altText).toContain("1กก1234");
    expect(jobCardMessage(card({ province: "" })).altText).not.toContain("1กก1234 ");
  });
});
