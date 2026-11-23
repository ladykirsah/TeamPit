-- Plan 13.2 (owner, 21 + 23 Nov 2026): the customer follows their repair job in LINE, from the
-- shop's own LINE OA. They link their LINE to their car once with the QR on the bill (pick A); a
-- card goes to every LINE linked to the car at each of the six steps (pick A); the price card's
-- อนุมัติราคา moves the job on (pick A); each card opens a private job page.
--
-- Additive only: two new columns and one new table. Live had no repair jobs when this was written.

-- 1 · Each job's private code: the job page's address and the code in the QR's ready message.
-- 32 random hex characters. Every job gets one when it is opened (repairJobs.ts openRepairJob).
ALTER TABLE repair_jobs ADD COLUMN customer_token text;
UPDATE repair_jobs SET customer_token = lower(hex(randomblob(16))) WHERE customer_token IS NULL;
CREATE UNIQUE INDEX repair_jobs_customer_token_idx ON repair_jobs (customer_token);

-- 2 · When a step's card was put on the send queue. Steps from before LINE existed are marked
-- as done, so connecting the OA later never sends a pile of old cards.
ALTER TABLE repair_job_events ADD COLUMN card_queued_at integer;
UPDATE repair_job_events SET card_queued_at = created_at WHERE customer_update IS NOT NULL;

-- 3 · Which LINE follows which car (plate + province, plan 13.11). One LINE can follow several
-- cars and one car can have several LINEs (husband and wife). `job_id` = the job whose QR linked
-- it. Removed when the customer blocks the OA. No table points at it.
CREATE TABLE line_links (
  line_user_id text NOT NULL,
  license_plate text NOT NULL,
  plate_province text NOT NULL DEFAULT '',
  job_id text REFERENCES repair_jobs (id),
  linked_at integer NOT NULL,
  PRIMARY KEY (line_user_id, license_plate, plate_province)
);
CREATE INDEX line_links_car_idx ON line_links (license_plate, plate_province);
