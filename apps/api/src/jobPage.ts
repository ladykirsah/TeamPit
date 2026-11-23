/**
 * The customer's job page (plan 13.2): what every LINE card opens. No sign-in — the job's private
 * 32-character code is the key, and the page carries only what the customer should see: the
 * steps so far, the price lines, the waiting time, the photos and, once the car is ready, the
 * shop's PromptPay QR for exactly the bill (with the account name, owner 30 Oct 2026). Staff mark
 * the job paid when the slip comes, as today. The page itself is drawn with Stage 12.
 */
import {
  buildPromptPayPayload,
  defaultPaymentMethod,
  jobTotalSatang,
  parsePaymentMethods,
  shopKey,
  waitUntil,
  type JobStatus,
} from "@l-shopee/core";
import { getJobPhoto } from "./jobPhotos";
import { getRepairJob, jobIdForCode, type RepairJobDetail } from "./repairJobs";
import { DEN_AIR, type Shop } from "./shops";

export interface JobPageEnv {
  DB: D1Database;
  KV: KVNamespace;
  IMAGES: R2Bucket;
  SHOP?: Shop;
}

export interface JobPageView {
  shopName: string;
  jobNumber: string;
  plate: string;
  province: string | null;
  vehicle: string | null;
  problem: string | null;
  status: JobStatus;
  /** The steps the customer was told, oldest first. */
  steps: { step: string; at: number; expectedAt: number | null }[];
  /** รออะไหล่: when the last waiting part is due. */
  waitUntil: number | null;
  lines: {
    description: string;
    quantity: number;
    unitPriceSatang: number;
    discountSatang: number;
  }[];
  totalSatang: number;
  photos: { id: string; createdAt: number }[];
  /** พร้อมรับรถ: pay by PromptPay — null when the shop has no PromptPay set up, or at any other step. */
  pay: { amountSatang: number; promptpayPayload: string; accountName: string | null } | null;
  paidAt: number | null;
}

/** The shop's default PromptPay, for exactly this amount; null when there is none or it is broken. */
async function payQr(env: JobPageEnv, amountSatang: number): Promise<JobPageView["pay"]> {
  if (amountSatang <= 0) return null;
  const method = defaultPaymentMethod(
    parsePaymentMethods(await env.KV.get(shopKey("denair", "paymentMethods"))),
  );
  if (!method) return null;
  try {
    return {
      amountSatang,
      promptpayPayload: buildPromptPayPayload({ target: method.promptpayId, amountSatang }),
      accountName: method.accountName ?? null,
    };
  } catch (err) {
    console.error("[job-page] the shop's PromptPay number makes no QR:", err);
    return null;
  }
}

async function viewOf(env: JobPageEnv, job: RepairJobDetail): Promise<JobPageView> {
  const total = jobTotalSatang(job.lines);
  return {
    shopName: (await env.KV.get(shopKey("denair", "name")))?.trim() || (env.SHOP ?? DEN_AIR).name,
    jobNumber: job.jobNumber,
    plate: job.licensePlate,
    province: job.plateProvince || null,
    vehicle: job.vehicle,
    problem: job.problem,
    status: job.status,
    steps: job.events
      .filter((e) => e.customerUpdate)
      .map((e) => ({ step: e.customerUpdate!, at: e.createdAt, expectedAt: e.expectedAt })),
    waitUntil: job.status === "waiting_parts" ? waitUntil(job.lines) : null,
    lines: job.lines
      .filter((l) => l.state !== "removed")
      .map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceSatang: l.unitPriceSatang,
        discountSatang: l.discountSatang ?? 0,
      })),
    totalSatang: total,
    photos: job.photos.map((p) => ({ id: p.id, createdAt: p.createdAt })),
    pay: job.status === "ready" ? await payQr(env, total) : null,
    paidAt: job.status === "paid" ? job.closedAt : null,
  };
}

/** The page for a job's code; null for a code no job has. */
export async function jobPageFor(env: JobPageEnv, code: string): Promise<JobPageView | null> {
  const jobId = await jobIdForCode(env.DB, code);
  const job = jobId ? await getRepairJob(env.DB, jobId) : null;
  return job ? viewOf(env, job) : null;
}

/** One of the job's photos, through the job's code only. */
export async function jobPagePhoto(
  env: JobPageEnv,
  code: string,
  photoId: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const jobId = await jobIdForCode(env.DB, code);
  return jobId ? getJobPhoto(env.DB, env.IMAGES, jobId, photoId) : null;
}
