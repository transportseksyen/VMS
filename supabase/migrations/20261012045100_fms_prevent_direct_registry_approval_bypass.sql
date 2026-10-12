-- Approved vehicle/driver records must use the audited registry-review and change-request RPCs.
-- Direct row updates are restricted to draft-like pending/returned records, and every
-- successful resubmission must set the state back to pending rather than approved.

DROP POLICY IF EXISTS vehicles_manager_approve ON public.fms_vehicles;
DROP POLICY IF EXISTS vehicles_data_entry_update_pending ON public.fms_vehicles;

CREATE POLICY vehicles_pending_registry_update
  ON public.fms_vehicles FOR UPDATE TO authenticated
  USING (
    fms_private.current_role() IN ('super_admin','fleet_manager','data_entry')
    AND fms_private.has_agency_access(agency_id)
    AND approval_status IN ('pending','returned')
    AND (
      fms_private.current_role() IN ('super_admin','fleet_manager')
      OR agency_id = fms_private.current_agency_id()
    )
  )
  WITH CHECK (
    fms_private.current_role() IN ('super_admin','fleet_manager','data_entry')
    AND fms_private.has_agency_access(agency_id)
    AND approval_status = 'pending'
    AND (
      fms_private.current_role() IN ('super_admin','fleet_manager')
      OR agency_id = fms_private.current_agency_id()
    )
  );

DROP POLICY IF EXISTS drivers_manager_approve ON public.fms_drivers;
DROP POLICY IF EXISTS drivers_data_entry_update_pending ON public.fms_drivers;

CREATE POLICY drivers_pending_registry_update
  ON public.fms_drivers FOR UPDATE TO authenticated
  USING (
    fms_private.current_role() IN ('super_admin','fleet_manager','data_entry')
    AND fms_private.has_agency_access(agency_id)
    AND approval_status IN ('pending','returned')
    AND (
      fms_private.current_role() IN ('super_admin','fleet_manager')
      OR agency_id = fms_private.current_agency_id()
    )
  )
  WITH CHECK (
    fms_private.current_role() IN ('super_admin','fleet_manager','data_entry')
    AND fms_private.has_agency_access(agency_id)
    AND approval_status = 'pending'
    AND (
      fms_private.current_role() IN ('super_admin','fleet_manager')
      OR agency_id = fms_private.current_agency_id()
    )
  );
