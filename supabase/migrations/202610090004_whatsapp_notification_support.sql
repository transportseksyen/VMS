begin;

alter table public.fms_applications
  add column if not exists whatsapp_opt_in boolean not null default false;
alter table public.fms_drivers
  add column if not exists whatsapp_opt_in boolean not null default false;
alter table public.fms_notifications
  add column if not exists whatsapp_status text not null default 'not_configured';
alter table public.fms_notifications
  add column if not exists whatsapp_error text;
alter table public.fms_notifications
  add column if not exists whatsapp_sent_at timestamptz;

grant update (whatsapp_opt_in, availability_status, availability_start, availability_end, availability_remarks, updated_at)
  on public.fms_drivers to authenticated;

comment on column public.fms_applications.whatsapp_opt_in is 'Applicant explicitly opted in to WhatsApp updates.';
comment on column public.fms_drivers.whatsapp_opt_in is 'Driver explicitly opted in to WhatsApp trip updates.';
comment on column public.fms_notifications.whatsapp_status is 'WhatsApp delivery status reported by the messaging provider.';

commit;