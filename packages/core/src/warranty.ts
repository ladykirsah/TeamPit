/**
 * A repair job's warranty (plan 13.6, owner 24 Nov 2026): "repair job can have warranty, but manually
 * decide by super admin car by car > decide > fill to the bill at the create bill stage · and able to
 * select shown on the bill or not". Pick A: how long (days or months) plus a short note on what it
 * covers; the last day is worked out from the day the job is paid. Pure rules; the API enforces them.
 */

export type WarrantyUnit = "day" | "month";

export interface Warranty {
  count: number;
  unit: WarrantyUnit;
  /** What it covers ("คอมเพรสเซอร์ + งานติดตั้ง"); null = nothing written. */
  note: string | null;
  /** แสดงบนบิล: on the bill and the customer's job page; off = staff only. */
  onBill: boolean;
}

/** Ten years either way is the longest a shop would give. */
const MAX_COUNT: Record<WarrantyUnit, number> = { day: 3650, month: 120 };
const MAX_NOTE_CHARS = 200;

export type WarrantyError = "warranty_period" | "warranty_note_too_long" | "warranty_on_bill";

export function readWarranty(
  input: unknown,
): { ok: true; warranty: Warranty } | { ok: false; error: WarrantyError } {
  const w = (input ?? {}) as Record<string, unknown>;
  const unit = w.unit;
  if (unit !== "day" && unit !== "month") return { ok: false, error: "warranty_period" };
  const count = w.count;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_COUNT[unit]
  ) {
    return { ok: false, error: "warranty_period" };
  }
  const note = typeof w.note === "string" && w.note.trim() ? w.note.trim() : null;
  if (note && Array.from(note).length > MAX_NOTE_CHARS) {
    return { ok: false, error: "warranty_note_too_long" };
  }
  if (w.onBill !== undefined && typeof w.onBill !== "boolean") {
    return { ok: false, error: "warranty_on_bill" };
  }
  return { ok: true, warranty: { count, unit, note, onBill: w.onBill ?? true } };
}

const BANGKOK = 7 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The warranty's last day ("YYYY-MM-DD", Thailand's calendar): the day it was paid plus the period.
 * A month that has no such day ends on its last day (31 Jan + 1 month = 28 Feb, 29 in a leap year).
 */
export function warrantyEndsOn(paidAt: number, count: number, unit: WarrantyUnit): string {
  const day = new Date(paidAt + BANGKOK);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const d = day.getUTCDate();
  if (unit === "day") {
    const end = new Date(Date.UTC(y, m, d + count));
    return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;
  }
  const lastDay = new Date(Date.UTC(y, m + count + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(y, m + count, Math.min(d, lastDay)));
  return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;
}
