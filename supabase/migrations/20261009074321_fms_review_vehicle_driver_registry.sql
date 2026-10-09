begin;

alter table public.fms_vehicles add column if not exists decision_reason text;
alter table public.fms_drivers add column if not exists decision_reason text;

create or replace function public.fms_review_registry_record(
  p_entity_type text,
  p_entity_id uuid,
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
  v_record_agency uuid;
  v_status text;
  v_creator uuid;
  v_reason text;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  v_agency := fms_private.current_agency_id();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then
    raise exception 'Only a Fleet Manager or Super Admin can review vehicle or driver registrations';
  end if;
  if p_entity_type not in ('vehicle','driver') then raise exception 'Unsupported registry entity'; end if;
  if p_decision not in ('approve','reject','return') then raise exception 'Unsupported registry decision'; end if;
  v_reason := nullif(trim(p_reason),'');
  if p_decision in ('reject','return') and coalesce(length(v_reason),0) < 3 then
    raise exception 'A rejection reason or correction instruction is required';
  end if;

  if p_entity_type='vehicle' then
    select agency_id,approval_status,created_by into v_record_agency,v_status,v_creator
      from public.fms_vehicles where id=p_entity_id for update;
  else
    select agency_id,approval_status,created_by into v_record_agency,v_status,v_creator
      from public.fms_drivers where id=p_entity_id for update;
  end if;

  if not found then raise exception 'Registry record not found'; end if;
  if v_role <> 'super_admin' and v_record_agency is distinct from v_agency then raise exception 'Agency access denied'; end if;
  if v_status not in ('pending','returned') then raise exception 'Only pending or returned records can be reviewed'; end if;
  if p_decision='approve' and v_role='fleet_manager' and v_creator=(select auth.uid()) then
    raise exception 'A Fleet Manager cannot approve their own registry submission';
  end if;

  if p_entity_type='vehicle' then
    update public.fms_vehicles set
      approval_status=case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned' end,
      approved_by=case when p_decision='approve' then (select auth.uid()) else null end,
      approved_at=case when p_decision='approve' then now() else null end,
      decision_reason=case when p_decision='approve' then null else v_reason end,
      updated_at=now()
    where id=p_entity_id;
  else
    update public.fms_drivers set
      approval_status=case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned' end,
      approved_by=case when p_decision='approve' then (select auth.uid()) else null end,
      approved_at=case when p_decision='approve' then now() else null end,
      decision_reason=case when p_decision='approve' then null else v_reason end,
      updated_at=now()
    where id=p_entity_id;
  end if;

  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_record_agency,'registry_' || p_decision,p_entity_type,p_entity_id,
    jsonb_build_object('previous_status',v_status,'new_status',
      case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned' end,
      'reason',v_reason));

  return jsonb_build_object('success',true,'entity_type',p_entity_type,'entity_id',p_entity_id,
    'status',case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned' end,
    'created_by',v_creator,'agency_id',v_record_agency);
end;
$$;

revoke all on function public.fms_review_registry_record(text,uuid,text,text) from public;
grant execute on function public.fms_review_registry_record(text,uuid,text,text) to authenticated;

commit;
