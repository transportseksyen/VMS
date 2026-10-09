begin;

revoke insert on public.fms_registry_change_requests from authenticated;
revoke insert on public.fms_registry_change_requests from anon;

create or replace function public.fms_submit_registry_change(
  p_entity_type text,
  p_entity_id uuid,
  p_changes jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_agency uuid;
  v_entity_agency uuid;
  v_approval_status text;
  v_request_id uuid;
  v_value numeric;
  v_email text;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  v_agency := fms_private.current_agency_id();
  if coalesce(v_role,'') not in ('data_entry','fleet_manager','super_admin') then
    raise exception 'Only authorized fleet staff can submit registry changes';
  end if;
  if p_entity_type not in ('vehicle','driver') then raise exception 'Unsupported registry entity'; end if;
  if jsonb_typeof(p_changes) is distinct from 'object' or p_changes = '{}'::jsonb then
    raise exception 'Provide at least one proposed field change';
  end if;
  if coalesce(length(trim(p_reason)),0) < 3 or length(trim(p_reason)) > 1500 then
    raise exception 'A reason between 3 and 1500 characters is required';
  end if;
  if exists (select 1 from jsonb_each(p_changes) e where jsonb_typeof(e.value) not in ('string','number','null','boolean')) then
    raise exception 'Change values must be simple text, number or null values';
  end if;

  if p_entity_type = 'vehicle' then
    if (p_changes - array['brand','model','vehicle_type','plate_number','seat_capacity','mileage_km','insurance_expiry','road_tax_expiry','inspection_date','next_service_due','remarks']::text[]) <> '{}'::jsonb then
      raise exception 'One or more vehicle fields are not editable';
    end if;
    if p_changes ? 'brand' and (nullif(trim(p_changes->>'brand'),'') is null or length(p_changes->>'brand') > 120) then raise exception 'Vehicle brand is required and must be 120 characters or fewer'; end if;
    if p_changes ? 'model' and (nullif(trim(p_changes->>'model'),'') is null or length(p_changes->>'model') > 120) then raise exception 'Vehicle model is required and must be 120 characters or fewer'; end if;
    if p_changes ? 'vehicle_type' and (nullif(trim(p_changes->>'vehicle_type'),'') is null or length(p_changes->>'vehicle_type') > 80) then raise exception 'Vehicle type is required and must be 80 characters or fewer'; end if;
    if p_changes ? 'plate_number' and (nullif(trim(p_changes->>'plate_number'),'') is null or length(p_changes->>'plate_number') > 30) then raise exception 'Registration number is required and must be 30 characters or fewer'; end if;
    if p_changes ? 'seat_capacity' then
      v_value := nullif(p_changes->>'seat_capacity','')::numeric;
      if v_value is null or v_value < 1 or v_value > 100 or trunc(v_value) <> v_value then raise exception 'Seat capacity must be a whole number between 1 and 100'; end if;
    end if;
    if p_changes ? 'mileage_km' then
      v_value := nullif(p_changes->>'mileage_km','')::numeric;
      if v_value is null or v_value < 0 or v_value > 10000000 then raise exception 'Mileage must be between 0 and 10000000 km'; end if;
    end if;
    if p_changes ? 'insurance_expiry' and nullif(p_changes->>'insurance_expiry','') is not null then perform (p_changes->>'insurance_expiry')::date; end if;
    if p_changes ? 'road_tax_expiry' and nullif(p_changes->>'road_tax_expiry','') is not null then perform (p_changes->>'road_tax_expiry')::date; end if;
    if p_changes ? 'inspection_date' and nullif(p_changes->>'inspection_date','') is not null then perform (p_changes->>'inspection_date')::date; end if;
    if p_changes ? 'next_service_due' and nullif(p_changes->>'next_service_due','') is not null then perform (p_changes->>'next_service_due')::date; end if;
    if p_changes ? 'remarks' and length(coalesce(p_changes->>'remarks','')) > 2000 then raise exception 'Remarks must be 2000 characters or fewer'; end if;
    select agency_id,approval_status into v_entity_agency,v_approval_status
      from public.fms_vehicles where id=p_entity_id for update;
  else
    if (p_changes - array['full_name','email','phone','emergency_contact_name','emergency_contact_phone']::text[]) <> '{}'::jsonb then
      raise exception 'One or more driver fields are not editable';
    end if;
    if p_changes ? 'full_name' and (nullif(trim(p_changes->>'full_name'),'') is null or length(p_changes->>'full_name') > 150) then raise exception 'Driver name is required and must be 150 characters or fewer'; end if;
    if p_changes ? 'email' then
      v_email := lower(trim(coalesce(p_changes->>'email','')));
      if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 254 then raise exception 'A valid email address is required'; end if;
    end if;
    if p_changes ? 'phone' and length(coalesce(p_changes->>'phone','')) > 40 then raise exception 'Phone number must be 40 characters or fewer'; end if;
    if p_changes ? 'emergency_contact_name' and length(coalesce(p_changes->>'emergency_contact_name','')) > 150 then raise exception 'Emergency contact name must be 150 characters or fewer'; end if;
    if p_changes ? 'emergency_contact_phone' and length(coalesce(p_changes->>'emergency_contact_phone','')) > 40 then raise exception 'Emergency contact phone must be 40 characters or fewer'; end if;
    select agency_id,approval_status into v_entity_agency,v_approval_status
      from public.fms_drivers where id=p_entity_id for update;
  end if;

  if not found then raise exception 'Registry record not found'; end if;
  if v_role <> 'super_admin' and v_entity_agency is distinct from v_agency then raise exception 'Agency access denied'; end if;
  if v_approval_status <> 'approved' then raise exception 'Only approved registry records use the change-request workflow'; end if;

  insert into public.fms_registry_change_requests(
    agency_id,entity_type,entity_id,proposed_changes,reason,submitted_by,status
  ) values (
    v_entity_agency,p_entity_type,p_entity_id,p_changes,trim(p_reason),(select auth.uid()),'pending'
  ) returning id into v_request_id;

  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_entity_agency,'submit_registry_change',p_entity_type,p_entity_id,
    jsonb_build_object('request_id',v_request_id,'proposed_changes',p_changes,'reason',trim(p_reason)));

  return jsonb_build_object('success',true,'request_id',v_request_id,'status','pending');
end;
$$;

revoke all on function public.fms_submit_registry_change(text,uuid,jsonb,text) from public;
grant execute on function public.fms_submit_registry_change(text,uuid,jsonb,text) to authenticated;

commit;