-- These legacy one-record approval RPCs bypass the current registry review workflow,
-- including the Fleet Manager self-approval guard. The app uses
-- fms_review_registry_record instead, so disable the obsolete public API entry points.
REVOKE ALL PRIVILEGES ON FUNCTION public.fms_approve_vehicle(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.fms_approve_driver(uuid) FROM PUBLIC, anon, authenticated;
