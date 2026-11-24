import { describe, it, expect, vi } from "vitest";
import { asD1, migratedDb } from "./testing/realDb";
import { updateOrder } from "./index";

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
 * Plan 13.7 (owner pick A, 21 Nov 2026: the tracking number opens the carrier's own page, staff set
 * delivered; 24 Nov: "close the gap, screens later"). ส่งถึงแล้ว is allowed only after the parcel
 * went out, so a wrong tap can't finish an order that was never sent.
 */

const NOW = Date.UTC(2026, 10, 24, 5, 0);

function shopWithOrder(orderStatus: string, paymentStatus = "paid") {
  const raw = migratedDb();
  raw
    .prepare(
      `INSERT INTO sales_orders (id, channel, external_order_id, order_status, payment_status,
                                 grand_total_satang, order_created_at, imported_at)
       VALUES ('o1', 'airplus', 'AP-1', ?, ?, 100000, ?, ?)`,
    )
    .run(orderStatus, paymentStatus, NOW, NOW);
  const statusOf = () =>
    (
      raw.prepare("SELECT order_status AS s FROM sales_orders WHERE id = 'o1'").get() as {
        s: string;
      }
    ).s;
  return { db: asD1(raw), statusOf };
}

describe("updateOrder > ส่งถึงแล้ว only after the parcel went out", () => {
  it("given a parcel on its way > then delivered", async () => {
    const { db, statusOf } = shopWithOrder("shipped");
    expect(await updateOrder(db, "o1", { orderStatus: "delivered" }, "s@x.com", NOW)).toMatchObject(
      { ok: true },
    );
    expect(statusOf()).toBe("delivered");
  });

  it("given an order never sent (new, packing, waiting for payment) > then refused, nothing changes", async () => {
    for (const [order, payment] of [
      ["new", "pending"],
      ["confirmed", "paid"],
      ["packing", "paid"],
      ["new", "cod_confirmed"],
    ]) {
      const { db, statusOf } = shopWithOrder(order!, payment);
      expect(
        await updateOrder(db, "o1", { orderStatus: "delivered" }, "s@x.com", NOW),
      ).toMatchObject({
        ok: false,
        code: 409,
        reason: "only a parcel that went out can be delivered",
      });
      expect(statusOf()).toBe(order);
    }
  });

  it("given the Thai word for delivered (old records) > then the same rule", async () => {
    const { db } = shopWithOrder("packing");
    expect(await updateOrder(db, "o1", { orderStatus: "สำเร็จ" }, "s@x.com", NOW)).toMatchObject({
      ok: false,
      code: 409,
    });
  });

  it("given the drop-off and delivered in one go > then refused (the parcel goes out first)", async () => {
    const { db } = shopWithOrder("packing");
    expect(
      await updateOrder(
        db,
        "o1",
        { orderStatus: "delivered", carrier: "Flash Express", trackingNo: "TH1" },
        "s@x.com",
        NOW,
      ),
    ).toMatchObject({ ok: false, code: 409 });
  });

  it("given an order already delivered > then saying so again changes nothing and is fine", async () => {
    const { db, statusOf } = shopWithOrder("delivered");
    expect(await updateOrder(db, "o1", { orderStatus: "delivered" }, "s@x.com", NOW)).toMatchObject(
      { ok: true },
    );
    expect(statusOf()).toBe("delivered");
  });

  it("given a note change on an unsent order > then not affected by this rule", async () => {
    const { db } = shopWithOrder("packing");
    expect(await updateOrder(db, "o1", { staffNote: "โทรก่อนส่ง" }, "s@x.com", NOW)).toMatchObject({
      ok: true,
    });
  });
});
