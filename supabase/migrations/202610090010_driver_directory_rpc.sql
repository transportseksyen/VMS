
begin;
drop view if exists public.fms_driver_directory;
create or replace function public.fms_driver_directory()
returns table (
  id uuid,
  agency_id uuid,
  full_name text,
  availability_status text,
  availability_start date,
  availability_end date,
  availability_remarks text,
  licence_expiry date,
  approval_status text,
  account_status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_agency uuid;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  v_role := fms_private.current_role();
  v_agency := fms_private.current_agency_id();
  if coalesce(v_role,'') not in ('super_admin','fleet_manager','data_entry','driver') then
    raise exception 'FMS role is required';
  end if;

  return query
  select d.id,d.agency_id,d.full_name,d.availability_status,d.availability_start,d.availability_end,
         d.availability_remarks,d.licence_expiry,d.approval_status,d.account_status
  from public.fms_drivers d
  where v_role = 'super_admin'
     or (d.agency_id = v_agency and v_role in ('fleet_manager','data_entry'))
     or (d.agency_id = v_agency and v_role = 'driver'
         and (d.profile_id = (select auth.uid())
              or (d.approval_status = 'approved' and d.account_status = 'active')))
  order by d.full_name;
end;
$function$;
revoke all on function public.fms_driver_directory() from public, anon;
grant execute on function public.fms_driver_directory() to authenticated;
commit;
