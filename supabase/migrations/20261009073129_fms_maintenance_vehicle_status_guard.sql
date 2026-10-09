begin;

create or replace function public.fms_review_maintenance(
  p_maintenance_id uuid,
  p_decision text,
  p_reason text default null,
  p_actual_cost_rm numeric default null,
  p_workshop text default null,
  p_service_date date default null,
  p_next_service_due date default null,
  p_odometer_reading numeric default null,
  p_remarks text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_agency uuid;
  v_new_status text;
  v_maintenance record;
  v_vehicle_status text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  v_role := fms_private.current_role();
  v_agency := fms_private.current_agency_id();

  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then
    raise exception 'Only a Fleet Manager or Super Admin can review maintenance records';
  end if;

  select m.id,m.agency_id,m.vehicle_id,m.status
    into v_maintenance
    from public.fms_maintenance_records m
   where m.id=p_maintenance_id
   for update;

  if not found then raise exception 'Maintenance record not found'; end if;
  if v_role <> 'super_admin' and v_maintenance.agency_id is distinct from v_agency then
    raise exception 'Agency access denied';
  end if;
  if p_actual_cost_rm is not null and p_actual_cost_rm < 0 then
    raise exception 'Actual cost cannot be negative';
  end if;
  if p_odometer_reading is not null and p_odometer_reading < 0 then
    raise exception 'Odometer cannot be negative';
  end if;
  if p_next_service_due is not null and p_service_date is not null and p_next_service_due < p_service_date then
    raise exception 'Next service due cannot precede the service date';
  end if;

  if p_decision = 'approve' then
    if v_maintenance.status not in ('submitted','pending_approval') then
      raise exception 'Only submitted maintenance records can be approved';
    end if;

    select v.vehicle_status
      into v_vehicle_status
      from public.fms_vehicles v
     where v.id=v_maintenance.vehicle_id
       and v.agency_id=v_maintenance.agency_id
     for update;

    if not found then raise exception 'Associated vehicle not found in the same agency'; end if;
    if v_vehicle_status not in ('active','under_maintenance') then
      raise exception 'Only active or already-maintained vehicles can be placed into maintenance';
    end if;
    if exists (
      select 1
        from public.fms_maintenance_records other
       where other.vehicle_id=v_maintenance.vehicle_id
         and other.id<>p_maintenance_id
         and other.status='in_progress'
    ) then
      raise exception 'This vehicle already has another maintenance record in progress';
    end if;

    v_new_status := 'in_progress';
  elsif p_decision = 'reject' then
    if v_maintenance.status not in ('submitted','pending_approval') then
      raise exception 'Only submitted maintenance records can be rejected';
    end if;
    if coalesce(length(trim(p_reason)),0) < 3 then
      raise exception 'A rejection reason is required';
    end if;
    v_new_status := 'rejected';
  elsif p_decision = 'complete' then
    if v_maintenance.status <> 'in_progress' then
      raise exception 'Only in-progress maintenance can be completed';
    end if;
    if p_service_date is null then
      raise exception 'A service date is required to complete maintenance';
    end if;
    if p_next_service_due is not null and p_next_service_due < p_service_date then
      raise exception 'Next service due cannot precede the service date';
    end if;
    v_new_status := 'completed';
  else
    raise exception 'Unsupported maintenance decision';
  end if;

  update public.fms_maintenance_records
     set status=v_new_status,
         reviewed_by=(select auth.uid()),
         reviewed_at=now(),
         actual_cost_rm=coalesce(p_actual_cost_rm,actual_cost_rm),
         workshop=coalesce(nullif(trim(p_workshop),''),workshop),
         service_date=coalesce(p_service_date,service_date),
         next_service_due=coalesce(p_next_service_due,next_service_due),
         odometer_reading=coalesce(p_odometer_reading,odometer_reading),
         remarks=case
           when p_decision='reject' then concat_ws(E'\n',nullif(remarks,''),'Rejected by Fleet Manager: ' || trim(p_reason))
           when nullif(trim(p_remarks),'') is not null then concat_ws(E'\n',nullif(remarks,''),trim(p_remarks))
           else remarks
         end,
         updated_at=now()
   where id=p_maintenance_id;

  if p_decision='approve' then
    update public.fms_vehicles
       set vehicle_status='under_maintenance',updated_at=now()
     where id=v_maintenance.vehicle_id
       and agency_id=v_maintenance.agency_id
       and vehicle_status in ('active','under_maintenance');
  elsif p_decision='complete' then
    if not exists (
      select 1 from public.fms_maintenance_records other
       where other.vehicle_id=v_maintenance.vehicle_id
         and other.status='in_progress'
    ) then
      update public.fms_vehicles
         set vehicle_status='active',updated_at=now()
       where id=v_maintenance.vehicle_id
         and agency_id=v_maintenance.agency_id
         and vehicle_status='under_maintenance';
    end if;
  end if;

  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_maintenance.agency_id,'maintenance_' || p_decision,'maintenance',p_maintenance_id,
    jsonb_build_object(
      'previous_status',v_maintenance.status,
      'new_status',v_new_status,
      'vehicle_status',case when p_decision='approve' then 'under_maintenance' when p_decision='complete' then 'active_if_no_other_in_progress' else null end,
      'reason',nullif(trim(p_reason),'')
    ));

  return jsonb_build_object('success',true,'maintenance_id',p_maintenance_id,'status',v_new_status);
end;
$$;

revoke all on function public.fms_review_maintenance(uuid,text,text,numeric,text,date,date,numeric,text) from public;
grant execute on function public.fms_review_maintenance(uuid,text,text,numeric,text,date,date,numeric,text) to authenticated;

commit;
