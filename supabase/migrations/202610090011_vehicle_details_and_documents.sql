begin;
alter table public.fms_vehicles
  add column if not exists mileage_km numeric not null default 0,
  add column if not exists insurance_expiry date,
  add column if not exists road_tax_expiry date,
  add column if not exists inspection_date date,
  add column if not exists next_service_due date;
do $block$
begin
  if not exists (select 1 from pg_constraint where conname='fms_vehicles_mileage_km_nonnegative') then
    alter table public.fms_vehicles add constraint fms_vehicles_mileage_km_nonnegative check (mileage_km >= 0);
  end if;
end
$block$;

create table if not exists public.fms_vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.fms_vehicles(id) on delete cascade,
  agency_id uuid not null references public.fms_agencies(id),
  document_type text not null check (document_type in ('insurance','road_tax','inspection','registration','other')),
  file_path text not null unique,
  original_file_name text not null,
  uploaded_by uuid not null references public.fms_profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists fms_vehicle_documents_vehicle_id_idx on public.fms_vehicle_documents(vehicle_id);
create index if not exists fms_vehicle_documents_agency_id_idx on public.fms_vehicle_documents(agency_id);
alter table public.fms_vehicle_documents enable row level security;
drop policy if exists fms_vehicle_documents_scoped_read on public.fms_vehicle_documents;
create policy fms_vehicle_documents_scoped_read on public.fms_vehicle_documents
for select to authenticated
using (
  fms_private.has_agency_access(agency_id)
  and fms_private.current_role() in ('super_admin','fleet_manager','data_entry')
);
drop policy if exists fms_vehicle_documents_data_entry_insert on public.fms_vehicle_documents;
create policy fms_vehicle_documents_data_entry_insert on public.fms_vehicle_documents
for insert to authenticated
with check (
  uploaded_by = (select auth.uid())
  and fms_private.current_role() in ('fleet_manager','data_entry')
  and agency_id = fms_private.current_agency_id()
  and exists (
    select 1 from public.fms_vehicles v
    where v.id = fms_vehicle_documents.vehicle_id and v.agency_id = fms_vehicle_documents.agency_id
  )
);
revoke all on public.fms_vehicle_documents from anon;
grant select, insert on public.fms_vehicle_documents to authenticated;
commit;