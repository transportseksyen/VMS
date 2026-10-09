begin;

-- Prevent users from changing their own role, agency or active/suspended state.
drop policy if exists profiles_self_update on public.fms_profiles;

-- A driver can read only their own full driver record; a limited directory view is provided below.
drop policy if exists drivers_scoped_read on public.fms_drivers;
create policy drivers_scoped_read on public.fms_drivers for select to authenticated
using (
  fms_private.has_agency_access(agency_id)
  and (fms_private.current_role() <> 'driver' or profile_id = (select auth.uid()))
);

-- Scope driver self-service updates to active Driver accounts.
drop policy if exists drivers_self_availability on public.fms_drivers;
create policy drivers_self_availability on public.fms_drivers for update to authenticated
using (profile_id = (select auth.uid()) and fms_private.current_role() = 'driver')
with check (profile_id = (select auth.uid()) and fms_private.current_role() = 'driver');

-- Prevent drivers changing identity, agency, approval or account fields.
create or replace function fms_private.guard_driver_self_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $guard$
begin
  if fms_private.current_role() = 'driver' then
    if old.profile_id is distinct from (select auth.uid()) then
      raise exception 'A driver may update only their own driver record';
    end if;

    if (new.id, new.profile_id, new.agency_id, new.full_name, new.email, new.phone,
        new.emergency_contact_name, new.emergency_contact_phone, new.account_status,
        new.licence_expiry, new.approval_status, new.remarks, new.created_by,
        new.approved_by, new.approved_at, new.created_at)
       is distinct from
       (old.id, old.profile_id, old.agency_id, old.full_name, old.email, old.phone,
        old.emergency_contact_name, old.emergency_contact_phone, old.account_status,
        old.licence_expiry, old.approval_status, old.remarks, old.created_by,
        old.approved_by, old.approved_at, old.created_at) then
      raise exception 'Drivers may update availability and WhatsApp preference only';
    end if;

    new.updated_at := now();
  end if;
  return new;
end;
$guard$;

drop trigger if exists fms_guard_driver_self_update on public.fms_drivers;
create trigger fms_guard_driver_self_update
before update on public.fms_drivers
for each row execute function fms_private.guard_driver_self_update();

revoke all on function fms_private.guard_driver_self_update() from public, anon;
grant execute on function fms_private.guard_driver_self_update() to authenticated;

-- Driver-facing directory excludes contact and emergency contact information.
create or replace view public.fms_driver_directory
with (security_barrier = true)
as
select d.id, d.agency_id, d.full_name, d.availability_status,
       d.availability_start, d.availability_end, d.availability_remarks,
       d.licence_expiry, d.approval_status, d.account_status
from public.fms_drivers d
where
  fms_private.current_role() = 'super_admin'
  or (
    d.agency_id = fms_private.current_agency_id()
    and fms_private.current_role() in ('fleet_manager','data_entry')
  )
  or (
    d.agency_id = fms_private.current_agency_id()
    and fms_private.current_role() = 'driver'
    and (d.profile_id = (select auth.uid())
         or (d.approval_status = 'approved' and d.account_status = 'active'))
  );

revoke all on public.fms_driver_directory from public, anon;
grant select on public.fms_driver_directory to authenticated;

-- Fuel must belong to the signed-in Driver, same agency, approved vehicle and an
-- approved assignment covering the purchase date; reporting month must match.
drop policy if exists fuel_driver_insert on public.fms_fuel_transactions;
create policy fuel_driver_insert on public.fms_fuel_transactions for insert to authenticated
with check (
  fms_private.current_role() = 'driver'
  and agency_id = fms_private.current_agency_id()
  and status = 'submitted'
  and reporting_month = to_char(purchase_date, 'YYYY-MM')
  and exists (
    select 1 from public.fms_drivers d
    where d.id = fms_fuel_transactions.driver_id
      and d.profile_id = (select auth.uid())
      and d.agency_id = fms_fuel_transactions.agency_id
      and d.account_status = 'active'
      and d.approval_status = 'approved'
  )
  and exists (
    select 1 from public.fms_vehicles v
    where v.id = fms_fuel_transactions.vehicle_id
      and v.agency_id = fms_fuel_transactions.agency_id
      and v.approval_status = 'approved'
      and v.vehicle_status = 'active'
  )
  and exists (
    select 1 from public.fms_assignments a
    where a.driver_id = fms_fuel_transactions.driver_id
      and a.vehicle_id = fms_fuel_transactions.vehicle_id
      and a.agency_id = fms_fuel_transactions.agency_id
      and a.status = 'approved'
      and fms_fuel_transactions.purchase_date between a.start_date and a.end_date
  )
);

-- No client-side editing of notification delivery/audit status.
drop policy if exists notifications_recipient_update on public.fms_notifications;

-- Existing documents are immutable through the client; new uploads and signed reads remain.
drop policy if exists fms_agency_document_update on storage.objects;

-- Cover FMS foreign keys that did not have a suitable index.
create index if not exists fms_applications_decided_by_idx on public.fms_applications(decided_by);
create index if not exists fms_assignments_application_id_idx on public.fms_assignments(application_id);
create index if not exists fms_assignments_decided_by_idx on public.fms_assignments(decided_by);
create index if not exists fms_assignments_driver_id_idx on public.fms_assignments(driver_id);
create index if not exists fms_assignments_submitted_by_idx on public.fms_assignments(submitted_by);
create index if not exists fms_assignments_vehicle_id_idx on public.fms_assignments(vehicle_id);
create index if not exists fms_audit_logs_actor_profile_id_idx on public.fms_audit_logs(actor_profile_id);
create index if not exists fms_audit_logs_agency_id_idx on public.fms_audit_logs(agency_id);
create index if not exists fms_drivers_agency_id_idx on public.fms_drivers(agency_id);
create index if not exists fms_drivers_approved_by_idx on public.fms_drivers(approved_by);
create index if not exists fms_drivers_created_by_idx on public.fms_drivers(created_by);
create index if not exists fms_fuel_transactions_driver_id_idx on public.fms_fuel_transactions(driver_id);
create index if not exists fms_fuel_transactions_reviewed_by_idx on public.fms_fuel_transactions(reviewed_by);
create index if not exists fms_fuel_transactions_vehicle_id_idx on public.fms_fuel_transactions(vehicle_id);
create index if not exists fms_maintenance_documents_maintenance_id_idx on public.fms_maintenance_documents(maintenance_id);
create index if not exists fms_maintenance_documents_uploaded_by_idx on public.fms_maintenance_documents(uploaded_by);
create index if not exists fms_maintenance_records_agency_id_idx on public.fms_maintenance_records(agency_id);
create index if not exists fms_maintenance_records_created_by_idx on public.fms_maintenance_records(created_by);
create index if not exists fms_maintenance_records_reviewed_by_idx on public.fms_maintenance_records(reviewed_by);
create index if not exists fms_notifications_recipient_profile_id_idx on public.fms_notifications(recipient_profile_id);
create index if not exists fms_profiles_agency_id_idx on public.fms_profiles(agency_id);
create index if not exists fms_vehicles_approved_by_idx on public.fms_vehicles(approved_by);
create index if not exists fms_vehicles_created_by_idx on public.fms_vehicles(created_by);

commit;
