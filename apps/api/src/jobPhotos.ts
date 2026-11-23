import { getRepairJob, type JobActor, type JobResult } from "./repairJobs";

/**
 * Plan 13.3 (owner, 21 Nov 2026: "yes, but just keep it one group of picture set"; plan OK 23 Nov):
 * one photo set per repair job. Staff add, open and remove photos; every add and remove goes in the
 * job's history with who did it.
 *
 * Private on purpose: unlike product photos, these show customers' cars, so they live under
 * job-photos/ in R2, which the public /img/ route never serves. Only signed-in staff open them.
 */

/** Enough for a job's before, during and after; a phone photo is ~2–5 MB. */
export const MAX_JOB_PHOTOS = 40;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

type Refusal = Extract<JobResult, { ok: false }>;
const refuse = (status: Refusal["status"], error: string): Refusal => ({
  ok: false,
  status,
  error,
});

async function jobExists(db: D1Database, jobId: string): Promise<boolean> {
  return (
    (await db.prepare("SELECT 1 AS n FROM repair_jobs WHERE id = ?").bind(jobId).first()) !== null
  );
}

function historyStmt(db: D1Database, jobId: string, kind: string, actor: JobActor) {
  return db
    .prepare(
      `INSERT INTO repair_job_events (id, job_id, kind, user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), jobId, kind, actor.userId, actor.now);
}

async function jobNow(db: D1Database, jobId: string): Promise<JobResult> {
  const job = await getRepairJob(db, jobId);
  return job ? { ok: true, job } : refuse(404, "not_found");
}

export async function addJobPhoto(
  db: D1Database,
  bucket: R2Bucket,
  jobId: string,
  photo: { bytes: ArrayBuffer; contentType: string },
  actor: JobActor,
): Promise<JobResult> {
  if (!(await jobExists(db, jobId))) return refuse(404, "not_found");
  if (photo.bytes.byteLength === 0) return refuse(400, "photo_required");
  const contentType = photo.contentType.split(";")[0]!.trim().toLowerCase();
  if (!PHOTO_TYPES.has(contentType)) return refuse(400, "photo_type");
  if (photo.bytes.byteLength > MAX_PHOTO_BYTES) return refuse(400, "photo_too_big");
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM repair_job_photos WHERE job_id = ?")
    .bind(jobId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_JOB_PHOTOS) return refuse(409, "too_many_photos");

  const id = crypto.randomUUID();
  const key = `job-photos/${jobId}/${id}`;
  await bucket.put(key, photo.bytes, { httpMetadata: { contentType } });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO repair_job_photos
             (id, job_id, r2_key, content_type, size_bytes, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, jobId, key, contentType, photo.bytes.byteLength, actor.userId, actor.now),
      historyStmt(db, jobId, "photo_added", actor),
    ]);
  } catch (err) {
    // The row never landed: don't leave an orphan picture in the store.
    await bucket.delete(key);
    throw err;
  }
  return jobNow(db, jobId);
}

async function photoRow(db: D1Database, jobId: string, photoId: string) {
  return db
    .prepare(
      "SELECT r2_key AS r2Key, content_type AS contentType FROM repair_job_photos WHERE id = ? AND job_id = ?",
    )
    .bind(photoId, jobId)
    .first<{ r2Key: string; contentType: string }>();
}

/** One photo's picture, only through its own job. */
export async function getJobPhoto(
  db: D1Database,
  bucket: R2Bucket,
  jobId: string,
  photoId: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const row = await photoRow(db, jobId, photoId);
  if (!row) return null;
  const object = await bucket.get(row.r2Key);
  if (!object) return null;
  return { body: await object.arrayBuffer(), contentType: row.contentType };
}

export async function removeJobPhoto(
  db: D1Database,
  bucket: R2Bucket,
  jobId: string,
  photoId: string,
  actor: JobActor,
): Promise<JobResult> {
  const row = await photoRow(db, jobId, photoId);
  if (!row) return refuse(404, "not_found");
  await db.batch([
    db.prepare("DELETE FROM repair_job_photos WHERE id = ?").bind(photoId),
    historyStmt(db, jobId, "photo_removed", actor),
  ]);
  await bucket.delete(row.r2Key);
  return jobNow(db, jobId);
}
