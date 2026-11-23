/**
 * The customer follows their repair job in LINE (plan 13.2, owner 21 + 23 Nov 2026).
 *
 *  · Link: the QR on the job slip or bill opens a chat with the shop's OA holding a ready message
 *    with the job's code; when the customer sends it, their LINE follows that car (plate +
 *    province) — this job and every later one. Blocking the OA removes the links.
 *  · Cards: each job step the owner picked (in · check · estimate · waiting_parts · ready · paid)
 *    is taken for sending once and put on a queue; the background sender pushes the card to every
 *    LINE linked to the car and retries when LINE is busy, so staff never wait for LINE.
 *  · อนุมัติราคา: the price card's button moves the job to ลูกค้าตกลงราคา — only from a LINE linked
 *    to the car, only for the price the card showed.
 *
 * Nothing is sent until the shop connects its OA (line.ts). Steps that happen before then are
 * never sent later.
 */
import {
  formatBaht,
  jobCardMessage,
  jobTotalSatang,
  lineLinkUrl,
  readApproveData,
  readLinkCode,
  shopKey,
  type JobCardStep,
  type LineFlexMessage,
} from "@l-shopee/core";
import {
  lineClient,
  lineConfig,
  retryKeyFor,
  verifyLineSignature,
  type LineClient,
  type LineEnv,
  type SendOutcome,
} from "./line";
import { getRepairJob, jobIdForCode, type JobResult } from "./repairJobs";
import { DEN_AIR, readShops, shopEnv, type Shop } from "./shops";

/** One card to send: the shop it belongs to and the job step (history row) it is for. */
export interface CardMessage {
  shop: string;
  eventId: string;
}

export interface CardEnv extends LineEnv {
  DB: D1Database;
  KV: KVNamespace;
  SHOP?: Shop;
  SHOPS?: string;
  LINE_CARDS?: Queue<CardMessage>;
}

const shopOf = (env: CardEnv): Shop => env.SHOP ?? DEN_AIR;

/** The job page every card opens: on the shop's own app address. */
const pageUrlFor = (env: CardEnv, code: string) => `${shopOf(env).origins[0]}/j/${code}`;

/** The shop's name as its customers know it (ข้อมูลร้าน), else its TeamPit name. */
async function shopNameOf(env: CardEnv): Promise<string> {
  return (await env.KV.get(shopKey("denair", "name")))?.trim() || shopOf(env).name;
}

interface JobCar {
  id: string;
  jobNumber: string;
  code: string;
  plate: string;
  province: string;
  status: string;
}

async function jobCar(db: D1Database, jobId: string): Promise<JobCar | null> {
  return db
    .prepare(
      `SELECT id, job_number AS jobNumber, customer_token AS code, license_plate AS plate,
              plate_province AS province, status
       FROM repair_jobs WHERE id = ?`,
    )
    .bind(jobId)
    .first<JobCar>();
}

// ── Linking ─────────────────────────────────────────────────────────────────────────────────

export type LinkResult =
  { ok: true; jobId: string; plate: string; province: string } | { ok: false; error: "not_found" };

/** The customer sent the QR's message: their LINE follows that job's car. Sending it again is fine. */
export async function linkLineToCar(
  db: D1Database,
  code: string,
  lineUserId: string,
  now: number,
): Promise<LinkResult> {
  const jobId = await jobIdForCode(db, code);
  const car = jobId ? await jobCar(db, jobId) : null;
  if (!car) return { ok: false, error: "not_found" };
  await db
    .prepare(
      `INSERT INTO line_links (line_user_id, license_plate, plate_province, job_id, linked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (line_user_id, license_plate, plate_province) DO NOTHING`,
    )
    .bind(lineUserId, car.plate, car.province, car.id, now)
    .run();
  return { ok: true, jobId: car.id, plate: car.plate, province: car.province };
}

/** The customer blocked the OA: their LINE follows no car any more. */
export async function unlinkLine(db: D1Database, lineUserId: string): Promise<void> {
  await db.prepare("DELETE FROM line_links WHERE line_user_id = ?").bind(lineUserId).run();
}

async function linkedLines(db: D1Database, car: { plate: string; province: string }) {
  const rows = await db
    .prepare(
      `SELECT line_user_id AS u FROM line_links
       WHERE license_plate = ? AND plate_province = ? ORDER BY line_user_id`,
    )
    .bind(car.plate, car.province)
    .all<{ u: string }>();
  return (rows.results ?? []).map((r) => r.u);
}

// ── Taking steps for sending ────────────────────────────────────────────────────────────────

/** The job's card steps not yet taken for sending, each taken now — so each is sent at most once. */
export async function claimNewCards(
  db: D1Database,
  jobId: string,
  now: number,
): Promise<{ eventId: string; step: JobCardStep }[]> {
  const rows = await db
    .prepare(
      `UPDATE repair_job_events SET card_queued_at = ?
       WHERE job_id = ? AND customer_update IS NOT NULL AND card_queued_at IS NULL
       RETURNING id AS eventId, customer_update AS step, created_at AS createdAt, rowid AS r`,
    )
    .bind(now, jobId)
    .all<{ eventId: string; step: JobCardStep; createdAt: number; r: number }>();
  return (rows.results ?? [])
    .sort((a, b) => a.createdAt - b.createdAt || a.r - b.r)
    .map(({ eventId, step }) => ({ eventId, step }));
}

/**
 * After a job step: its new cards go on the queue. Not connected → taken anyway and never sent.
 * The queue failing → given back, so the next step of the job sends them.
 */
export async function queueJobCards(env: CardEnv, jobId: string, now: number): Promise<void> {
  const cards = await claimNewCards(env.DB, jobId, now);
  if (cards.length === 0 || !lineConfig(env) || !env.LINE_CARDS) return;
  const shop = shopOf(env).id;
  try {
    await env.LINE_CARDS.sendBatch(cards.map((c) => ({ body: { shop, eventId: c.eventId } })));
  } catch (err) {
    console.error(`[line] could not queue ${cards.length} card(s) for job ${jobId}:`, err);
    const ids = cards.map((c) => c.eventId);
    await env.DB.prepare(
      `UPDATE repair_job_events SET card_queued_at = NULL WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .run();
  }
}

// ── The card ────────────────────────────────────────────────────────────────────────────────

async function cardMessageFor(
  env: CardEnv,
  eventId: string,
): Promise<{ car: JobCar; message: LineFlexMessage } | null> {
  const event = await env.DB.prepare(
    `SELECT job_id AS jobId, customer_update AS step, expected_at AS expectedAt
     FROM repair_job_events WHERE id = ?`,
  )
    .bind(eventId)
    .first<{ jobId: string; step: JobCardStep | null; expectedAt: number | null }>();
  if (!event?.step) return null;
  const [car, job] = await Promise.all([
    jobCar(env.DB, event.jobId),
    getRepairJob(env.DB, event.jobId),
  ]);
  if (!car || !job) return null;
  const message = jobCardMessage({
    step: event.step,
    shopName: await shopNameOf(env),
    jobNumber: car.jobNumber,
    plate: car.plate,
    province: car.province,
    totalSatang: jobTotalSatang(job.lines),
    waitUntil: event.expectedAt,
    pageUrl: pageUrlFor(env, car.code),
    token: car.code,
  });
  return { car, message };
}

/** A step's card and every LINE linked to the job's car. */
export async function jobCardFor(
  env: CardEnv,
  eventId: string,
): Promise<{ recipients: string[]; message: LineFlexMessage } | null> {
  const card = await cardMessageFor(env, eventId);
  if (!card) return null;
  return { recipients: await linkedLines(env.DB, card.car), message: card.message };
}

async function deliverCard(
  env: CardEnv,
  eventId: string,
  client: LineClient,
): Promise<SendOutcome> {
  const card = await jobCardFor(env, eventId);
  if (!card) return "sent";
  let outcome: SendOutcome = "sent";
  for (const to of card.recipients) {
    const one = await client.push(to, [card.message], await retryKeyFor(eventId, to));
    if (one === "retry") outcome = "retry";
  }
  return outcome;
}

const RETRY_DELAY_SECONDS = 60;

/** The background sender: each queued card, to each linked LINE. LINE busy or down → later. */
export async function consumeLineCards(
  batch: MessageBatch<CardMessage>,
  workerEnv: CardEnv,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const shops = readShops(workerEnv.SHOPS);
  for (const message of batch.messages) {
    try {
      const shop = shops.find((s) => s.id === message.body.shop);
      const env = shop ? shopEnv(workerEnv, shop) : null;
      const config = env ? lineConfig(env) : null;
      if (!env || !config) {
        message.ack();
        continue;
      }
      const outcome = await deliverCard(env, message.body.eventId, lineClient(config, fetchFn));
      if (outcome === "retry") message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      else message.ack();
    } catch (err) {
      console.error(`[line] card ${message.body.eventId} failed; trying again later:`, err);
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}

// ── What the customer sends to the OA ───────────────────────────────────────────────────────

const replyText = (text: string) => ({ type: "text", text });

/** The job's latest card, for the reply when the customer links (a reply costs nothing). */
async function latestCard(env: CardEnv, jobId: string): Promise<LineFlexMessage | null> {
  const last = await env.DB.prepare(
    `SELECT e.id FROM repair_job_events e JOIN repair_jobs j ON j.id = e.job_id
     WHERE e.job_id = ? AND e.customer_update IS NOT NULL AND j.status <> 'cancelled'
     ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
  )
    .bind(jobId)
    .first<{ id: string }>();
  return last ? ((await cardMessageFor(env, last.id))?.message ?? null) : null;
}

async function onText(
  env: CardEnv,
  userId: string,
  text: string,
  reply: (m: unknown[]) => unknown,
) {
  const code = readLinkCode(text);
  if (!code) return; // an ordinary chat message: staff answer it in the OA themselves
  const linked = await linkLineToCar(env.DB, code, userId, Date.now());
  if (!linked.ok) {
    await reply([replyText("ไม่พบงานซ่อมจากรหัสนี้ กรุณาติดต่อร้าน")]);
    return;
  }
  const card = await latestCard(env, linked.jobId);
  await reply([
    replyText(
      `เชื่อม LINE กับรถ ${`${linked.plate} ${linked.province}`.trim()} แล้ว ร้านจะแจ้งทุกขั้นตอนของงานซ่อมทางนี้`,
    ),
    ...(card ? [card] : []),
  ]);
}

async function onApprove(
  env: CardEnv,
  userId: string,
  data: string,
  approve: (jobId: string, totalSatang: number) => Promise<JobResult>,
  reply: (m: unknown[]) => unknown,
) {
  const asked = readApproveData(data);
  const jobId = asked ? await jobIdForCode(env.DB, asked.token) : null;
  const car = jobId ? await jobCar(env.DB, jobId) : null;
  if (!asked || !car) return;
  if (!(await linkedLines(env.DB, car)).includes(userId)) return;
  const result = await approve(car.id, asked.totalSatang);
  const page = pageUrlFor(env, car.code);
  if (result.ok) {
    await reply([
      replyText(`อนุมัติราคา ${formatBaht(asked.totalSatang)} แล้ว ร้านจะเริ่มซ่อมตามนี้ครับ`),
    ]);
  } else if (result.error === "price_changed") {
    await reply([replyText(`ราคาเปลี่ยนแล้ว ดูราคาล่าสุดได้ที่ ${page}`)]);
  } else if (result.error === "not_estimate") {
    await reply([replyText(`ราคานี้อนุมัติแล้ว หรืองานไปขั้นต่อไปแล้ว ดูสถานะได้ที่ ${page}`)]);
  }
}

/** LINE's webhook bodies are a few KB; anything this big is not LINE. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

interface LineEvent {
  type?: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string };
}

/**
 * LINE's webhook for the shop's OA. Only a body LINE signed is read. Each event on its own: one
 * failing never stops the others, and LINE always gets its 200 for a signed body.
 */
export async function handleLineWebhook(
  request: Request,
  env: CardEnv,
  approve: (jobId: string, totalSatang: number) => Promise<JobResult>,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const config = lineConfig(env);
  if (!config) return Response.json({ error: "not_found" }, { status: 404 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "too_big" }, { status: 413 });
  }
  const body = await request.text();
  const signature = request.headers.get("x-line-signature") ?? "";
  if (!(await verifyLineSignature(config.secret, body, signature))) {
    return Response.json({ error: "bad_signature" }, { status: 401 });
  }
  let events: LineEvent[] = [];
  try {
    const parsed = JSON.parse(body) as { events?: unknown };
    if (Array.isArray(parsed.events)) events = parsed.events as LineEvent[];
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const client = lineClient(config, fetchFn);
  for (const event of events) {
    const userId = event.source?.userId;
    if (typeof userId !== "string" || !userId) continue;
    const reply = (messages: unknown[]) =>
      event.replyToken ? client.reply(event.replyToken, messages) : undefined;
    try {
      if (event.type === "unfollow") await unlinkLine(env.DB, userId);
      else if (event.type === "message" && event.message?.type === "text") {
        await onText(env, userId, event.message.text ?? "", reply);
      } else if (event.type === "postback") {
        await onApprove(env, userId, event.postback?.data ?? "", approve, reply);
      }
    } catch (err) {
      console.error(`[line] webhook ${event.type} event failed:`, err);
    }
  }
  return Response.json({ ok: true });
}

// ── For staff: the job's page and QR ────────────────────────────────────────────────────────

/**
 * What staff print and show: the job page's address, the QR's address (null until the OA is
 * connected) and how many LINEs follow the car.
 */
export async function customerLinksFor(
  env: CardEnv,
  jobId: string,
): Promise<{ pageUrl: string; lineLinkUrl: string | null; linkedLines: number } | null> {
  const car = await jobCar(env.DB, jobId);
  if (!car) return null;
  const config = lineConfig(env);
  return {
    pageUrl: pageUrlFor(env, car.code),
    lineLinkUrl: config ? lineLinkUrl(config.oaId, car.jobNumber, car.code) : null,
    linkedLines: (await linkedLines(env.DB, car)).length,
  };
}
