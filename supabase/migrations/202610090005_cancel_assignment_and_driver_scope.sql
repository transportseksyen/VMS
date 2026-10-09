begin;

-- Drivers should see only assignments assigned to their own driver profile.
drop policy if exists assignments_scoped_read on public.fms_assignments;
create policy assignments_scoped_read on public.fms_assignments for select to authenticated
using (
  (fms_private.current_role() in ('super_admin','fleet_manager','data_entry')
    and fms_private.has_agency_access(agency_id))
  or (fms_private.current_role() = 'driver' and exists (
    select 1 from public.fms_drivers d
    where d.id = fms_assignments.driver_id and d.profile_id = (select auth.uid())
  ))
);

create or replace function public.fms_cancel_assignment(p_assignment_id uuid, p_reason text)
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
  if coalesce(length(trim(p_reason)),0) < 3 then raise exception 'A cancellation reason is required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then
    raise exception 'Only a Fleet Manager or Super Admin can cancel assignments';
  end if;

  select a.agency_id, a.application_id, a.status
    into v_agency, v_application, v_status
    from public.fms_assignments a
    where a.id = p_assignment_id
    for update;
  if not found then raise exception 'Assignment not found'; end if;
  if v_role <> 'super_admin' and v_agency <> fms_private.current_agency_id() then
    raise exception 'Agency access denied';
  end if;
  if v_status <> 'approved' then raise exception 'Only approved assignments can be cancelled'; end if;

  update public.fms_assignments
    set status = 'cancelled', decision_reason = trim(p_reason),
        decided_by = (select auth.uid()), decided_at = now(), updated_at = now()
    where id = p_assignment_id;
  update public.fms_applications
    set status = 'cancelled', decision_reason = trim(p_reason),
        decided_by = (select auth.uid()), decided_at = now(), updated_at = now()
    where id = v_application;

  insert into public.fms_audit_logs(actor_profile_id, agency_id, action, entity_type, entity_id, details)
  values ((select auth.uid()), v_agency, 'cancel_assignment', 'assignment', p_assignment_id,
          jsonb_build_object('reason',trim(p_reason),'application_id',v_application));
  return jsonb_build_object('success',true,'assignment_id',p_assignment_id,'application_id',v_application);
end;
$$;

revoke all on function public.fms_cancel_assignment(uuid,text) from public, anon;
grant execute on function public.fms_cancel_assignment(uuid,text) to authenticated;

commit;