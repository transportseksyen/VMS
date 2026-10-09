begin;

create table if not exists public.fms_registry_change_requests (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.fms_agencies(id) on delete restrict,
  entity_type text not null check (entity_type in ('vehicle','driver')),
  entity_id uuid not null,
  proposed_changes jsonb not null check (jsonb_typeof(proposed_changes) = 'object' and proposed_changes <> '{}'::jsonb),
  reason text not null check (length(trim(reason)) >= 3),
  status text not null default 'pending' check (status in ('pending','approved','rejected','returned')),
  submitted_by uuid not null references public.fms_profiles(id) on delete restrict,
  reviewed_by uuid references public.fms_profiles(id) on delete set null,
  reviewed_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fms_registry_change_requests_agency_status_idx
  on public.fms_registry_change_requests(agency_id,status,created_at desc);
create index if not exists fms_registry_change_requests_entity_idx
  on public.fms_registry_change_requests(entity_type,entity_id,created_at desc);
create index if not exists fms_registry_change_requests_submitter_idx
  on public.fms_registry_change_requests(submitted_by);

alter table public.fms_registry_change_requests enable row level security;
drop policy if exists fms_registry_change_requests_staff_read on public.fms_registry_change_requests;
create policy fms_registry_change_requests_staff_read
  on public.fms_registry_change_requests for select to authenticated
  using (
    fms_private.current_role() in ('data_entry','fleet_manager','super_admin')
    and fms_private.has_agency_access(agency_id)
  );
drop policy if exists fms_registry_change_requests_staff_insert on public.fms_registry_change_requests;
create policy fms_registry_change_requests_staff_insert
  on public.fms_registry_change_requests for insert to authenticated
  with check (
    submitted_by = (select auth.uid())
    and fms_private.current_role() in ('data_entry','fleet_manager','super_admin')
    and fms_private.has_agency_access(agency_id)
  );
revoke all on public.fms_registry_change_requests from anon, authenticated;
grant select, insert on public.fms_registry_change_requests to authenticated;

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
  if coalesce(length(trim(p_reason)),0) < 3 then raise exception 'A reason for the change is required'; end if;
  if exists (select 1 from jsonb_each(p_changes) e where jsonb_typeof(e.value) not in ('string','number','null','boolean')) then
    raise exception 'Change values must be simple text, number or null values';
  end if;

  if p_entity_type = 'vehicle' then
    if (p_changes - array['brand','model','vehicle_type','plate_number','seat_capacity','mileage_km','insurance_expiry','road_tax_expiry','inspection_date','next_service_due','remarks']::text[]) <> '{}'::jsonb then
      raise exception 'One or more vehicle fields are not editable';
    end if;
    select agency_id,approval_status into v_entity_agency,v_approval_status
      from public.fms_vehicles where id=p_entity_id for update;
  else
    if (p_changes - array['full_name','email','phone','emergency_contact_name','emergency_contact_phone']::text[]) <> '{}'::jsonb then
      raise exception 'One or more driver fields are not editable';
    end if;
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

create or replace function public.fms_review_registry_change(
  p_change_request_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_agency uuid;
  v_request record;
  v_changes jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  v_agency := fms_private.current_agency_id();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then
    raise exception 'Only a Fleet Manager or Super Admin can review registry changes';
  end if;
  if p_decision not in ('approve','reject','return') then raise exception 'Unsupported registry change decision'; end if;
  if p_decision in ('reject','return') and coalesce(length(trim(p_reason)),0) < 3 then
    raise exception 'A reason or correction instruction is required';
  end if;

  select r.* into v_request
    from public.fms_registry_change_requests r
   where r.id=p_change_request_id
   for update;
  if not found then raise exception 'Registry change request not found'; end if;
  if v_role <> 'super_admin' and v_request.agency_id is distinct from v_agency then raise exception 'Agency access denied'; end if;
  if v_role = 'fleet_manager' and v_request.submitted_by = (select auth.uid()) then
    raise exception 'A Fleet Manager cannot review their own registry change submission';
  end if;
  if v_request.status <> 'pending' then raise exception 'Only pending registry changes can be reviewed'; end if;

  v_changes := v_request.proposed_changes;
  if p_decision='approve' then
    if v_request.entity_type='vehicle' then
      if (v_changes - array['brand','model','vehicle_type','plate_number','seat_capacity','mileage_km','insurance_expiry','road_tax_expiry','inspection_date','next_service_due','remarks']::text[]) <> '{}'::jsonb then raise exception 'Invalid vehicle change payload'; end if;
      update public.fms_vehicles set
        brand=case when v_changes ? 'brand' then v_changes->>'brand' else brand end,
        model=case when v_changes ? 'model' then v_changes->>'model' else model end,
        vehicle_type=case when v_changes ? 'vehicle_type' then v_changes->>'vehicle_type' else vehicle_type end,
        plate_number=case when v_changes ? 'plate_number' then upper(trim(v_changes->>'plate_number')) else plate_number end,
        seat_capacity=case when v_changes ? 'seat_capacity' then (v_changes->>'seat_capacity')::integer else seat_capacity end,
        mileage_km=case when v_changes ? 'mileage_km' then (v_changes->>'mileage_km')::numeric else mileage_km end,
        insurance_expiry=case when v_changes ? 'insurance_expiry' then (v_changes->>'insurance_expiry')::date else insurance_expiry end,
        road_tax_expiry=case when v_changes ? 'road_tax_expiry' then (v_changes->>'road_tax_expiry')::date else road_tax_expiry end,
        inspection_date=case when v_changes ? 'inspection_date' then (v_changes->>'inspection_date')::date else inspection_date end,
        next_service_due=case when v_changes ? 'next_service_due' then (v_changes->>'next_service_due')::date else next_service_due end,
        remarks=case when v_changes ? 'remarks' then v_changes->>'remarks' else remarks end,
        updated_at=now()
      where id=v_request.entity_id and agency_id=v_request.agency_id and approval_status='approved';
      if not found then raise exception 'Approved vehicle record could not be updated'; end if;
    else
      if (v_changes - array['full_name','email','phone','emergency_contact_name','emergency_contact_phone']::text[]) <> '{}'::jsonb then raise exception 'Invalid driver change payload'; end if;
      update public.fms_drivers set
        full_name=case when v_changes ? 'full_name' then v_changes->>'full_name' else full_name end,
        email=case when v_changes ? 'email' then lower(trim(v_changes->>'email')) else email end,
        phone=case when v_changes ? 'phone' then v_changes->>'phone' else phone end,
        emergency_contact_name=case when v_changes ? 'emergency_contact_name' then v_changes->>'emergency_contact_name' else emergency_contact_name end,
        emergency_contact_phone=case when v_changes ? 'emergency_contact_phone' then v_changes->>'emergency_contact_phone' else emergency_contact_phone end,
        updated_at=now()
      where id=v_request.entity_id and agency_id=v_request.agency_id and approval_status='approved';
      if not found then raise exception 'Approved driver record could not be updated'; end if;
    end if;
  end if;

  update public.fms_registry_change_requests set
    status=case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned' end,
    reviewed_by=(select auth.uid()), reviewed_at=now(),
    decision_reason=case when p_decision='approve' then null else trim(p_reason) end,
    updated_at=now()
  where id=p_change_request_id;

  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_request.agency_id,'registry_change_' || p_decision,v_request.entity_type,v_request.entity_id,
    jsonb_build_object('request_id',p_change_request_id,'previous_status',v_request.status,'new_status',
      case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned' end,
      'reason',nullif(trim(p_reason),''),'proposed_changes',v_changes));

  insert into public.fms_notifications(
    recipient_profile_id,recipient_email,subject,body,notification_type,related_table,related_record_id,email_status
  )
  select p.id,p.email,
    'FMS ' || initcap(v_request.entity_type) || ' change ' || case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned for correction' end,
    'Your ' || v_request.entity_type || ' change request was ' || case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned for correction' end ||
    case when nullif(trim(p_reason),'') is not null then '. Remarks: ' || trim(p_reason) else '.' end,
    'registry_change_' || p_decision,'fms_registry_change_requests',p_change_request_id,'pending'
  from public.fms_profiles p
  where p.id=v_request.submitted_by;

  return jsonb_build_object('success',true,'request_id',p_change_request_id,
    'status',case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned' end);
end;
$$;

revoke all on function public.fms_submit_registry_change(text,uuid,jsonb,text) from public;
revoke all on function public.fms_review_registry_change(uuid,text,text) from public;
grant execute on function public.fms_submit_registry_change(text,uuid,jsonb,text) to authenticated;
grant execute on function public.fms_review_registry_change(uuid,text,text) to authenticated;

commit;
