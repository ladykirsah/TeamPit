/**
 * The customer's LINE job cards (plan 13.2, owner 21 + 23 Nov 2026). Pure: the API sends them.
 *
 *  · The customer links their LINE to their car once (pick A): the QR on the job slip or bill opens
 *    a chat with the shop's own LINE OA holding a ready message with the job's code; they tap send.
 *  · A card goes to every LINE linked to the car at each of the owner's six steps (pick A).
 *  · The price card carries อนุมัติราคา for the price it shows (pick A). The ready card leads to the
 *    job page, which shows the payment QR; staff mark the job paid once the slip comes (owner: "inform
 *    as ready to pickup and record or mark with slip as paid is enough").
 *
 * The look is drawn with Stage 12; this is a plain card that carries the right facts.
 */
import type { JobCustomerUpdate, JobLineState } from "./repairJob";

export type JobCardStep = JobCustomerUpdate;

export interface JobCardInput {
  step: JobCardStep;
  /** The shop's name as the customer knows it (ข้อมูลร้าน). */
  shopName: string;
  jobNumber: string;
  plate: string;
  /** The plate's province; '' = none. */
  province: string;
  /** What the job comes to now (see jobTotalSatang). */
  totalSatang: number;
  /** รออะไหล่: when the last waiting part is due; null = not known yet. */
  waitUntil: number | null;
  /** The job page this card opens. */
  pageUrl: string;
  /** The job's private code — what อนุมัติราคา names. */
  token: string;
}

export interface LineFlexMessage {
  type: "flex";
  altText: string;
  contents: Record<string, unknown>;
}

/**
 * What the job comes to: price × quantity less each line's discount, removed lines left out — the
 * same sum the bill is written with when the job is paid.
 */
export function jobTotalSatang(
  lines: readonly {
    state: JobLineState;
    quantity: number;
    unitPriceSatang: number;
    discountSatang: number | null;
  }[],
): number {
  return lines
    .filter((l) => l.state !== "removed")
    .reduce((sum, l) => sum + l.unitPriceSatang * l.quantity - (l.discountSatang ?? 0), 0);
}

// ── Linking a LINE to a car ──────────────────────────────────────────────────────────────────

const CODE = /(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i;

/** The message the QR puts in the customer's chat box; they only tap send. */
export function lineLinkText(jobNumber: string, token: string): string {
  return `แจ้งสถานะงานซ่อม ${jobNumber} ทาง LINE (รหัส ${token})`;
}

/** The QR's address: LINE opens a chat with the shop's OA, the message already typed. */
export function lineLinkUrl(oaId: string, jobNumber: string, token: string): string {
  return `https://line.me/R/oaMessage/${encodeURIComponent(oaId)}/?${encodeURIComponent(
    lineLinkText(jobNumber, token),
  )}`;
}

/** The job code in a chat message, or null for an ordinary message. */
export function readLinkCode(text: string): string | null {
  const m = CODE.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

// ── อนุมัติราคา ──────────────────────────────────────────────────────────────────────────────

/** The button's data: the job and the exact price on the card, so a changed price is never approved. */
export function approveData(token: string, totalSatang: number): string {
  return `approve=${token}&total=${totalSatang}`;
}

export function readApproveData(data: string): { token: string; totalSatang: number } | null {
  const m = /^approve=([0-9a-f]{32})&total=(\d{1,13})$/.exec(data);
  if (!m) return null;
  return { token: m[1]!, totalSatang: Number(m[2]) };
}

// ── The card ─────────────────────────────────────────────────────────────────────────────────

const STEP_TITLE: Record<JobCardStep, string> = {
  in: "รับรถเข้าซ่อมแล้ว",
  check: "กำลังตรวจเช็ครถ",
  estimate: "แจ้งราคาซ่อม รออนุมัติ",
  waiting_parts: "รออะไหล่",
  ready: "รถพร้อมรับแล้ว",
  paid: "ชำระเงินแล้ว ขอบคุณที่ใช้บริการ",
};

/** ฿ with thousands; no .00 on whole baht. */
export function formatBaht(satang: number): string {
  const whole = satang % 100 === 0;
  return `฿${(satang / 100).toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** รออะไหล่ carries the date AND the clock time (the one exception to the no-clock-time rule). */
function bangkokTime(ms: number): string {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}

/** The one line under the title, when the step has one. */
function detailFor(card: JobCardInput): string | null {
  switch (card.step) {
    case "estimate":
      return `ราคาซ่อม ${formatBaht(card.totalSatang)}`;
    case "waiting_parts":
      return card.waitUntil == null
        ? "ร้านจะแจ้งเวลาอีกครั้ง"
        : `อะไหล่มาถึงประมาณ ${bangkokTime(card.waitUntil)}`;
    case "ready":
      return `ยอดชำระ ${formatBaht(card.totalSatang)}`;
    case "paid":
      return `ยอด ${formatBaht(card.totalSatang)}`;
    default:
      return null;
  }
}

const text = (t: string, more: Record<string, unknown> = {}) => ({
  type: "text",
  text: t,
  wrap: true,
  ...more,
});

const button = (action: Record<string, unknown>, primary: boolean) => ({
  type: "button",
  style: primary ? "primary" : "secondary",
  height: "sm",
  action,
});

export function jobCardMessage(card: JobCardInput): LineFlexMessage {
  const car = card.province ? `${card.plate} ${card.province}` : card.plate;
  const title = STEP_TITLE[card.step];
  const detail = detailFor(card);
  const pageLabel =
    card.step === "ready" ? "ชำระเงิน" : card.step === "paid" ? "ดูบิล" : "ดูรายละเอียด";
  const buttons = [
    ...(card.step === "estimate"
      ? [
          button(
            {
              type: "postback",
              label: "อนุมัติราคา",
              data: approveData(card.token, card.totalSatang),
              displayText: "อนุมัติราคา",
            },
            true,
          ),
        ]
      : []),
    button({ type: "uri", label: pageLabel, uri: card.pageUrl }, card.step !== "estimate"),
  ];
  return {
    type: "flex",
    altText: [card.shopName, title, car, detail].filter(Boolean).join(" · ").slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          text(card.shopName, { size: "xs", color: "#888888" }),
          text(title, { size: "lg", weight: "bold" }),
          text(car, { size: "sm" }),
          text(`งาน ${card.jobNumber}`, { size: "xs", color: "#888888" }),
          ...(detail ? [text(detail, { size: "md", weight: "bold" })] : []),
        ],
      },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: buttons },
    },
  };
}
