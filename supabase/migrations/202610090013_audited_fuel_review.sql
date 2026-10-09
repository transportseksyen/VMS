begin;
drop policy if exists fuel_manager_review on public.fms_fuel_transactions;

create or replace function public.fms_review_fuel_transaction(
  p_fuel_transaction_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_agency uuid;
  v_fuel record;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  if coalesce(v_role,'') not in ('fleet_manager','super_admin') then
    raise exception 'Only a Fleet Manager or Super Admin can review fuel transactions';
  end if;
  select f.id,f.agency_id,f.status,f.driver_id,f.vehicle_id,f.reporting_month,f.amount_rm
    into v_fuel
    from public.fms_fuel_transactions f
    where f.id=p_fuel_transaction_id
    for update;
  if not found then raise exception 'Fuel transaction not found'; end if;
  v_agency := fms_private.current_agency_id();
  if v_role <> 'super_admin' and v_fuel.agency_id is distinct from v_agency then raise exception 'Agency access denied'; end if;
  if v_fuel.status <> 'submitted' then raise exception 'Only submitted fuel transactions can be reviewed'; end if;
  if p_decision not in ('approved','returned') then raise exception 'Unsupported fuel decision'; end if;
  if p_decision='returned' and coalesce(length(trim(p_reason)),0) < 3 then raise exception 'A correction reason is required'; end if;

  update public.fms_fuel_transactions
    set status=p_decision,reviewed_by=(select auth.uid()),reviewed_at=now(),
        review_remarks=case when p_decision='returned' then trim(p_reason) else null end,
        updated_at=now()
    where id=p_fuel_transaction_id;

  insert into public.fms_audit_logs(actor_profile_id,agency_id,action,entity_type,entity_id,details)
  values ((select auth.uid()),v_fuel.agency_id,'fuel_' || p_decision,'fuel_transaction',p_fuel_transaction_id,
    jsonb_build_object('previous_status',v_fuel.status,'new_status',p_decision,'reason',nullif(trim(p_reason),''),'driver_id',v_fuel.driver_id,'vehicle_id',v_fuel.vehicle_id,'reporting_month',v_fuel.reporting_month));

  return jsonb_build_object('success',true,'fuel_transaction_id',p_fuel_transaction_id,'status',p_decision);
end;
$function$;
revoke all on function public.fms_review_fuel_transaction(uuid,text,text) from public,anon;
grant execute on function public.fms_review_fuel_transaction(uuid,text,text) to authenticated;
commit;