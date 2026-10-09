begin;

create or replace function fms_private.prevent_fleet_manager_self_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if fms_private.current_role() is distinct from 'fleet_manager' then
    return new;
  end if;

  v_actor := (select auth.uid());
  if v_actor is null then
    return new;
  end if;

  if tg_table_name = 'fms_assignments' then
    if old.status = 'proposed' and new.status = 'approved' and old.submitted_by = v_actor then
      raise exception 'A Fleet Manager cannot approve their own proposed assignment';
    end if;
  elsif tg_table_name in ('fms_vehicles','fms_drivers') then
    if old.approval_status in ('pending','returned')
       and new.approval_status = 'approved'
       and old.created_by = v_actor then
      raise exception 'A Fleet Manager cannot approve their own vehicle or driver submission';
    end if;
  elsif tg_table_name = 'fms_maintenance_records' then
    if old.status in ('submitted','pending_approval')
       and new.status = 'in_progress'
       and old.created_by = v_actor then
      raise exception 'A Fleet Manager cannot approve their own maintenance submission';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function fms_private.prevent_fleet_manager_self_approval() from public, anon, authenticated;

drop trigger if exists fms_no_self_approve_vehicle on public.fms_vehicles;
create trigger fms_no_self_approve_vehicle
before update of approval_status on public.fms_vehicles
for each row execute function fms_private.prevent_fleet_manager_self_approval();

drop trigger if exists fms_no_self_approve_driver on public.fms_drivers;
create trigger fms_no_self_approve_driver
before update of approval_status on public.fms_drivers
for each row execute function fms_private.prevent_fleet_manager_self_approval();

drop trigger if exists fms_no_self_approve_assignment on public.fms_assignments;
create trigger fms_no_self_approve_assignment
before update of status on public.fms_assignments
for each row execute function fms_private.prevent_fleet_manager_self_approval();

drop trigger if exists fms_no_self_approve_maintenance on public.fms_maintenance_records;
create trigger fms_no_self_approve_maintenance
before update of status on public.fms_maintenance_records
for each row execute function fms_private.prevent_fleet_manager_self_approval();

commit;
