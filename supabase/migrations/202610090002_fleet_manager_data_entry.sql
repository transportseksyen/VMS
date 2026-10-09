begin;

-- Fleet Managers may perform Data Entry tasks inside their own agency.
drop policy if exists vehicles_data_entry_insert on public.fms_vehicles;
create policy vehicles_data_entry_insert on public.fms_vehicles for insert to authenticated
with check (
  fms_private.current_role() = 'super_admin'
  or (fms_private.current_role() in ('data_entry','fleet_manager')
      and agency_id = fms_private.current_agency_id()
      and approval_status = 'pending')
);

drop policy if exists vehicles_data_entry_update_pending on public.fms_vehicles;
create policy vehicles_data_entry_update_pending on public.fms_vehicles for update to authenticated
using (fms_private.current_role() in ('data_entry','fleet_manager')
       and agency_id = fms_private.current_agency_id()
       and approval_status in ('pending','returned'))
with check (fms_private.current_role() in ('data_entry','fleet_manager')
            and agency_id = fms_private.current_agency_id()
            and approval_status in ('pending','returned'));

drop policy if exists drivers_data_entry_insert on public.fms_drivers;
create policy drivers_data_entry_insert on public.fms_drivers for insert to authenticated
with check (
  fms_private.current_role() = 'super_admin'
  or (fms_private.current_role() in ('data_entry','fleet_manager')
      and agency_id = fms_private.current_agency_id()
      and approval_status = 'pending')
);

drop policy if exists drivers_data_entry_update_pending on public.fms_drivers;
create policy drivers_data_entry_update_pending on public.fms_drivers for update to authenticated
using (fms_private.current_role() in ('data_entry','fleet_manager')
       and agency_id = fms_private.current_agency_id()
       and approval_status in ('pending','returned'))
with check (fms_private.current_role() in ('data_entry','fleet_manager')
            and agency_id = fms_private.current_agency_id()
            and approval_status in ('pending','returned'));

drop policy if exists applications_data_entry_update on public.fms_applications;
create policy applications_data_entry_update on public.fms_applications for update to authenticated
using (fms_private.current_role() in ('data_entry','fleet_manager','super_admin')
       and fms_private.has_agency_access(agency_id))
with check (
  fms_private.current_role() = 'super_admin'
  or (fms_private.current_role() in ('data_entry','fleet_manager')
      and agency_id = fms_private.current_agency_id()
      and status in ('pending_assignment','pending_manager_approval','returned_for_correction'))
);

drop policy if exists assignments_data_entry_insert on public.fms_assignments;
create policy assignments_data_entry_insert on public.fms_assignments for insert to authenticated
with check (
  (fms_private.current_role() = 'super_admin' or agency_id = fms_private.current_agency_id())
  and fms_private.current_role() in ('data_entry','fleet_manager','super_admin')
  and status = 'proposed'
  and exists (
    select 1 from public.fms_applications ap
    where ap.id = application_id and ap.agency_id = fms_assignments.agency_id
      and ap.status in ('pending_assignment','returned_for_correction')
  )
  and exists (
    select 1 from public.fms_vehicles v
    where v.id = vehicle_id and v.agency_id = fms_assignments.agency_id
      and v.approval_status = 'approved' and v.vehicle_status = 'active'
  )
  and exists (
    select 1 from public.fms_drivers d
    where d.id = driver_id and d.agency_id = fms_assignments.agency_id
      and d.approval_status = 'approved' and d.account_status = 'active'
  )
);

drop policy if exists maintenance_data_entry_insert on public.fms_maintenance_records;
create policy maintenance_data_entry_insert on public.fms_maintenance_records for insert to authenticated
with check (fms_private.current_role() = 'super_admin'
  or (agency_id = fms_private.current_agency_id()
      and fms_private.current_role() in ('data_entry','fleet_manager')));

drop policy if exists maintenance_data_entry_update on public.fms_maintenance_records;
create policy maintenance_data_entry_update on public.fms_maintenance_records for update to authenticated
using (fms_private.current_role() in ('data_entry','fleet_manager','super_admin')
       and fms_private.has_agency_access(agency_id))
with check (fms_private.current_role() in ('data_entry','fleet_manager','super_admin')
            and fms_private.has_agency_access(agency_id));

drop policy if exists maintenance_documents_data_entry_insert on public.fms_maintenance_documents;
create policy maintenance_documents_data_entry_insert on public.fms_maintenance_documents for insert to authenticated
with check (
  exists (
    select 1 from public.fms_maintenance_records m
    where m.id = maintenance_id
      and (fms_private.current_role() = 'super_admin'
        or (m.agency_id = fms_private.current_agency_id()
          and fms_private.current_role() in ('data_entry','fleet_manager')))
  )
);

commit;