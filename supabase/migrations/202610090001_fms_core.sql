begin;

create schema if not exists fms_private;
revoke all on schema fms_private from public;

create table if not exists public.fms_agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  code text unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.fms_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  role text not null check (role in ('super_admin','fleet_manager','data_entry','driver')),
  agency_id uuid references public.fms_agencies(id),
  phone text,
  status text not null default 'pending' check (status in ('active','pending','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fms_vehicles (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.fms_agencies(id),
  brand text not null,
  model text not null,
  vehicle_type text not null,
  plate_number text not null,
  seat_capacity integer not null default 5 check (seat_capacity > 0),
  vehicle_status text not null default 'active' check (vehicle_status in ('active','under_maintenance','unavailable','retired')),
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','rejected','returned')),
  remarks text,
  created_by uuid references public.fms_profiles(id),
  approved_by uuid references public.fms_profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, plate_number)
);

create table if not exists public.fms_drivers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.fms_profiles(id),
  agency_id uuid not null references public.fms_agencies(id),
  full_name text not null,
  email text not null,
  phone text,
  emergency_contact_name text,
  emergency_contact_phone text,
  account_status text not null default 'active' check (account_status in ('active','inactive','suspended')),
  availability_status text not null default 'available' check (availability_status in ('available','on_leave','on_course','unavailable')),
  availability_start date,
  availability_end date,
  availability_remarks text,
  licence_expiry date,
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','rejected','returned')),
  remarks text,
  created_by uuid references public.fms_profiles(id),
  approved_by uuid references public.fms_profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fms_applications (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('FMS-' || upper(substr(gen_random_uuid()::text,1,8))),
  agency_id uuid not null references public.fms_agencies(id),
  applicant_name text not null,
  applicant_agency_name text not null,
  email text not null,
  phone text not null,
  passenger_count integer not null check (passenger_count > 0),
  vehicles_requested integer not null check (vehicles_requested > 0),
  passenger_names text,
  destination text not null,
  hotel_provided boolean not null default false,
  start_date date not null,
  end_date date not null,
  document_path text not null,
  status text not null default 'pending_assignment' check (status in ('pending_assignment','pending_manager_approval','approved','rejected','returned_for_correction','cancelled')),
  decision_reason text,
  submitted_at timestamptz not null default now(),
  decided_by uuid references public.fms_profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint application_date_order check (end_date >= start_date)
);

create table if not exists public.fms_assignments (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.fms_agencies(id),
  application_id uuid not null references public.fms_applications(id),
  vehicle_id uuid not null references public.fms_vehicles(id),
  driver_id uuid not null references public.fms_drivers(id),
  start_date date not null,
  end_date date not null,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','cancelled')),
  submitted_by uuid references public.fms_profiles(id),
  decided_by uuid references public.fms_profiles(id),
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assignment_date_order check (end_date >= start_date)
);

create table if not exists public.fms_fuel_transactions (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.fms_agencies(id),
  driver_id uuid not null references public.fms_drivers(id),
  vehicle_id uuid not null references public.fms_vehicles(id),
  reporting_month text not null check (reporting_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  purchase_date date not null,
  odometer_reading numeric(12,1) not null check (odometer_reading >= 0),
  litres numeric(10,2) not null check (litres > 0),
  amount_rm numeric(12,2) not null check (amount_rm > 0),
  receipt_path text not null,
  status text not null default 'submitted' check (status in ('draft','submitted','approved','returned','rejected')),
  reviewed_by uuid references public.fms_profiles(id),
  reviewed_at timestamptz,
  review_remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fms_maintenance_records (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.fms_agencies(id),
  vehicle_id uuid not null references public.fms_vehicles(id),
  category text not null,
  description text not null,
  date_reported date not null,
  status text not null default 'submitted' check (status in ('submitted','pending_approval','in_progress','completed','rejected')),
  estimated_cost_rm numeric(12,2),
  actual_cost_rm numeric(12,2),
  odometer_reading numeric(12,1),
  service_date date,
  next_service_due date,
  workshop text,
  remarks text,
  created_by uuid references public.fms_profiles(id),
  reviewed_by uuid references public.fms_profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fms_maintenance_documents (
  id uuid primary key default gen_random_uuid(),
  maintenance_id uuid not null references public.fms_maintenance_records(id) on delete cascade,
  document_type text not null check (document_type in ('quotation','maintenance_request','service_order','invoice','other')),
  file_path text not null,
  original_file_name text not null,
  uploaded_by uuid references public.fms_profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.fms_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid references public.fms_profiles(id),
  recipient_email text,
  subject text not null,
  body text not null,
  notification_type text not null,
  related_table text,
  related_record_id uuid,
  email_status text not null default 'pending' check (email_status in ('pending','sent','failed','not_configured')),
  email_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.fms_audit_logs (
  id bigint generated always as identity primary key,
  actor_profile_id uuid references public.fms_profiles(id),
  agency_id uuid references public.fms_agencies(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.fms_public_submission_rate_limits (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists public_submission_rate_limits_ip_created_idx
  on public.fms_public_submission_rate_limits(ip_hash, created_at desc);

create index if not exists applications_agency_status_idx on public.fms_applications(agency_id, status, start_date);
create index if not exists assignments_agency_dates_idx on public.fms_assignments(agency_id, status, start_date, end_date);
create index if not exists fuel_agency_month_idx on public.fms_fuel_transactions(agency_id, reporting_month);
create index if not exists maintenance_vehicle_created_idx on public.fms_maintenance_records(vehicle_id, created_at desc);

create or replace function fms_private.current_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select p.role from public.fms_profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
  limit 1
$$;

create or replace function fms_private.current_agency_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.agency_id from public.fms_profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
  limit 1
$$;

create or replace function fms_private.has_agency_access(target_agency_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.fms_profiles p
    where p.id = (select auth.uid()) and p.status = 'active'
      and (p.role = 'super_admin' or p.agency_id = target_agency_id)
  )
$$;

revoke all on function fms_private.current_role() from public;
revoke all on function fms_private.current_agency_id() from public;
revoke all on function fms_private.has_agency_access(uuid) from public;
grant usage on schema fms_private to authenticated;
grant execute on function fms_private.current_role() to authenticated;
grant execute on function fms_private.current_agency_id() to authenticated;
grant execute on function fms_private.has_agency_access(uuid) to authenticated;

alter table public.fms_agencies enable row level security;
alter table public.fms_profiles enable row level security;
alter table public.fms_vehicles enable row level security;
alter table public.fms_drivers enable row level security;
alter table public.fms_applications enable row level security;
alter table public.fms_assignments enable row level security;
alter table public.fms_fuel_transactions enable row level security;
alter table public.fms_maintenance_records enable row level security;
alter table public.fms_maintenance_documents enable row level security;
alter table public.fms_notifications enable row level security;
alter table public.fms_audit_logs enable row level security;
alter table public.fms_public_submission_rate_limits enable row level security;

drop policy if exists agencies_public_active_read on public.fms_agencies;
create policy agencies_public_active_read on public.fms_agencies for select to anon, authenticated using (is_active = true);
drop policy if exists agencies_admin_all on public.fms_agencies;
create policy agencies_admin_all on public.fms_agencies for all to authenticated
using (fms_private.current_role() = 'super_admin')
with check (fms_private.current_role() = 'super_admin');

drop policy if exists profiles_scoped_read on public.fms_profiles;
create policy profiles_scoped_read on public.fms_profiles for select to authenticated
using (id = (select auth.uid()) or fms_private.current_role() = 'super_admin'
  or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()));
drop policy if exists profiles_self_update on public.fms_profiles;
create policy profiles_self_update on public.fms_profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists vehicles_scoped_read on public.fms_vehicles;
create policy vehicles_scoped_read on public.fms_vehicles for select to authenticated
using (fms_private.has_agency_access(agency_id));
drop policy if exists vehicles_data_entry_insert on public.fms_vehicles;
create policy vehicles_data_entry_insert on public.fms_vehicles for insert to authenticated
with check (
  fms_private.current_role() = 'super_admin'
  or (fms_private.current_role() = 'data_entry' and agency_id = fms_private.current_agency_id() and approval_status = 'pending')
);
drop policy if exists vehicles_data_entry_update_pending on public.fms_vehicles;
create policy vehicles_data_entry_update_pending on public.fms_vehicles for update to authenticated
using (fms_private.current_role() = 'data_entry' and agency_id = fms_private.current_agency_id() and approval_status in ('pending','returned'))
with check (fms_private.current_role() = 'data_entry' and agency_id = fms_private.current_agency_id() and approval_status in ('pending','returned'));
drop policy if exists vehicles_manager_approve on public.fms_vehicles;
create policy vehicles_manager_approve on public.fms_vehicles for update to authenticated
using (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()))
with check (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()));

drop policy if exists drivers_scoped_read on public.fms_drivers;
create policy drivers_scoped_read on public.fms_drivers for select to authenticated
using (fms_private.has_agency_access(agency_id));
drop policy if exists drivers_data_entry_insert on public.fms_drivers;
create policy drivers_data_entry_insert on public.fms_drivers for insert to authenticated
with check (
  fms_private.current_role() = 'super_admin'
  or (fms_private.current_role() = 'data_entry' and agency_id = fms_private.current_agency_id() and approval_status = 'pending')
);
drop policy if exists drivers_data_entry_update_pending on public.fms_drivers;
create policy drivers_data_entry_update_pending on public.fms_drivers for update to authenticated
using (fms_private.current_role() = 'data_entry' and agency_id = fms_private.current_agency_id() and approval_status in ('pending','returned'))
with check (fms_private.current_role() = 'data_entry' and agency_id = fms_private.current_agency_id() and approval_status in ('pending','returned'));
drop policy if exists drivers_manager_approve on public.fms_drivers;
create policy drivers_manager_approve on public.fms_drivers for update to authenticated
using (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()))
with check (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()));
drop policy if exists drivers_self_availability on public.fms_drivers;
create policy drivers_self_availability on public.fms_drivers for update to authenticated
using (profile_id = (select auth.uid()))
with check (profile_id = (select auth.uid()));

drop policy if exists applications_scoped_read on public.fms_applications;
create policy applications_scoped_read on public.fms_applications for select to authenticated
using (fms_private.current_role() in ('super_admin','fleet_manager','data_entry') and fms_private.has_agency_access(agency_id)
  or (fms_private.current_role() = 'driver' and exists (
    select 1 from public.fms_assignments a join public.fms_drivers d on d.id = a.driver_id
    where a.application_id = applications.id and d.profile_id = (select auth.uid())
  )));
drop policy if exists applications_data_entry_update on public.fms_applications;
create policy applications_data_entry_update on public.fms_applications for update to authenticated
using (fms_private.current_role() in ('data_entry','super_admin') and fms_private.has_agency_access(agency_id))
with check (
  fms_private.current_role() = 'super_admin'
  or (fms_private.current_role() = 'data_entry' and agency_id = fms_private.current_agency_id()
    and status in ('pending_assignment','pending_manager_approval','returned_for_correction'))
);
drop policy if exists applications_manager_update on public.fms_applications;
create policy applications_manager_update on public.fms_applications for update to authenticated
using (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()))
with check (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()));

drop policy if exists assignments_scoped_read on public.fms_assignments;
create policy assignments_scoped_read on public.fms_assignments for select to authenticated
using (fms_private.has_agency_access(agency_id));
drop policy if exists assignments_data_entry_insert on public.fms_assignments;
create policy assignments_data_entry_insert on public.fms_assignments for insert to authenticated
with check (
  (fms_private.current_role() = 'super_admin' or agency_id = fms_private.current_agency_id())
  and fms_private.current_role() in ('data_entry','super_admin')
  and status = 'proposed'
  and exists (select 1 from public.fms_applications ap where ap.id = application_id and ap.agency_id = assignments.agency_id and ap.status in ('pending_assignment','returned_for_correction'))
  and exists (select 1 from public.fms_vehicles v where v.id = vehicle_id and v.agency_id = assignments.agency_id and v.approval_status = 'approved' and v.vehicle_status = 'active')
  and exists (select 1 from public.fms_drivers d where d.id = driver_id and d.agency_id = assignments.agency_id and d.approval_status = 'approved' and d.account_status = 'active')
);

drop policy if exists fuel_scoped_read on public.fms_fuel_transactions;
create policy fuel_scoped_read on public.fms_fuel_transactions for select to authenticated
using (fms_private.has_agency_access(agency_id) and (
  fms_private.current_role() in ('super_admin','fleet_manager','data_entry')
  or exists (select 1 from public.fms_drivers d where d.id = fuel_transactions.driver_id and d.profile_id = (select auth.uid()))
));
drop policy if exists fuel_driver_insert on public.fms_fuel_transactions;
create policy fuel_driver_insert on public.fms_fuel_transactions for insert to authenticated
with check (
  fms_private.current_role() = 'driver'
  and agency_id = fms_private.current_agency_id()
  and exists (select 1 from public.fms_drivers d where d.id = driver_id and d.profile_id = (select auth.uid()) and d.agency_id = agency_id)
  and exists (select 1 from public.fms_vehicles v where v.id = vehicle_id and v.agency_id = agency_id and v.approval_status = 'approved')
);
drop policy if exists fuel_manager_review on public.fms_fuel_transactions;
create policy fuel_manager_review on public.fms_fuel_transactions for update to authenticated
using (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()))
with check (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()));

drop policy if exists maintenance_scoped_read on public.fms_maintenance_records;
create policy maintenance_scoped_read on public.fms_maintenance_records for select to authenticated
using (fms_private.has_agency_access(agency_id));
drop policy if exists maintenance_data_entry_insert on public.fms_maintenance_records;
create policy maintenance_data_entry_insert on public.fms_maintenance_records for insert to authenticated
with check (fms_private.current_role() = 'super_admin' or (agency_id = fms_private.current_agency_id() and fms_private.current_role() = 'data_entry'));
drop policy if exists maintenance_data_entry_update on public.fms_maintenance_records;
create policy maintenance_data_entry_update on public.fms_maintenance_records for update to authenticated
using (fms_private.current_role() in ('data_entry','super_admin') and fms_private.has_agency_access(agency_id))
with check (fms_private.current_role() in ('data_entry','super_admin') and fms_private.has_agency_access(agency_id));
drop policy if exists maintenance_documents_scoped_read on public.fms_maintenance_documents;
create policy maintenance_documents_scoped_read on public.fms_maintenance_documents for select to authenticated
using (exists (select 1 from public.fms_maintenance_records m where m.id = maintenance_id and fms_private.has_agency_access(m.agency_id)));
drop policy if exists maintenance_documents_data_entry_insert on public.fms_maintenance_documents;
create policy maintenance_documents_data_entry_insert on public.fms_maintenance_documents for insert to authenticated
with check (exists (select 1 from public.fms_maintenance_records m where m.id = maintenance_id and m.agency_id = fms_private.current_agency_id() and fms_private.current_role() in ('data_entry','super_admin')));

drop policy if exists notifications_recipient_read on public.fms_notifications;
create policy notifications_recipient_read on public.fms_notifications for select to authenticated
using (recipient_profile_id = (select auth.uid()) or fms_private.current_role() = 'super_admin');
drop policy if exists notifications_recipient_update on public.fms_notifications;
create policy notifications_recipient_update on public.fms_notifications for update to authenticated
using (recipient_profile_id = (select auth.uid()))
with check (recipient_profile_id = (select auth.uid()));

drop policy if exists audit_logs_scoped_read on public.fms_audit_logs;
create policy audit_logs_scoped_read on public.fms_audit_logs for select to authenticated
using (fms_private.current_role() = 'super_admin' or (fms_private.current_role() = 'fleet_manager' and agency_id = fms_private.current_agency_id()));

-- Grant only the SQL privileges required by the role-gated policies.
grant select on public.fms_agencies to anon, authenticated;
revoke insert, update on public.fms_profiles from anon, authenticated;
grant select on public.fms_profiles to authenticated;
grant update (full_name, phone, updated_at) on public.fms_profiles to authenticated;
grant select, insert on public.fms_vehicles to authenticated;
grant update (brand, model, vehicle_type, plate_number, seat_capacity, vehicle_status, remarks, updated_at) on public.fms_vehicles to authenticated;
grant select, insert on public.fms_drivers to authenticated;
grant update (full_name, email, phone, emergency_contact_name, emergency_contact_phone, account_status, availability_status, availability_start, availability_end, availability_remarks, licence_expiry, remarks, updated_at) on public.fms_drivers to authenticated;
grant select on public.fms_applications to authenticated;
grant update (status, decision_reason, decided_by, decided_at, updated_at) on public.fms_applications to authenticated;
grant select, insert on public.fms_assignments to authenticated;
grant select, insert, update on public.fms_fuel_transactions to authenticated;
grant select, insert, update on public.fms_maintenance_records to authenticated;
grant select, insert on public.fms_maintenance_documents to authenticated;
grant select, update on public.fms_notifications to authenticated;
grant select on public.fms_audit_logs to authenticated;

-- Public application creation and assignment decisions are performed by trusted functions.
revoke insert, update, delete on public.fms_applications from anon, authenticated;
grant select, update on public.fms_applications to authenticated;
revoke update, delete on public.fms_assignments from anon, authenticated;
revoke all on public.fms_public_submission_rate_limits from anon, authenticated;

-- Private document bucket. Public requests are processed by the Edge Function using the server key;
-- no anonymous bucket read or write policy is created.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fms-documents', 'fms-documents', false, 5242880, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['application/pdf','image/jpeg','image/png'];

drop policy if exists fms_private_document_read on storage.objects;
create policy fms_private_document_read on storage.objects for select to authenticated
using (
  bucket_id = 'fms-documents' and (
    (array_length(storage.foldername(name), 1) >= 1
      and (storage.foldername(name))[1] = fms_private.current_agency_id()::text
      and ((fms_private.current_role() in ('fleet_manager','data_entry'))
        or (fms_private.current_role() = 'driver' and (storage.foldername(name))[2] = 'fuel'
          and exists (select 1 from public.fms_drivers d where d.id::text = (storage.foldername(name))[3] and d.profile_id = (select auth.uid())))))
    or (fms_private.current_role() = 'super_admin' and (storage.foldername(name))[1] <> 'incoming')
    or exists (select 1 from public.fms_applications ap
      where ap.document_path = storage.objects.name and fms_private.has_agency_access(ap.agency_id))
    or exists (select 1 from public.fms_maintenance_documents md
      join public.fms_maintenance_records mr on mr.id = md.maintenance_id
      where md.file_path = storage.objects.name and fms_private.has_agency_access(mr.agency_id))
  )
);
drop policy if exists fms_agency_document_insert on storage.objects;
create policy fms_agency_document_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'fms-documents'
  and fms_private.current_role() in ('super_admin','fleet_manager','data_entry','driver')
  and (storage.foldername(name))[1] = fms_private.current_agency_id()::text
  and fms_private.has_agency_access(fms_private.current_agency_id())
  and (fms_private.current_role() <> 'driver' or ((storage.foldername(name))[2] = 'fuel' and exists (select 1 from public.fms_drivers d where d.id::text = (storage.foldername(name))[3] and d.profile_id = (select auth.uid()))))
);
drop policy if exists fms_agency_document_update on storage.objects;
create policy fms_agency_document_update on storage.objects for update to authenticated
using (bucket_id = 'fms-documents' and (storage.foldername(name))[1] = fms_private.current_agency_id()::text)
with check (bucket_id = 'fms-documents' and (storage.foldername(name))[1] = fms_private.current_agency_id()::text);

create or replace function public.fms_approve_vehicle(p_vehicle_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $
declare v_agency uuid; v_role text;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then raise exception 'Only a Fleet Manager or Super Admin can approve vehicles'; end if;
  select agency_id into v_agency from public.fms_vehicles where id = p_vehicle_id for update;
  if not found then raise exception 'Vehicle not found'; end if;
  if v_role <> 'super_admin' and v_agency <> fms_private.current_agency_id() then raise exception 'Agency access denied'; end if;
  update public.fms_vehicles set approval_status='approved', approved_by=(select auth.uid()), approved_at=now(), updated_at=now()
    where id=p_vehicle_id and approval_status in ('pending','returned');
  if not found then raise exception 'Vehicle is not awaiting approval'; end if;
  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id)
    values ((select auth.uid()),v_agency,'approve_vehicle','vehicle',p_vehicle_id);
  return jsonb_build_object('success',true,'vehicle_id',p_vehicle_id);
end;
$;

create or replace function public.fms_approve_driver(p_driver_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $
declare v_agency uuid; v_role text;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then raise exception 'Only a Fleet Manager or Super Admin can approve drivers'; end if;
  select agency_id into v_agency from public.fms_drivers where id = p_driver_id for update;
  if not found then raise exception 'Driver not found'; end if;
  if v_role <> 'super_admin' and v_agency <> fms_private.current_agency_id() then raise exception 'Agency access denied'; end if;
  update public.fms_drivers set approval_status='approved', approved_by=(select auth.uid()), approved_at=now(), updated_at=now()
    where id=p_driver_id and approval_status in ('pending','returned');
  if not found then raise exception 'Driver is not awaiting approval'; end if;
  if exists (select 1 from public.fms_profiles p join public.fms_drivers d on d.profile_id=p.id where d.id=p_driver_id) then
    update public.fms_profiles p set status='active',updated_at=now()
      where p.id=(select profile_id from public.fms_drivers where id=p_driver_id) and p.status='pending';
  end if;
  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id)
    values ((select auth.uid()),v_agency,'approve_driver','driver',p_driver_id);
  return jsonb_build_object('success',true,'driver_id',p_driver_id);
end;
$;

revoke all on function public.fms_approve_vehicle(uuid) from public, anon;
revoke all on function public.fms_approve_driver(uuid) from public, anon;
grant execute on function public.fms_approve_vehicle(uuid) to authenticated;
grant execute on function public.fms_approve_driver(uuid) to authenticated;

create or replace function public.fms_approve_assignment(p_assignment_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_agency uuid;
  v_application uuid;
  v_vehicle uuid;
  v_driver uuid;
  v_start date;
  v_end date;
  v_status text;
  v_role text;
  v_my_agency uuid;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  v_my_agency := fms_private.current_agency_id();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then raise exception 'Only a Fleet Manager or Super Admin can approve assignments'; end if;

  select a.agency_id, a.application_id, a.vehicle_id, a.driver_id, a.start_date, a.end_date, a.status
  into v_agency, v_application, v_vehicle, v_driver, v_start, v_end, v_status
  from public.fms_assignments a where a.id = p_assignment_id for update;
  if not found then raise exception 'Assignment not found'; end if;
  if v_role <> 'super_admin' and v_agency <> v_my_agency then raise exception 'Agency access denied'; end if;
  if v_status <> 'proposed' then raise exception 'Only proposed assignments can be approved'; end if;

  if not exists (select 1 from public.fms_vehicles v where v.id = v_vehicle and v.agency_id = v_agency and v.approval_status = 'approved' and v.vehicle_status = 'active') then
    raise exception 'Vehicle is not approved or available';
  end if;
  if not exists (select 1 from public.fms_drivers d where d.id = v_driver and d.agency_id = v_agency and d.approval_status = 'approved' and d.account_status = 'active') then
    raise exception 'Driver is not approved or active';
  end if;
  if exists (
    select 1 from public.fms_assignments other
    where other.id <> p_assignment_id and other.status = 'approved'
      and daterange(other.start_date, other.end_date, '[]') && daterange(v_start, v_end, '[]')
      and (other.vehicle_id = v_vehicle or other.driver_id = v_driver)
  ) then raise exception 'Vehicle or driver has an overlapping approved assignment'; end if;
  if exists (
    select 1 from public.fms_drivers d
    where d.id = v_driver and d.availability_status in ('on_leave','on_course','unavailable')
      and (d.availability_start is null or d.availability_end is null
        or daterange(d.availability_start,d.availability_end,'[]') && daterange(v_start,v_end,'[]'))
  ) then raise exception 'Driver is unavailable for the selected dates'; end if;

  update public.fms_assignments set status = 'approved', decided_by = (select auth.uid()), decided_at = now(), updated_at = now()
  where id = p_assignment_id;
  update public.fms_applications set status = 'approved', decided_by = (select auth.uid()), decided_at = now(), updated_at = now()
  where id = v_application;
  insert into public.fms_audit_logs(actor_profile_id, agency_id, action, entity_type, entity_id, details)
  values ((select auth.uid()), v_agency, 'approve_assignment', 'assignment', p_assignment_id, jsonb_build_object('application_id',v_application,'start_date',v_start,'end_date',v_end));
  return jsonb_build_object('success',true,'assignment_id',p_assignment_id,'application_id',v_application);
end;
$$;

create or replace function public.fms_reject_assignment(p_assignment_id uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_agency uuid;
  v_application uuid;
  v_status text;
  v_role text;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if coalesce(length(trim(p_reason)),0) < 3 then raise exception 'A rejection reason is required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then raise exception 'Only a Fleet Manager or Super Admin can reject assignments'; end if;
  select a.agency_id, a.application_id, a.status into v_agency, v_application, v_status
  from public.fms_assignments a where a.id = p_assignment_id for update;
  if not found then raise exception 'Assignment not found'; end if;
  if v_role <> 'super_admin' and v_agency <> fms_private.current_agency_id() then raise exception 'Agency access denied'; end if;
  if v_status <> 'proposed' then raise exception 'Only proposed assignments can be rejected'; end if;
  update public.fms_assignments set status='rejected', decision_reason=trim(p_reason), decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
  where id=p_assignment_id;
  update public.fms_applications set status='rejected', decision_reason=trim(p_reason), decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
  where id=v_application;
  insert into public.fms_audit_logs(actor_profile_id, agency_id, action, entity_type, entity_id, details)
  values ((select auth.uid()), v_agency, 'reject_assignment', 'assignment', p_assignment_id, jsonb_build_object('reason',trim(p_reason),'application_id',v_application));
  return jsonb_build_object('success',true,'assignment_id',p_assignment_id,'application_id',v_application);
end;
$$;

revoke all on function public.fms_approve_assignment(uuid) from public, anon;
revoke all on function public.fms_reject_assignment(uuid,text) from public, anon;
grant execute on function public.fms_approve_assignment(uuid) to authenticated;
grant execute on function public.fms_reject_assignment(uuid,text) to authenticated;

commit;