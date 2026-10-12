-- Tighten direct table privileges so row-level security is not the only barrier.
-- Revoke table-wide DML/TRUNCATE from public API roles; restore only required operations
-- on explicitly allowed columns. The service_role and postgres owner remain unaffected.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND left(tablename, 4) = 'fms_'
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated', t.tablename);
  END LOOP;
END;
$$;

GRANT SELECT ON TABLE
  public.fms_agencies,
  public.fms_profiles,
  public.fms_vehicles,
  public.fms_drivers,
  public.fms_applications,
  public.fms_assignments,
  public.fms_fuel_transactions,
  public.fms_maintenance_records,
  public.fms_maintenance_documents,
  public.fms_notifications,
  public.fms_audit_logs,
  public.fms_registry_change_requests,
  public.fms_vehicle_documents
TO authenticated;

GRANT SELECT ON TABLE public.fms_agencies TO anon;

GRANT INSERT (
  id, agency_id, brand, model, vehicle_type, plate_number, seat_capacity,
  vehicle_status, mileage_km, insurance_expiry, road_tax_expiry,
  inspection_date, next_service_due, remarks, approval_status, created_by
) ON TABLE public.fms_vehicles TO authenticated;

GRANT UPDATE (
  brand, model, vehicle_type, plate_number, seat_capacity, mileage_km,
  insurance_expiry, road_tax_expiry, inspection_date, next_service_due,
  remarks, approval_status, decision_reason, updated_at
) ON TABLE public.fms_vehicles TO authenticated;

GRANT INSERT (
  id, agency_id, full_name, email, phone, emergency_contact_name,
  emergency_contact_phone, account_status, availability_status,
  approval_status, created_by
) ON TABLE public.fms_drivers TO authenticated;

GRANT UPDATE (
  full_name, email, phone, emergency_contact_name, emergency_contact_phone,
  approval_status, decision_reason, updated_at,
  availability_status, availability_start, availability_end,
  availability_remarks, whatsapp_opt_in
) ON TABLE public.fms_drivers TO authenticated;

GRANT INSERT (
  agency_id, driver_id, vehicle_id, reporting_month, purchase_date,
  odometer_reading, litres, amount_rm, receipt_path, status
) ON TABLE public.fms_fuel_transactions TO authenticated;

GRANT INSERT (
  agency_id, vehicle_id, category, description, date_reported, status,
  estimated_cost_rm, actual_cost_rm, odometer_reading, service_date,
  next_service_due, workshop, remarks, created_by
) ON TABLE public.fms_maintenance_records TO authenticated;

GRANT INSERT (
  maintenance_id, document_type, file_path, original_file_name, uploaded_by
) ON TABLE public.fms_maintenance_documents TO authenticated;

GRANT INSERT (
  vehicle_id, agency_id, document_type, file_path, original_file_name, uploaded_by
) ON TABLE public.fms_vehicle_documents TO authenticated;

DROP POLICY IF EXISTS maintenance_data_entry_insert ON public.fms_maintenance_records;
CREATE POLICY maintenance_data_entry_insert
  ON public.fms_maintenance_records FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND fms_private.current_role() IN ('super_admin','fleet_manager','data_entry')
    AND (fms_private.current_role() = 'super_admin' OR agency_id = fms_private.current_agency_id())
    AND status = 'submitted'
    AND EXISTS (
      SELECT 1 FROM public.fms_vehicles v
      WHERE v.id = public.fms_maintenance_records.vehicle_id
        AND v.agency_id = public.fms_maintenance_records.agency_id
    )
  );

DROP POLICY IF EXISTS fms_vehicle_documents_data_entry_insert ON public.fms_vehicle_documents;
CREATE POLICY fms_vehicle_documents_data_entry_insert
  ON public.fms_vehicle_documents FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = (SELECT auth.uid())
    AND fms_private.current_role() IN ('super_admin','fleet_manager','data_entry')
    AND fms_private.has_agency_access(agency_id)
    AND EXISTS (
      SELECT 1 FROM public.fms_vehicles v
      WHERE v.id = public.fms_vehicle_documents.vehicle_id
        AND v.agency_id = public.fms_vehicle_documents.agency_id
    )
  );

DROP POLICY IF EXISTS fms_agency_document_insert ON storage.objects;
CREATE POLICY fms_agency_document_insert
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'fms-documents'
    AND fms_private.current_role() IN ('super_admin','fleet_manager','data_entry','driver')
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN fms_private.has_agency_access(((storage.foldername(name))[1])::uuid)
      ELSE false
    END
    AND (
      fms_private.current_role() <> 'driver'
      OR (
        (storage.foldername(name))[2] = 'fuel'
        AND EXISTS (
          SELECT 1
          FROM public.fms_drivers d
          WHERE d.id::text = (storage.foldername(objects.name))[3]
            AND d.profile_id = (SELECT auth.uid())
            AND d.agency_id = CASE
              WHEN (storage.foldername(objects.name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN ((storage.foldername(objects.name))[1])::uuid
              ELSE NULL
            END
        )
      )
    )
  );
