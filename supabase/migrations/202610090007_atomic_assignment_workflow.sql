begin;

-- These RPCs are the only supported way to transition applications/assignments.
CREATE OR REPLACE FUNCTION public.fms_propose_assignment(p_application_id uuid, p_vehicle_id uuid, p_driver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text;
  v_my_agency uuid;
  v_application record;
  v_vehicle record;
  v_driver record;
  v_assigned_count integer := 0;
  v_assigned_capacity integer := 0;
  v_new_status text;
  v_assignment_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  v_my_agency := fms_private.current_agency_id();
  if coalesce(v_role,'') not in ('data_entry','fleet_manager','super_admin') then
    raise exception 'Only authorized fleet staff can propose assignments';
  end if;

  select ap.id, ap.agency_id, ap.passenger_count, ap.vehicles_requested,
         ap.start_date, ap.end_date, ap.status
    into v_application
    from public.fms_applications ap
    where ap.id = p_application_id
    for update;
  if not found then raise exception 'Application not found'; end if;
  if v_role <> 'super_admin' and v_application.agency_id is distinct from v_my_agency then
    raise exception 'Agency access denied';
  end if;
  if v_application.status not in ('pending_assignment','returned_for_correction') then
    raise exception 'Only applications pending assignment or returned for correction can be assigned';
  end if;

  select count(*)::integer, coalesce(sum(v.seat_capacity),0)::integer
    into v_assigned_count, v_assigned_capacity
    from public.fms_assignments a
    join public.fms_vehicles v on v.id = a.vehicle_id
    where a.application_id = p_application_id
      and a.status in ('proposed','approved');

  if v_assigned_count >= v_application.vehicles_requested then
    raise exception 'The requested number of vehicles has already been assigned';
  end if;

  select v.id, v.agency_id, v.seat_capacity, v.approval_status, v.vehicle_status
    into v_vehicle
    from public.fms_vehicles v
    where v.id = p_vehicle_id
    for update;
  if not found or v_vehicle.agency_id is distinct from v_application.agency_id
     or v_vehicle.approval_status <> 'approved' or v_vehicle.vehicle_status <> 'active' then
    raise exception 'Vehicle is not approved, active or part of the requested agency';
  end if;

  select d.id, d.agency_id, d.approval_status, d.account_status, d.availability_status,
         d.availability_start, d.availability_end
    into v_driver
    from public.fms_drivers d
    where d.id = p_driver_id
    for update;
  if not found or v_driver.agency_id is distinct from v_application.agency_id
     or v_driver.approval_status <> 'approved' or v_driver.account_status <> 'active' then
    raise exception 'Driver is not approved, active or part of the requested agency';
  end if;

  if v_driver.availability_status in ('on_leave','on_course','unavailable')
     and (v_driver.availability_start is null or v_driver.availability_end is null
       or daterange(v_driver.availability_start,v_driver.availability_end,'[]')
          && daterange(v_application.start_date,v_application.end_date,'[]')) then
    raise exception 'Driver is unavailable for the selected dates';
  end if;

  if exists (
    select 1 from public.fms_assignments a
    where a.application_id = p_application_id
      and a.status in ('proposed','approved')
      and (a.vehicle_id = p_vehicle_id or a.driver_id = p_driver_id)
  ) then
    raise exception 'This vehicle or driver has already been selected for this application';
  end if;

  if exists (
    select 1 from public.fms_assignments other
    where other.application_id <> p_application_id
      and other.status in ('proposed','approved')
      and daterange(other.start_date,other.end_date,'[]')
          && daterange(v_application.start_date,v_application.end_date,'[]')
      and (other.vehicle_id = p_vehicle_id or other.driver_id = p_driver_id)
  ) then
    raise exception 'Vehicle or driver is reserved for another overlapping application';
  end if;

  if v_assigned_count + 1 = v_application.vehicles_requested
     and v_assigned_capacity + v_vehicle.seat_capacity < v_application.passenger_count then
    raise exception 'Selected vehicles do not have enough combined seating capacity for all passengers';
  end if;

  insert into public.fms_assignments(
    agency_id, application_id, vehicle_id, driver_id, start_date, end_date, status, submitted_by
  ) values (
    v_application.agency_id, p_application_id, p_vehicle_id, p_driver_id,
    v_application.start_date, v_application.end_date, 'proposed', (select auth.uid())
  ) returning id into v_assignment_id;

  v_new_status := case when v_assigned_count + 1 >= v_application.vehicles_requested
                       then 'pending_manager_approval' else 'pending_assignment' end;

  update public.fms_applications
    set status = v_new_status,
        decision_reason = null,
        decided_by = null,
        decided_at = null,
        updated_at = now()
    where id = p_application_id;

  insert into public.fms_audit_logs(actor_profile_id, agency_id, action, entity_type, entity_id, details)
  values ((select auth.uid()), v_application.agency_id, 'propose_assignment', 'assignment',
          v_assignment_id,
          jsonb_build_object('application_id',p_application_id,'submitted_count',v_assigned_count+1,
                             'requested_count',v_application.vehicles_requested,
                             'seat_capacity_total',v_assigned_capacity+v_vehicle.seat_capacity));

  return jsonb_build_object(
    'success',true,'assignment_id',v_assignment_id,'application_id',p_application_id,
    'assignments_submitted',v_assigned_count+1,'vehicles_requested',v_application.vehicles_requested,
    'application_status',v_new_status
  );
end;
$function$


CREATE OR REPLACE FUNCTION public.fms_approve_application(p_application_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text;
  v_my_agency uuid;
  v_application record;
  v_proposed_count integer;
  v_active_count integer;
  v_capacity integer;
  v_assignment_ids uuid[];
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  v_my_agency := fms_private.current_agency_id();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then
    raise exception 'Only a Fleet Manager or Super Admin can approve applications';
  end if;

  select ap.id, ap.agency_id, ap.passenger_count, ap.vehicles_requested, ap.start_date, ap.end_date, ap.status
    into v_application
    from public.fms_applications ap
    where ap.id = p_application_id
    for update;
  if not found then raise exception 'Application not found'; end if;
  if v_role <> 'super_admin' and v_application.agency_id is distinct from v_my_agency then
    raise exception 'Agency access denied';
  end if;
  if v_application.status <> 'pending_manager_approval' then
    raise exception 'Application is not waiting for Fleet Manager approval';
  end if;

  select count(*) filter (where a.status='proposed')::integer,
         count(*) filter (where a.status in ('proposed','approved'))::integer,
         coalesce(sum(v.seat_capacity) filter (where a.status in ('proposed','approved')),0)::integer,
         array_agg(a.id order by a.created_at)
    into v_proposed_count, v_active_count, v_capacity, v_assignment_ids
    from public.fms_assignments a
    join public.fms_vehicles v on v.id = a.vehicle_id
    where a.application_id = p_application_id;

  if v_proposed_count <> v_application.vehicles_requested or v_active_count <> v_application.vehicles_requested then
    raise exception 'Assign exactly the requested number of vehicles before approval';
  end if;
  if coalesce(v_capacity,0) < v_application.passenger_count then
    raise exception 'Combined vehicle seating capacity is insufficient for the passenger count';
  end if;

  if exists (
    select 1
    from public.fms_assignments a
    join public.fms_vehicles v on v.id = a.vehicle_id
    join public.fms_drivers d on d.id = a.driver_id
    where a.application_id = p_application_id and a.status = 'proposed'
      and (a.agency_id <> v_application.agency_id
        or v.agency_id <> v_application.agency_id
        or v.approval_status <> 'approved' or v.vehicle_status <> 'active'
        or d.agency_id <> v_application.agency_id
        or d.approval_status <> 'approved' or d.account_status <> 'active')
  ) then raise exception 'One or more proposed vehicles or drivers are no longer eligible'; end if;

  if exists (
    select 1
    from public.fms_assignments a
    join public.fms_drivers d on d.id = a.driver_id
    where a.application_id = p_application_id and a.status = 'proposed'
      and d.availability_status in ('on_leave','on_course','unavailable')
      and (d.availability_start is null or d.availability_end is null
        or daterange(d.availability_start,d.availability_end,'[]')
           && daterange(v_application.start_date,v_application.end_date,'[]'))
  ) then raise exception 'One or more selected drivers are unavailable for the travel dates'; end if;

  if exists (
    select 1
    from public.fms_assignments a
    join public.fms_assignments other on other.application_id <> p_application_id
    where a.application_id = p_application_id and a.status = 'proposed'
      and other.status in ('proposed','approved')
      and daterange(other.start_date,other.end_date,'[]')
          && daterange(a.start_date,a.end_date,'[]')
      and (other.vehicle_id = a.vehicle_id or other.driver_id = a.driver_id)
  ) then raise exception 'A selected vehicle or driver has another overlapping reservation'; end if;

  update public.fms_assignments
    set status='approved', decided_by=(select auth.uid()), decided_at=now(), decision_reason=null, updated_at=now()
    where application_id=p_application_id and status='proposed';

  update public.fms_applications
    set status='approved', decision_reason=null, decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
    where id=p_application_id;

  insert into public.fms_audit_logs(actor_profile_id, agency_id, action, entity_type, entity_id, details)
  values ((select auth.uid()),v_application.agency_id,'approve_application','application',p_application_id,
          jsonb_build_object('assignment_ids',v_assignment_ids,'vehicles_approved',v_application.vehicles_requested,
                             'passengers',v_application.passenger_count));

  return jsonb_build_object('success',true,'application_id',p_application_id,
                            'assignment_ids',to_jsonb(v_assignment_ids),
                            'application_approved',true);
end;
$function$


CREATE OR REPLACE FUNCTION public.fms_reject_application(p_application_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text;
  v_agency uuid;
  v_status text;
  v_assignment_ids uuid[];
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if coalesce(length(trim(p_reason)),0) < 3 then raise exception 'A rejection reason is required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then raise exception 'Only a Fleet Manager or Super Admin can reject applications'; end if;

  select ap.agency_id, ap.status into v_agency, v_status
  from public.fms_applications ap where ap.id=p_application_id for update;
  if not found then raise exception 'Application not found'; end if;
  if v_role <> 'super_admin' and v_agency is distinct from fms_private.current_agency_id() then raise exception 'Agency access denied'; end if;
  if v_status not in ('pending_assignment','pending_manager_approval','returned_for_correction') then
    raise exception 'Application cannot be rejected in its current state';
  end if;

  update public.fms_assignments
    set status='rejected', decision_reason=trim(p_reason), decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
    where application_id=p_application_id and status='proposed'
    returning id into v_assignment_ids;

  select array_agg(a.id order by a.created_at) into v_assignment_ids
  from public.fms_assignments a
  where a.application_id=p_application_id and a.status='rejected'
    and a.decided_by=(select auth.uid()) and a.decided_at >= now() - interval '5 seconds';

  update public.fms_applications
    set status='rejected', decision_reason=trim(p_reason), decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
    where id=p_application_id;

  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_agency,'reject_application','application',p_application_id,
          jsonb_build_object('reason',trim(p_reason),'assignment_ids',v_assignment_ids));

  return jsonb_build_object('success',true,'application_id',p_application_id,
                            'assignment_ids',to_jsonb(coalesce(v_assignment_ids,'{}'::uuid[])));
end;
$function$


CREATE OR REPLACE FUNCTION public.fms_return_application_for_correction(p_application_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text;
  v_agency uuid;
  v_status text;
  v_assignment_ids uuid[];
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if coalesce(length(trim(p_reason)),0) < 3 then raise exception 'Correction instructions are required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then raise exception 'Only a Fleet Manager or Super Admin can return applications'; end if;

  select ap.agency_id, ap.status into v_agency, v_status
  from public.fms_applications ap where ap.id=p_application_id for update;
  if not found then raise exception 'Application not found'; end if;
  if v_role <> 'super_admin' and v_agency is distinct from fms_private.current_agency_id() then raise exception 'Agency access denied'; end if;
  if v_status not in ('pending_assignment','pending_manager_approval','returned_for_correction') then
    raise exception 'Application cannot be returned in its current state';
  end if;

  update public.fms_assignments
    set status='rejected', decision_reason='Returned for correction: ' || trim(p_reason),
        decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
    where application_id=p_application_id and status='proposed';

  select array_agg(a.id order by a.created_at) into v_assignment_ids
  from public.fms_assignments a
  where a.application_id=p_application_id and a.status='rejected'
    and a.decided_by=(select auth.uid()) and a.decided_at >= now() - interval '5 seconds';

  update public.fms_applications
    set status='returned_for_correction', decision_reason=trim(p_reason),
        decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
    where id=p_application_id;

  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_agency,'return_application_for_correction','application',p_application_id,
          jsonb_build_object('reason',trim(p_reason),'assignment_ids',v_assignment_ids));

  return jsonb_build_object('success',true,'application_id',p_application_id,
                            'assignment_ids',to_jsonb(coalesce(v_assignment_ids,'{}'::uuid[])));
end;
$function$


-- Cancelling one assignment does not cancel sibling vehicles for a multi-vehicle request.
CREATE OR REPLACE FUNCTION public.fms_cancel_assignment(p_assignment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_agency uuid;
  v_application uuid;
  v_status text;
  v_role text;
  v_remaining integer;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if coalesce(length(trim(p_reason)),0) < 3 then raise exception 'A cancellation reason is required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then
    raise exception 'Only a Fleet Manager or Super Admin can cancel assignments';
  end if;

  select a.agency_id,a.application_id,a.status
    into v_agency,v_application,v_status
    from public.fms_assignments a where a.id=p_assignment_id for update;
  if not found then raise exception 'Assignment not found'; end if;
  if v_role <> 'super_admin' and v_agency is distinct from fms_private.current_agency_id() then
    raise exception 'Agency access denied';
  end if;
  if v_status <> 'approved' then raise exception 'Only approved assignments can be cancelled'; end if;

  update public.fms_assignments
    set status='cancelled',decision_reason=trim(p_reason),decided_by=(select auth.uid()),
        decided_at=now(),updated_at=now()
    where id=p_assignment_id;

  select count(*)::integer into v_remaining
    from public.fms_assignments a
    where a.application_id=v_application and a.status='approved';

  if v_remaining = 0 then
    update public.fms_applications
      set status='cancelled',decision_reason=trim(p_reason),decided_by=(select auth.uid()),
          decided_at=now(),updated_at=now()
      where id=v_application;
  end if;

  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_agency,'cancel_assignment','assignment',p_assignment_id,
          jsonb_build_object('reason',trim(p_reason),'application_id',v_application,
                             'remaining_approved_assignments',v_remaining));

  return jsonb_build_object('success',true,'assignment_id',p_assignment_id,
                            'application_id',v_application,'remaining_approved_assignments',v_remaining);
end;
$function$


revoke all on function public.fms_propose_assignment(uuid,uuid,uuid) from public, anon;
grant execute on function public.fms_propose_assignment(uuid,uuid,uuid) to authenticated;
revoke all on function public.fms_approve_application(uuid) from public, anon;
grant execute on function public.fms_approve_application(uuid) to authenticated;
revoke all on function public.fms_reject_application(uuid,text) from public, anon;
grant execute on function public.fms_reject_application(uuid,text) to authenticated;
revoke all on function public.fms_return_application_for_correction(uuid,text) from public, anon;
grant execute on function public.fms_return_application_for_correction(uuid,text) to authenticated;
revoke all on function public.fms_cancel_assignment(uuid,text) from public, anon;
grant execute on function public.fms_cancel_assignment(uuid,text) to authenticated;

drop policy if exists applications_data_entry_update on public.fms_applications;
drop policy if exists applications_manager_update on public.fms_applications;
drop policy if exists assignments_data_entry_insert on public.fms_assignments;
drop policy if exists vehicles_manager_approve on public.fms_vehicles;
drop policy if exists drivers_manager_approve on public.fms_drivers;

-- Prevent old single-assignment approval RPCs from bypassing application-level approval.
revoke all on function public.fms_approve_assignment(uuid) from public, anon, authenticated;
revoke all on function public.fms_reject_assignment(uuid,text) from public, anon, authenticated;

commit;
