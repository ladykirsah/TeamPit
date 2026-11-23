-- Plan 13.3 (owner, 21 Nov 2026: "yes, but just keep it one group of picture set"; plan OK 23 Nov):
-- one photo set per repair job. Additive: a new table only.
--
-- The pictures sit in the private picture store (R2 IMAGES) under job-photos/<job id>/<photo id>.
-- They are NOT served by the public /img/ route: only signed-in staff open them
-- (GET /repair-jobs/:id/photos/:photoId). The customer's LINE job page (plan 13.2) will show them
-- through its own link.
CREATE TABLE repair_job_photos (
  id text PRIMARY KEY NOT NULL,
  job_id text NOT NULL REFERENCES repair_jobs(id),
  r2_key text NOT NULL UNIQUE,
  -- image/jpeg · image/png · image/webp · image/heic · image/heif
  content_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  -- Who added it (the job's history says it too).
  user_id text REFERENCES users(id),
  created_at integer NOT NULL
);
CREATE INDEX repair_job_photos_job_idx ON repair_job_photos (job_id, created_at);
