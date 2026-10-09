begin;
alter table public.fms_applications
  add column if not exists purpose text not null default '';
comment on column public.fms_applications.purpose is 'Applicant-stated purpose of the requested vehicle trip.';
commit;