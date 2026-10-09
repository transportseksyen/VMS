begin;
create or replace function public.fms_reject_application(p_application_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_agency uuid;
  v_status text;
  v_assignment_ids uuid[];
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if coalesce(length(trim(p_reason)),0) < 3 then raise exception 'A rejection reason is required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then
    raise exception 'Only a Fleet Manager or Super Admin can reject applications';
  end if;
  select ap.agency_id, ap.status into v_agency, v_status
  from public.fms_applications ap where ap.id = p_application_id for update;
  if not found then raise exception 'Application not found'; end if;
  if v_role <> 'super_admin' and v_agency is distinct from fms_private.current_agency_id() then
    raise exception 'Agency access denied';
  end if;
  if v_status not in ('pending_assignment','pending_manager_approval','returned_for_correction') then
    raise exception 'Application cannot be rejected in its current state';
  end if;
  update public.fms_assignments
    set status='rejected', decision_reason=trim(p_reason),
        decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
    where application_id=p_application_id and status='proposed';
  select array_agg(a.id order by a.created_at) into v_assignment_ids
  from public.fms_assignments a
  where a.application_id=p_application_id and a.status='rejected'
    and a.decided_by=(select auth.uid()) and a.decided_at >= now() - interval '5 seconds';
  update public.fms_applications
    set status='rejected', decision_reason=trim(p_reason),
        decided_by=(select auth.uid()), decided_at=now(), updated_at=now()
    where id=p_application_id;
  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_agency,'reject_application','application',p_application_id,
          jsonb_build_object('reason',trim(p_reason),'assignment_ids',v_assignment_ids));
  return jsonb_build_object('success',true,'application_id',p_application_id,
                            'assignment_ids',to_jsonb(coalesce(v_assignment_ids,'{}'::uuid[])));
end;
$function$;
revoke all on function public.fms_reject_application(uuid,text) from public, anon;
grant execute on function public.fms_reject_application(uuid,text) to authenticated;
commit;