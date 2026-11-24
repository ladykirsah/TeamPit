-- Plan 13.6 (owner, 24 Nov 2026): "repair job can have warranty, but manually decide by super admin
-- car by car > decide > fill to the bill at the create bill stage · and able to select shown on the
-- bill or not". Pick A: a period (days or months) + a short note on what it covers; the last day is
-- worked out from the day the job is paid (packages/core warranty.ts), so it isn't stored.
--
-- Additive only: four new columns on repair_jobs. NULL count = no warranty.
ALTER TABLE repair_jobs ADD COLUMN warranty_count integer;
ALTER TABLE repair_jobs ADD COLUMN warranty_unit text
  CHECK (warranty_unit IS NULL OR warranty_unit IN ('day', 'month'));
ALTER TABLE repair_jobs ADD COLUMN warranty_note text;
-- แสดงบนบิล: 1 = on the bill and the customer's job page; 0 = staff only.
ALTER TABLE repair_jobs ADD COLUMN warranty_on_bill integer NOT NULL DEFAULT 1;
