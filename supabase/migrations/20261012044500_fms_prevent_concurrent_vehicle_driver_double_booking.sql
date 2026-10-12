-- Enforce no overlapping proposed/approved reservations at the database layer.
-- Application-level checks provide friendly errors; these constraints also protect
-- against two concurrent transactions passing those checks at the same time.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE public.fms_assignments
  ADD CONSTRAINT fms_assignments_no_overlapping_vehicle
  EXCLUDE USING gist (
    vehicle_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (status IN ('proposed', 'approved'));

ALTER TABLE public.fms_assignments
  ADD CONSTRAINT fms_assignments_no_overlapping_driver
  EXCLUDE USING gist (
    driver_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (status IN ('proposed', 'approved'));
