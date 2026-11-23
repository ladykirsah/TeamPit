import { describe, it, expect, vi } from "vitest";
import {
  addJobPhoto,
  getJobPhoto,
  MAX_JOB_PHOTOS,
  MAX_PHOTO_BYTES,
  removeJobPhoto,
} from "./jobPhotos";
import { getRepairJob, openRepairJob, type JobResult, type RepairJobDetail } from "./repairJobs";
import { asD1, memoryBucket, migratedDb } from "./testing/realDb";
import worker, { type Env } from "./index";
import { createStaffSession } from "./staffSession";

// The Worker extends `cloudflare:workers`' DurableObject, which does not exist under Node.
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
 * Plan 13.3 (owner, 21 Nov 2026: "yes, but just keep it one group of picture set"; plan OK 23 Nov):
 * one photo set per repair job. Staff add, list, open and remove photos; each add and remove goes in
 * the job's history with who did it. The photos are private: signed-in staff only.
 */

const T0 = Date.UTC(2026, 10, 23, 3, 0);
const kae = { userId: "u-kae", now: T0 };
const at = (minutes: number) => ({ userId: "u-kae", now: T0 + minutes * 60_000 });

function ok(r: JobResult): RepairJobDetail {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.job;
}

async function shopWithJob() {
  const raw = migratedDb();
  raw
    .prepare(
      "INSERT INTO users (id, name, name_th, email, role, status, created_at) VALUES ('u-kae', 'เก๋', 'เก๋', 'kae@shop.test', 'super_admin', 'active', 0)",
    )
    .run();
  const db = asD1(raw);
  const { objects, bucket } = memoryBucket();
  const job = ok(
    await openRepairJob(db, { licensePlate: "กข1234", plateProvince: "ขอนแก่น" }, kae),
  );
  return { raw, db, objects, bucket, jobId: job.id };
}

const jpeg = (bytes = 1234) => ({ bytes: new Uint8Array(bytes).buffer, contentType: "image/jpeg" });

describe("addJobPhoto (plan 13.3)", () => {
  it("given a photo > then the job lists it, the history says who added it, and it is kept privately", async () => {
    const { db, objects, bucket, jobId } = await shopWithJob();
    const job = ok(await addJobPhoto(db, bucket, jobId, jpeg(), at(1)));
    expect(job.photos).toEqual([
      expect.objectContaining({ contentType: "image/jpeg", sizeBytes: 1234, userName: "เก๋" }),
    ]);
    expect(job.events.at(-1)).toMatchObject({ kind: "photo_added", userName: "เก๋" });
    const keys = [...objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^job-photos/${jobId}/`));
  });

  it("given phone formats > then each is taken", async () => {
    const { db, bucket, jobId } = await shopWithJob();
    for (const contentType of ["image/png", "image/webp", "image/heic", "image/heif"]) {
      ok(
        await addJobPhoto(
          db,
          bucket,
          jobId,
          { bytes: new Uint8Array(10).buffer, contentType },
          kae,
        ),
      );
    }
    expect((await getRepairJob(db, jobId))!.photos).toHaveLength(4);
  });

  it("given no picture, another kind of file, or one over 10 MB > then refused and nothing kept", async () => {
    const { db, objects, bucket, jobId } = await shopWithJob();
    expect(await addJobPhoto(db, bucket, jobId, jpeg(0), kae)).toMatchObject({
      ok: false,
      status: 400,
      error: "photo_required",
    });
    expect(
      await addJobPhoto(
        db,
        bucket,
        jobId,
        { bytes: new Uint8Array(5).buffer, contentType: "application/pdf" },
        kae,
      ),
    ).toMatchObject({ ok: false, status: 400, error: "photo_type" });
    expect(await addJobPhoto(db, bucket, jobId, jpeg(MAX_PHOTO_BYTES + 1), kae)).toMatchObject({
      ok: false,
      status: 400,
      error: "photo_too_big",
    });
    expect(objects.size).toBe(0);
    expect((await getRepairJob(db, jobId))!.photos).toEqual([]);
  });

  it("given 40 photos already > then the next is refused", async () => {
    const { db, bucket, jobId } = await shopWithJob();
    for (let i = 0; i < MAX_JOB_PHOTOS; i++)
      ok(await addJobPhoto(db, bucket, jobId, jpeg(1), at(i)));
    expect(await addJobPhoto(db, bucket, jobId, jpeg(1), at(99))).toMatchObject({
      ok: false,
      status: 409,
      error: "too_many_photos",
    });
  });

  it("given a job that does not exist > then not found", async () => {
    const { db, bucket } = await shopWithJob();
    expect(await addJobPhoto(db, bucket, "no-such-job", jpeg(), kae)).toMatchObject({
      ok: false,
      status: 404,
      error: "not_found",
    });
  });
});

describe("getJobPhoto (plan 13.3)", () => {
  it("given a job's photo > then its picture and kind", async () => {
    const { db, bucket, jobId } = await shopWithJob();
    const photo = ok(await addJobPhoto(db, bucket, jobId, jpeg(7), kae)).photos[0]!;
    const got = await getJobPhoto(db, bucket, jobId, photo.id);
    expect(got?.contentType).toBe("image/jpeg");
    expect(got?.body.byteLength).toBe(7);
  });

  it("given another job's photo id > then nothing", async () => {
    const { db, bucket, jobId } = await shopWithJob();
    const photo = ok(await addJobPhoto(db, bucket, jobId, jpeg(), kae)).photos[0]!;
    const other = ok(
      await openRepairJob(db, { licensePlate: "70-1234", plateProvince: "ขอนแก่น" }, kae),
    );
    expect(await getJobPhoto(db, bucket, other.id, photo.id)).toBeNull();
  });
});

describe("removeJobPhoto (plan 13.3)", () => {
  it("given a photo > then it leaves the job and the store, and the history says who removed it", async () => {
    const { db, objects, bucket, jobId } = await shopWithJob();
    const photo = ok(await addJobPhoto(db, bucket, jobId, jpeg(), kae)).photos[0]!;
    const job = ok(await removeJobPhoto(db, bucket, jobId, photo.id, at(5)));
    expect(job.photos).toEqual([]);
    expect(objects.size).toBe(0);
    expect(job.events.at(-1)).toMatchObject({ kind: "photo_removed", userName: "เก๋" });
  });

  it("given a photo that is not on this job > then not found", async () => {
    const { db, bucket, jobId } = await shopWithJob();
    expect(await removeJobPhoto(db, bucket, jobId, "nope", kae)).toMatchObject({
      ok: false,
      status: 404,
      error: "not_found",
    });
  });
});

describe("job photo addresses (plan 13.3), through the Worker", () => {
  async function signedIn() {
    const shop = await shopWithJob();
    const { token } = await createStaffSession(shop.db, "u-kae", Date.now());
    const env = { DB: shop.db, IMAGES: shop.bucket } as unknown as Env;
    const send = (path: string, init: RequestInit = {}, session = true) =>
      worker.fetch!(
        new Request(`https://x${path}`, {
          ...init,
          headers: { ...(session ? { "X-Staff-Session": token } : {}), ...(init.headers ?? {}) },
        }),
        env,
        {} as ExecutionContext,
      );
    return { ...shop, send };
  }

  it("given a signed-in staff member > then add, open and remove a photo", async () => {
    const { send, jobId, objects } = await signedIn();
    const added = await send(`/repair-jobs/${jobId}/photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(added.status).toBe(200);
    const job = ((await added.json()) as { job: RepairJobDetail }).job;
    expect(job.photos).toHaveLength(1);
    const photoId = job.photos[0]!.id;

    const opened = await send(`/repair-jobs/${jobId}/photos/${photoId}`);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-type")).toBe("image/jpeg");
    expect(opened.headers.get("cache-control")).toContain("private");
    expect(new Uint8Array(await opened.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const removed = await send(`/repair-jobs/${jobId}/photos/${photoId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { job: RepairJobDetail }).job.photos).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it("given a refusal > then its own status and reason", async () => {
    const { send, jobId } = await signedIn();
    const res = await send(`/repair-jobs/${jobId}/photos`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "photo_type" });
    const missing = await send(`/repair-jobs/${jobId}/photos/nope`);
    expect(missing.status).toBe(404);
  });

  it("given no sign-in, or the public picture address > then the photo is never shown", async () => {
    const { send, jobId, objects } = await signedIn();
    const added = await send(`/repair-jobs/${jobId}/photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([9]),
    });
    const photoId = ((await added.json()) as { job: RepairJobDetail }).job.photos[0]!.id;
    expect((await send(`/repair-jobs/${jobId}/photos/${photoId}`, {}, false)).status).toBe(401);
    const key = [...objects.keys()][0]!;
    expect((await send(`/img/${key}`, {}, false)).status).toBe(404);
  });
});
