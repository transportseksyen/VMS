begin;

create or replace function fms_private.guard_driver_self_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if fms_private.current_role() is distinct from 'driver' then
    return new;
  end if;

  if old.profile_id is distinct from (select auth.uid()) or new.profile_id is distinct from old.profile_id then
    raise exception 'A Driver can only update their own availability settings';
  end if;

  if (to_jsonb(new) - array['availability_status','availability_start','availability_end','availability_remarks','whatsapp_opt_in','updated_at']::text[])
     is distinct from
     (to_jsonb(old) - array['availability_status','availability_start','availability_end','availability_remarks','whatsapp_opt_in','updated_at']::text[]) then
    raise exception 'Drivers may update availability and WhatsApp consent only; other driver fields require authorized staff';
  end if;

  if new.availability_status in ('on_leave','on_course','unavailable') and
     (new.availability_start is null or new.availability_end is null or new.availability_end < new.availability_start) then
    raise exception 'Leave, course and unavailability periods require valid start and end dates';
  end if;

  if length(coalesce(new.availability_remarks,'')) > 1500 then
    raise exception 'Availability remarks must be 1500 characters or fewer';
  end if;

  return new;
end;
$$;

revoke all on function fms_private.guard_driver_self_update() from public, anon, authenticated;

drop trigger if exists fms_drivers_self_update_guard on public.fms_drivers;
create trigger fms_drivers_self_update_guard
before update on public.fms_drivers
for each row execute function fms_private.guard_driver_self_update();

commit;
