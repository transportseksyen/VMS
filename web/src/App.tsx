import { FormEvent, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from './lib/supabase';

type Role = 'super_admin' | 'fleet_manager' | 'data_entry' | 'driver';
type Row = Record<string, any>;
type Profile = { id: string; full_name: string; role: Role; agency_id: string | null; status: string };
type View = 'dashboard' | 'applications' | 'vehicles' | 'drivers' | 'assignments' | 'fuel' | 'maintenance' | 'users' | 'availability' | 'reports' | 'agencies';

const roleTitles: Record<Role, string> = {
  super_admin: 'Super Admin',
  fleet_manager: 'Fleet Manager',
  data_entry: 'Data Entry',
  driver: 'Driver'
};
const titleByView: Record<View, string> = {
  dashboard: 'Dashboard', agencies: 'Agencies', applications: 'Applications', vehicles: 'Vehicles',
  drivers: 'Drivers', assignments: 'Assignment Monitoring', fuel: 'Monthly Fuel Analysis',
  maintenance: 'Maintenance', users: 'User Management', availability: 'My Availability',
  reports: 'Reports'
};
const navByRole: Record<Role, View[]> = {
  super_admin: ['dashboard', 'agencies', 'applications', 'vehicles', 'drivers', 'assignments', 'fuel', 'maintenance', 'reports', 'users'],
  fleet_manager: ['dashboard', 'applications', 'vehicles', 'drivers', 'assignments', 'fuel', 'maintenance', 'reports', 'users'],
  data_entry: ['dashboard', 'applications', 'vehicles', 'drivers', 'assignments', 'fuel', 'maintenance', 'reports'],
  driver: ['dashboard', 'assignments', 'vehicles', 'drivers', 'fuel', 'availability']
};
const tableByView: Partial<Record<View, string>> = {
  agencies: 'fms_agencies', applications: 'fms_applications', vehicles: 'fms_vehicles', drivers: 'fms_drivers',
  assignments: 'fms_assignments', fuel: 'fms_fuel_transactions', maintenance: 'fms_maintenance_records', users: 'fms_profiles'
};
const statusText = (s: string) => (s || '—').replaceAll('_', ' ').replace(/\b\w/g, m => m.toUpperCase());
const dateText = (v: string) => v ? new Date(v + (v.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-MY') : '—';
const moneyText = (v: number) => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(Number(v || 0));

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileMissing, setProfileMissing] = useState(false);
  const [view, setView] = useState<View>('dashboard');
  const [authMode, setAuthMode] = useState<'login' | 'apply'>('apply');
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [agencies, setAgencies] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [selectedApp, setSelectedApp] = useState<Row | null>(null);
  const [vehicles, setVehicles] = useState<Row[]>([]);
  const [drivers, setDrivers] = useState<Row[]>([]);
  const [fuelVehicles, setFuelVehicles] = useState<Row[]>([]);
  const [driverWhatsAppOptIn, setDriverWhatsAppOptIn] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user) void loadProfile(data.session.user.id);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) {
        setProfile(null);
        setProfileMissing(false);
      } else {
        window.setTimeout(() => { void loadProfile(newSession.user.id); }, 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (supabase) {
      supabase.from('fms_agencies').select('id,name').eq('is_active', true).order('name')
        .then(({ data }) => setAgencies(data || []));
    }
  }, []);

  useEffect(() => {
    if (!supabase || !profile || profile.role !== 'driver') {
      setDriverWhatsAppOptIn(false);
      return;
    }
    let cancelled = false;
    void supabase.from('fms_drivers').select('whatsapp_opt_in').eq('profile_id', profile.id).maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setDriverWhatsAppOptIn(Boolean(data?.whatsapp_opt_in));
      });
    return () => { cancelled = true; };
  }, [profile]);

  useEffect(() => {
    if (supabase && profile && view === 'fuel' && profile.role === 'driver') {
      void (async () => {
        const { data: driverRow } = await supabase.from('fms_drivers').select('id').eq('profile_id', profile.id).maybeSingle();
        if (!driverRow) { setFuelVehicles([]); return; }
        const { data } = await supabase.from('fms_assignments')
          .select('vehicle_id,vehicles:fms_vehicles(id,brand,model,plate_number)')
          .eq('driver_id', driverRow.id).eq('status', 'approved');
        const unique = new Map<string, Row>();
        (data || []).forEach((item: any) => { if (item.vehicles?.id) unique.set(item.vehicles.id, item.vehicles); });
        setFuelVehicles(Array.from(unique.values()));
      })();
    }
    if (profile && view !== 'dashboard' && view !== 'availability' && view !== 'reports') {
      void loadRows(view);
    } else {
      setRows([]);
    }
    if (profile && view === 'dashboard') void loadCounts();
  }, [profile, view]);

  async function loadProfile(userId: string) {
    if (!supabase) return;
    const { data, error: profileError } = await supabase.from('fms_profiles')
      .select('id,full_name,role,agency_id,status').eq('id', userId).maybeSingle();
    if (profileError || !data || data.status !== 'active') {
      setProfile(null);
      setProfileMissing(true);
      if (profileError) setError(profileError.message);
      return;
    }
    setProfile(data as Profile);
    setProfileMissing(false);
  }

  async function loadCounts() {
    if (!supabase || !profile) return;
    const names: Array<[string, string]> = [
      ['applications', 'fms_applications'], ['vehicles', 'fms_vehicles'],
      ['drivers', 'fms_drivers'], ['assignments', 'fms_assignments'],
      ['fuel_transactions', 'fms_fuel_transactions'],
      ['maintenance_records', 'fms_maintenance_records']
    ];
    const client = supabase;
    const next: Record<string, number> = {};
    await Promise.all(names.map(async ([key, table]) => {
      const { count } = await (client.from(table as any) as any).select('id', { count: 'exact', head: true });
      next[key] = count || 0;
    }));
    setCounts(next);
  }

  async function loadRows(target: View) {
    if (!supabase) return;
    const table = tableByView[target];
    if (!table) return;
    setLoading(true);
    setError('');
    let query: any = supabase.from(table).select('*');
    if (target === 'maintenance') {
      query = supabase.from('fms_maintenance_records').select('*,documents:fms_maintenance_documents(id,document_type,file_path,original_file_name)');
    }
    if (target === 'assignments') {
      query = supabase.from('fms_assignments').select('*,applications:fms_applications(reference,applicant_name,destination),vehicles:fms_vehicles(brand,model,plate_number),drivers:fms_drivers(full_name)');
    }
    const { data, error: queryError } = await query.order('created_at', { ascending: false }).limit(100);
    if (queryError) setError(queryError.message);
    setRows(data || []);
    setLoading(false);
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true); setError(''); setNotice('');
    const form = new FormData(event.currentTarget);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: String(form.get('email') || ''),
      password: String(form.get('password') || '')
    });
    if (signInError) setError(signInError.message);
    setBusy(false);
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setProfile(null); setSession(null); setView('dashboard'); setAuthMode('apply');
  }

  async function submitApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true); setError(''); setNotice('');
    const form = event.currentTarget;
    const fd = new FormData(form);
    const file = fd.get('document') as File | null;
    const startDate = String(fd.get('start_date') || '');
    const endDate = String(fd.get('end_date') || '');
    if (!file || file.size < 1 || file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please upload one combined PDF containing the official letter/memo and itinerary.');
      setBusy(false); return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('PDF must be 5 MB or smaller.');
      setBusy(false); return;
    }
    if (!startDate || !endDate || endDate < startDate) {
      setError('The end date must be the same as or later than the start date.');
      setBusy(false); return;
    }
    try {
      const application = {
        agency_id: String(fd.get('fleet_agency_id') || ''),
        applicant_name: String(fd.get('applicant_name') || '').trim(),
        applicant_agency_name: String(fd.get('applicant_agency_name') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        passenger_count: Number(fd.get('passenger_count')),
        vehicles_requested: Number(fd.get('vehicles_requested')),
        passenger_names: String(fd.get('passenger_names') || '').trim(),
        destination: String(fd.get('destination') || '').trim(),
        purpose: String(fd.get('purpose') || '').trim(),
        whatsapp_opt_in: fd.get('whatsapp_opt_in') === 'on',
        hotel_provided: String(fd.get('hotel_provided') || 'no') === 'yes',
        start_date: startDate,
        end_date: endDate
      };
      const base64 = await readFileAsBase64(file);
      const { data, error: submitError } = await supabase.functions.invoke('submit-application', {
        body: { application, fileName: file.name, fileBase64: base64 }
      });
      if (submitError) {
        setError('Application could not be submitted: ' + submitError.message);
      } else if (data?.success) {
        const emailNote = data.emailStatus === 'sent'
          ? ' An acknowledgement email was sent.'
          : ' Email acknowledgement is pending configuration by the administrator.';
        setNotice('Application submitted successfully. Reference: ' + data.reference + '.' + emailNote);
        form.reset();
      } else {
        setError(data?.error || 'Application could not be submitted.');
      }
    } catch (submitException) {
      setError(submitException instanceof Error ? submitException.message : 'Unexpected submission error.');
    }
    setBusy(false);
  }

  async function readFileAsBase64(file: File): Promise<string> {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : '');
      };
      reader.onerror = () => reject(new Error('The selected file could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  async function beginAssignment(app: Row) {
    if (!supabase || !profile) return;
    setError(''); setNotice('');
    const [v, d] = await Promise.all([
      supabase.from('fms_vehicles').select('id,brand,model,plate_number,seat_capacity').eq('agency_id', app.agency_id || profile.agency_id).eq('approval_status', 'approved').eq('vehicle_status', 'active'),
      supabase.from('fms_drivers').select('id,full_name,email').eq('agency_id', app.agency_id || profile.agency_id).eq('approval_status', 'approved').eq('account_status', 'active')
    ]);
    setVehicles(v.data || []); setDrivers(d.data || []);
    setSelectedApp(app);
  }

  async function createAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile || !selectedApp) return;
    setBusy(true); setError('');
    const fd = new FormData(event.currentTarget);
    const { error: insertError } = await supabase.from('fms_assignments').insert({
      agency_id: selectedApp.agency_id,
      application_id: selectedApp.id,
      vehicle_id: String(fd.get('vehicle_id') || ''),
      driver_id: String(fd.get('driver_id') || ''),
      start_date: selectedApp.start_date,
      end_date: selectedApp.end_date,
      status: 'proposed',
      submitted_by: profile.id
    });
    if (insertError) {
      setError(insertError.message); setBusy(false); return;
    }
    await supabase.from('fms_applications').update({ status: 'pending_manager_approval' }).eq('id', selectedApp.id);
    setSelectedApp(null);
    setNotice('Proposed assignment sent to the Fleet Manager for approval.');
    setBusy(false);
    await loadRows('applications');
  }

  async function decideAssignment(row: Row, decision: 'approve' | 'reject' | 'cancel') {
    if (!supabase) return;
    setError(''); setNotice('');
    let result: any;
    let reason = '';
    if (decision === 'approve') {
      result = await supabase.rpc('fms_approve_assignment', { p_assignment_id: row.id });
    } else {
      const prompt = decision === 'cancel' ? 'Enter a cancellation reason:' : 'Enter a rejection reason:';
      const enteredReason = window.prompt(prompt);
      if (!enteredReason || !enteredReason.trim()) return;
      reason = enteredReason.trim();
      result = decision === 'reject'
        ? await supabase.rpc('fms_reject_assignment', { p_assignment_id: row.id, p_reason: reason })
        : await supabase.rpc('fms_cancel_assignment', { p_assignment_id: row.id, p_reason: reason });
    }
    if (result.error) {
      setError(result.error.message);
      return;
    }
    const notificationType = decision === 'approve'
      ? 'assignment-approved'
      : decision === 'reject' ? 'assignment-rejected' : 'assignment-cancelled';
    const notification = await supabase.functions.invoke('send-fms-notification', {
      body: { type: notificationType, application_id: row.application_id, assignment_id: row.id, reason }
    });
    if (notification.error || notification.data?.applicantEmailStatus === 'not_configured') {
      setNotice('Decision saved. Email/WhatsApp delivery needs provider configuration or opt-in.');
    } else {
      const applicantEmail = notification.data?.applicantEmailStatus || 'not_applicable';
      const applicantWhatsApp = notification.data?.applicantWhatsAppStatus || 'not_applicable';
      const actionLabel = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'cancelled';
      setNotice('Assignment ' + actionLabel + '. Applicant email: ' + applicantEmail + '; WhatsApp: ' + applicantWhatsApp + '.');
    }
    await loadRows('assignments');
    await loadCounts();
  }

  async function approveRegistryRecord(table: 'vehicles' | 'drivers', row: Row) {
    if (!supabase) return;
    setError(''); setNotice('');
    const rpc = table === 'vehicles' ? 'fms_approve_vehicle' : 'fms_approve_driver';
    const arg = table === 'vehicles' ? 'p_vehicle_id' : 'p_driver_id';
    const { error: updateError } = await supabase.rpc(rpc as any, { [arg]: row.id } as any);
    if (updateError) setError(updateError.message);
    else { setNotice('Record approved.'); await loadRows(view); }
  }

  async function saveVehicle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!supabase || !profile?.agency_id) return;
    const fd = new FormData(form);
    const record = {
      agency_id: profile.agency_id, brand: String(fd.get('brand') || '').trim(),
      model: String(fd.get('model') || '').trim(), vehicle_type: String(fd.get('vehicle_type') || ''),
      plate_number: String(fd.get('plate_number') || '').trim().toUpperCase(),
      seat_capacity: Number(fd.get('seat_capacity') || 1), vehicle_status: 'active',
      approval_status: 'pending', created_by: profile.id
    };
    const { error: saveError } = await supabase.from('fms_vehicles').insert(record);
    if (saveError) setError(saveError.message);
    else { setNotice('Vehicle saved and submitted for approval.'); await loadRows('vehicles'); form.reset(); }
  }

  async function saveDriver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!supabase || !profile?.agency_id) return;
    const fd = new FormData(form);
    const record = {
      agency_id: profile.agency_id, full_name: String(fd.get('full_name') || '').trim(),
      email: String(fd.get('email') || '').trim(), phone: String(fd.get('phone') || '').trim(),
      emergency_contact_name: String(fd.get('emergency_contact_name') || '').trim(),
      emergency_contact_phone: String(fd.get('emergency_contact_phone') || '').trim(),
      account_status: 'active', availability_status: 'available',
      approval_status: 'pending', created_by: profile.id
    };
    const { error: saveError } = await supabase.from('fms_drivers').insert(record);
    if (saveError) setError(saveError.message);
    else { setNotice('Driver saved and submitted for approval.'); await loadRows('drivers'); form.reset(); }
  }

  async function saveFuel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!supabase || !profile?.agency_id) return;
    const fd = new FormData(form);
    const receipt = fd.get('receipt') as File | null;
    if (!receipt || receipt.size < 1 || receipt.size > 5 * 1024 * 1024) { setError('Select a receipt no larger than 5 MB.'); return; }
    const allowedTypes = ['application/pdf','image/jpeg','image/png'];
    if (!allowedTypes.includes(receipt.type)) { setError('Receipt must be a PDF, JPG or PNG.'); return; }
    const vehicleId = String(fd.get('vehicle_id') || '');
    const { data: driverRecord, error: driverError } = await supabase.from('fms_drivers').select('id').eq('profile_id', profile.id).maybeSingle();
    if (driverError || !driverRecord) { setError('Your driver profile is not linked. Contact the Data Entry user or Fleet Manager.'); return; }
    const safeFileName = receipt.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = profile.agency_id + '/fuel/' + driverRecord.id + '/' + crypto.randomUUID() + '-' + safeFileName;
    setBusy(true); setError('');
    const { error: uploadError } = await supabase.storage.from('fms-documents').upload(path, receipt, { contentType: receipt.type, upsert: false });
    if (uploadError) { setError(uploadError.message); setBusy(false); return; }
    const { error: insertError } = await supabase.from('fms_fuel_transactions').insert({
      agency_id: profile.agency_id, driver_id: driverRecord.id, vehicle_id: vehicleId,
      reporting_month: String(fd.get('reporting_month') || ''),
      purchase_date: String(fd.get('purchase_date') || ''),
      odometer_reading: Number(fd.get('odometer_reading')),
      litres: Number(fd.get('litres')), amount_rm: Number(fd.get('amount_rm')),
      receipt_path: path, status: 'submitted'
    });
    if (insertError) { await supabase.storage.from('fms-documents').remove([path]); setError(insertError.message); }
    else { setNotice('Fuel transaction submitted with receipt.'); await loadRows('fuel'); form.reset(); }
    setBusy(false);
  }

  async function saveMaintenance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!supabase || !profile?.agency_id) return;
    const fd = new FormData(form);
    const record = {
      agency_id: profile.agency_id, vehicle_id: String(fd.get('vehicle_id') || ''),
      category: String(fd.get('category') || ''), description: String(fd.get('description') || '').trim(),
      date_reported: String(fd.get('date_reported') || ''), status: 'submitted',
      created_by: profile.id, remarks: String(fd.get('remarks') || '').trim()
    };
    const docTypes = [
      ['quotation', 'quotation'], ['maintenance_request', 'maintenance_request'],
      ['service_order', 'service_order'], ['invoice', 'invoice']
    ] as const;
    const docs = docTypes.map(([field, type]) => ({ type, file: fd.get(field) as File | null }))
      .filter(item => item.file && item.file.size > 0) as Array<{type:string;file:File}>;
    for (const item of docs) {
      if (item.file.size > 5 * 1024 * 1024 || !['application/pdf','image/jpeg','image/png'].includes(item.file.type)) {
        setError('Each maintenance file must be a PDF, JPG or PNG no larger than 5 MB.');
        return;
      }
    }
    setBusy(true); setError('');
    const { data: created, error: saveError } = await supabase.from('fms_maintenance_records').insert(record).select('id').single();
    if (saveError || !created) {
      setError(saveError?.message || 'Maintenance record could not be saved.');
      setBusy(false);
      return;
    }
    const uploadedPaths: string[] = [];
    for (const item of docs) {
      const safeName = item.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = profile.agency_id + '/maintenance/' + created.id + '/' + item.type + '-' + safeName;
      const { error: uploadError } = await supabase.storage.from('fms-documents').upload(path, item.file, {
        contentType: item.file.type, upsert: false
      });
      if (uploadError) {
        setError('Maintenance record was saved but a document upload failed: ' + uploadError.message);
        setBusy(false);
        await loadRows('maintenance');
        return;
      }
      uploadedPaths.push(path);
      const { error: docError } = await supabase.from('fms_maintenance_documents').insert({
        maintenance_id: created.id, document_type: item.type,
        file_path: path, original_file_name: item.file.name, uploaded_by: profile.id
      });
      if (docError) {
        setError('Maintenance record and file were saved, but document metadata failed: ' + docError.message);
        setBusy(false);
        await loadRows('maintenance');
        return;
      }
    }
    setNotice('Maintenance record submitted with ' + docs.length + ' supporting document(s).');
    await loadRows('maintenance');
    await loadCounts();
    form.reset();
    setBusy(false);
  }

  async function openDocument(path: string) {
    if (!supabase || !path) return;
    const { data, error: urlError } = await supabase.storage.from('fms-documents').createSignedUrl(path, 300);
    if (urlError || !data?.signedUrl) {
      setError(urlError?.message || 'Document could not be opened for your account.');
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function reviewFuel(row: Row, decision: 'approved' | 'returned') {
    if (!supabase || !profile || !['fleet_manager','super_admin'].includes(profile.role)) return;
    let remarks = '';
    if (decision === 'returned') {
      const reason = window.prompt('Enter the correction required:');
      if (!reason || !reason.trim()) return;
      remarks = reason.trim();
    }
    const { error: reviewError } = await supabase.from('fms_fuel_transactions').update({
      status: decision, reviewed_by: profile.id, reviewed_at: new Date().toISOString(),
      review_remarks: remarks || null, updated_at: new Date().toISOString()
    }).eq('id', row.id);
    if (reviewError) setError(reviewError.message);
    else { setNotice(decision === 'approved' ? 'Fuel transaction approved.' : 'Fuel transaction returned for correction.'); await loadRows('fuel'); }
  }

  async function setAvailability(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile) return;
    const fd = new FormData(event.currentTarget);
    const whatsappOptIn = fd.get('whatsapp_opt_in') === 'on';
    const { error: updateError } = await supabase.from('fms_drivers')
      .update({ availability_status: String(fd.get('availability_status')), availability_start: fd.get('availability_start') || null, availability_end: fd.get('availability_end') || null, availability_remarks: fd.get('availability_remarks') || null, whatsapp_opt_in: whatsappOptIn })
      .eq('profile_id', profile.id);
    if (updateError) setError(updateError.message); else { setDriverWhatsAppOptIn(whatsappOptIn); setNotice('Availability updated.'); }
  }

  async function createAgency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || profile?.role !== 'super_admin') return;
    const form = event.currentTarget;
    const fd = new FormData(form);
    setBusy(true); setError(''); setNotice('');
    const { data, error: createError } = await supabase.functions.invoke('admin-users', {
      body: { action: 'create_agency', name: String(fd.get('name') || '').trim(), code: String(fd.get('code') || '').trim() }
    });
    if (createError || data?.error) setError(data?.error || createError?.message || 'Could not create agency.');
    else {
      setNotice('Agency created. It is now available in the applicant request form.');
      setAgencies(prev => [...prev.filter(a => a.id !== data.agency.id), data.agency].sort((a,b) => a.name.localeCompare(b.name)));
      await loadRows('agencies');
      form.reset();
    }
    setBusy(false);
  }

  async function toggleAgency(row: Row) {
    if (!supabase || profile?.role !== 'super_admin') return;
    const isActive = !Boolean(row.is_active);
    const { data, error: updateError } = await supabase.functions.invoke('admin-users', {
      body: { action: 'update_agency_status', agency_id: row.id, is_active: isActive }
    });
    if (updateError || data?.error) setError(data?.error || updateError?.message || 'Could not update agency.');
    else {
      setNotice(isActive ? 'Agency activated.' : 'Agency deactivated.');
      setAgencies(prev => isActive
        ? [...prev.filter(a => a.id !== data.agency.id), data.agency].sort((a,b) => a.name.localeCompare(b.name))
        : prev.filter(a => a.id !== data.agency.id));
      await loadRows('agencies');
    }
  }

  async function approveStaff(row: Row) {
    if (!supabase) return;
    setError(''); setNotice('');
    const { data, error: approveError } = await supabase.functions.invoke('admin-users', {
      body: { action: 'approve', user_id: row.id }
    });
    if (approveError || data?.error) setError(data?.error || approveError?.message || 'Approval failed.');
    else { setNotice('Staff account approved.'); await loadRows('users'); }
  }

  async function inviteUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile) return;
    const form = event.currentTarget;
    const fd = new FormData(form);
    setBusy(true); setError(''); setNotice('');
    const { data, error: inviteError } = await supabase.functions.invoke('admin-users', {
      body: {
        action: 'invite',
        full_name: String(fd.get('full_name') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        role: String(fd.get('role') || ''),
        agency_id: String(fd.get('agency_id') || '') || null
      }
    });
    if (inviteError || data?.error) setError(data?.error || inviteError?.message || 'Invitation failed.');
    else { setNotice('Invitation sent. The new staff account must follow the email invitation.'); form.reset(); await loadRows('users'); }
    setBusy(false);
  }

  if (!supabaseConfigured || !supabase) {
    return <SetupScreen />;
  }

  if (!session) {
    return (
      <div className="public-shell">
        <div className="public-top"><Brand /><div className="top-actions"><span className="secure-pill">Secure fleet operations</span><button className="btn btn-ghost" onClick={() => setAuthMode(authMode === 'apply' ? 'login' : 'apply')}>{authMode === 'apply' ? 'Staff login' : 'Vehicle request'}</button></div></div>
        <div className="public-grid">
          <section className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-dot" /> SARAWAK GOVERNMENT FLEET</div>
            <h1>Fleet operations,<br /><em>made seamless.</em></h1>
            <p>One trusted platform for vehicle requests, driver assignments, fuel reporting and fleet maintenance across agencies.</p>
            <div className="hero-points"><span>✓ Accountable approvals</span><span>✓ Mobile-ready reporting</span><span>✓ Agency-level access</span></div>
            <div className="hero-footer"><span className="hero-line" /> <span>FMS · Fleet Management System</span></div>
          </section>
          <section className="public-card">
            {authMode === 'login' ? (
              <>
                <div className="card-kicker">FMS WORKSPACE</div><h2>Welcome back</h2><p className="muted">Sign in with your authorized agency account.</p>
                <form className="form-stack" onSubmit={signIn}>
                  <label>Email address<input type="email" name="email" required autoComplete="username" placeholder="name@agency.gov.my" /></label>
                  <label>Password<input type="password" name="password" required autoComplete="current-password" placeholder="Enter your password" /></label>
                  {error && <div className="alert alert-error">{error}</div>}
                  <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'} <span>→</span></button>
                </form>
                <button className="link-button" onClick={() => setAuthMode('apply')}>Submit a vehicle request without login</button>
              </>
            ) : (
              <>
                <div className="card-kicker">PUBLIC VEHICLE PORTAL</div><h2>Request a vehicle</h2><p className="muted">Submit your trip details and attach one combined PDF letter/memo and itinerary.</p>
                <form className="form-stack" onSubmit={submitApplication}>
                  <div className="form-two"><label>Applicant name *<input name="applicant_name" required maxLength={120} /></label><label>Applicant agency *<input name="applicant_agency_name" required maxLength={180} /></label></div>
                  <div className="form-two"><label>Email address *<input name="email" type="email" required /></label><label>Phone number *<input name="phone" type="tel" required /></label></div>
                  <label>Fleet agency requested *<select name="fleet_agency_id" required defaultValue=""><option value="" disabled>Select agency</option>{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                  <div className="form-two"><label>Number of passengers *<input type="number" min="1" max="500" name="passenger_count" defaultValue="1" required /></label><label>Number of vehicles *<input type="number" min="1" max="50" name="vehicles_requested" defaultValue="1" required /></label></div>
                  <label>Names of passengers<input name="passenger_names" placeholder="Enter names separated by commas" /></label>
                  <label>Destination *<input name="destination" required maxLength={250} /></label>
                  <label>Purpose of application *<textarea name="purpose" rows={3} required maxLength={2000} placeholder="Explain the purpose of the trip and why a vehicle is required." /></label>
                  <div className="form-two"><label>Start date *<input type="date" name="start_date" required /></label><label>End date *<input type="date" name="end_date" required /></label></div>
                  <label>Hotel accommodation provided?<select name="hotel_provided" defaultValue="no"><option value="yes">Yes</option><option value="no">No</option></select></label>
                  <label className="check-label"><input type="checkbox" name="whatsapp_opt_in" /> <span>I agree to receive vehicle request status updates from FMS Sarawak by WhatsApp on the phone number provided. I can withdraw this consent later.</span></label>
                  <label className="upload-box"><span className="upload-icon">↑</span><span><strong>Official letter/memo + itinerary</strong><small>One combined PDF · maximum 5 MB</small></span><input type="file" name="document" accept=".pdf,application/pdf" required /></label>
                  {error && <div className="alert alert-error">{error}</div>}
                  {notice && <div className="alert alert-success">{notice}</div>}
                  <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Submitting…' : 'Submit vehicle request'} <span>→</span></button>
                  <p className="privacy-note">Your application document is stored privately. Do not upload unrelated personal or confidential material.</p>
                </form>
                <button className="link-button" onClick={() => { setAuthMode('login'); setError(''); setNotice(''); }}>Staff login</button>
              </>
            )}
          </section>
        </div>
        <footer className="public-footer"><span>FMS · Sarawak</span><span>Fleet Management System</span><span>Asia/Kuching · RM</span></footer>
      </div>
    );
  }

  async function bootstrapFirstAdmin() {
    if (!supabase || !session?.user) return;
    setBusy(true); setError(''); setNotice('');
    const { data, error: bootstrapError } = await supabase.functions.invoke('bootstrap-admin', { body: {} });
    if (bootstrapError || data?.error) {
      setError(data?.error || bootstrapError?.message || 'Could not bootstrap the first Super Admin.');
    } else {
      setNotice(data?.message || 'First Super Admin created.');
      await loadProfile(session.user.id);
    }
    setBusy(false);
  }
  if (profileMissing || !profile) {
    return <div className="setup-page"><Brand /><div className="setup-card"><div className="status-mark">!</div><h2>Account awaiting authorization</h2><p>Your staff account is authenticated, but no FMS role has been assigned. Ask the Super Admin to provision your profile and agency access.</p>{error && <p className="error-text">{error}</p>}{notice && <p className="success-text">{notice}</p>}<button className="btn btn-primary btn-wide" disabled={busy} onClick={bootstrapFirstAdmin}>{busy ? 'Checking bootstrap access…' : 'Set up first Super Admin'} <span>→</span></button><p className="tiny-note">This works only for the email explicitly allow-listed in Supabase Function Secrets and only before another Super Admin exists.</p><button className="btn btn-outline btn-wide" onClick={signOut}>Sign out</button></div></div>;
  }

  const nav = navByRole[profile.role] || [];
  const canEditRegistry = profile.role === 'data_entry' || profile.role === 'fleet_manager' || profile.role === 'super_admin';
  const canApprove = profile.role === 'fleet_manager' || profile.role === 'super_admin';
  const isDriver = profile.role === 'driver';
  const currentTitle = titleByView[view];
  const statItems = [
    {label:'Applications', value:counts.applications || 0, hint:'Requests in your permitted scope', glyph:'▤'},
    {label:'Vehicles', value:counts.vehicles || 0, hint:'Registered fleet vehicles', glyph:'▰'},
    {label:'Drivers', value:counts.drivers || 0, hint:'Registered drivers', glyph:'♙'},
    {label:'Assignments', value:counts.assignments || 0, hint:'Proposed and confirmed trips', glyph:'⇄'}
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand compact />
        <div className="sidebar-rule" />
        <div className="nav-caption">WORKSPACE</div>
        <nav className="side-nav">
          {nav.map(item => <button key={item} className={'nav-item ' + (view === item ? 'active' : '')} onClick={() => { setView(item); setNotice(''); setError(''); setSelectedApp(null); }}><span className="nav-glyph">{glyphFor(item)}</span><span>{titleByView[item]}</span>{item === 'applications' && counts.applications ? <small>{counts.applications}</small> : null}</button>)}
        </nav>
        <div className="sidebar-spacer" />
        <div className="agency-card"><div className="agency-seal">F</div><div><strong>{profile.role === 'super_admin' ? 'System-wide access' : 'Agency workspace'}</strong><small>{roleTitles[profile.role]}</small></div></div>
        <button className="nav-item signout" onClick={signOut}><span className="nav-glyph">↪</span><span>Sign out</span></button>
      </aside>
      <main className="main-area">
        <header className="app-header"><div><div className="breadcrumb">FMS <span>/</span> {currentTitle}</div><h1>{currentTitle}</h1><p>{welcomeLine(view, profile.role)}</p></div><div className="header-right"><div className="timezone-chip">MYT <span>Asia/Kuching</span></div><div className="user-chip"><div className="avatar">{profile.full_name.slice(0,1).toUpperCase()}</div><div><strong>{profile.full_name}</strong><small>{roleTitles[profile.role]}</small></div></div></div></header>
        <div className="content-area">
          {notice && <div className="alert alert-success dismissible">{notice}<button onClick={() => setNotice('')}>×</button></div>}
          {error && <div className="alert alert-error dismissible">{error}<button onClick={() => setError('')}>×</button></div>}
          {view === 'dashboard' && <Dashboard profile={profile} counts={counts} onNavigate={setView} />}
          {view === 'applications' && <section className="panel"><PanelHeading title="Vehicle applications" subtitle="Review trip requirements and prepare a proposed assignment." /><DataTable rows={rows} kind="applications" loading={loading} role={profile.role} onAssign={beginAssignment} onDocument={path => void openDocument(path)} /><div className="panel-foot">Only authorized agency applications are shown. A proposed assignment is not confirmed until approved.</div></section>}
          {view === 'vehicles' && <><section className="panel"><PanelHeading title="Vehicle registry" subtitle="Approved vehicle records are eligible for assignments." />{loading ? <Loading /> : <DataTable rows={rows} kind="vehicles" loading={loading} role={profile.role} onApprove={r => void approveRegistryRecord('vehicles', r)} />}</section>{canEditRegistry && <section className="panel form-panel"><PanelHeading title="Register a vehicle" subtitle="New and changed records are submitted for Fleet Manager approval." /><form className="form-grid" onSubmit={saveVehicle}><label>Brand *<input name="brand" required /></label><label>Model *<input name="model" required /></label><label>Vehicle type *<select name="vehicle_type" required><option value="">Choose type</option><option>Sedan</option><option>SUV</option><option>MPV</option><option>Van</option><option>4x4 / Pickup</option><option>Bus</option><option>Other</option></select></label><label>Registration number *<input name="plate_number" required /></label><label>Seat capacity *<input name="seat_capacity" type="number" min="1" max="100" defaultValue="5" required /></label><div className="form-action"><button className="btn btn-primary" disabled={busy}>Submit for approval</button></div></form></section>}</>}
          {view === 'drivers' && <><section className="panel"><PanelHeading title="Driver directory" subtitle="Driver records require Fleet Manager approval before assignment." />{loading ? <Loading /> : <DataTable rows={rows} kind="drivers" loading={loading} role={profile.role} onApprove={r => void approveRegistryRecord('drivers', r)} />}</section>{canEditRegistry && <section className="panel form-panel"><PanelHeading title="Register a driver" subtitle="Emergency contact details are restricted to authorized staff." /><form className="form-grid" onSubmit={saveDriver}><label>Driver name *<input name="full_name" required /></label><label>Email address *<input name="email" type="email" required /></label><label>Phone number *<input name="phone" required /></label><label>Emergency contact name<input name="emergency_contact_name" /></label><label>Emergency contact phone<input name="emergency_contact_phone" /></label><div className="form-action"><button className="btn btn-primary" disabled={busy}>Submit for approval</button></div></form></section>}</>}
          {view === 'assignments' && <section className="panel"><PanelHeading title="Assignment monitoring" subtitle="Confirmed trips are created only after Fleet Manager approval." /><AssignmentCalendar rows={rows} /><DataTable rows={rows} kind="assignments" loading={loading} role={profile.role} onApprove={r => void decideAssignment(r, 'approve')} onReject={r => void decideAssignment(r, 'reject')} onCancel={r => void decideAssignment(r, 'cancel')} /><div className="panel-foot">Date conflicts must be checked by the database approval function before an assignment can become confirmed.</div></section>}
          {view === 'fuel' && <><section className="panel"><PanelHeading title="Fuel transactions" subtitle="Drivers submit a receipt for each purchase. Monthly totals are calculated from saved transactions." />{loading ? <Loading /> : <><FuelSummary rows={rows} /><DataTable rows={rows} kind="fuel" loading={loading} role={profile.role} onApprove={r => void reviewFuel(r, 'approved')} onReject={r => void reviewFuel(r, 'returned')} onDocument={path => void openDocument(path)} /></>}</section>{isDriver && <section className="panel form-panel"><PanelHeading title="Submit a fuel transaction" subtitle="Upload a readable receipt photo or PDF. Maximum file size: 5 MB." /><form className="form-grid" onSubmit={saveFuel}><label>Vehicle *<select name="vehicle_id" required defaultValue=""><option value="" disabled>Select vehicle</option>{fuelVehicles.map(v => <option value={v.id} key={v.id}>{v.plate_number} · {v.brand} {v.model}</option>)}</select></label><label>Reporting month *<input name="reporting_month" type="month" required /></label><label>Purchase date *<input name="purchase_date" type="date" required /></label><label>Odometer (km) *<input name="odometer_reading" type="number" min="0" required /></label><label>Litres *<input name="litres" type="number" min="0.01" step="0.01" required /></label><label>Total cost (RM) *<input name="amount_rm" type="number" min="0.01" step="0.01" required /></label><label className="full-width">Receipt *<input name="receipt" type="file" accept="image/*,.pdf,application/pdf" required /></label><div className="form-action"><button className="btn btn-primary" disabled={busy}>Submit fuel transaction</button></div></form></section>}</>}
          {view === 'maintenance' && <><section className="panel"><PanelHeading title="Maintenance records" subtitle="Track vehicle servicing and supporting documents." />{loading ? <Loading /> : <DataTable rows={rows} kind="maintenance" loading={loading} role={profile.role} onDocument={path => void openDocument(path)} />}</section>{canEditRegistry && <section className="panel form-panel"><PanelHeading title="Create maintenance record" subtitle="Add a record before attaching the quotation, request, service order and invoice." /><form className="form-grid" onSubmit={saveMaintenance}><label>Vehicle ID *<input name="vehicle_id" required placeholder="Paste approved vehicle ID" /></label><label>Category *<select name="category" required><option value="">Choose category</option><option>Scheduled service</option><option>Repair</option><option>Tyres</option><option>Accident damage</option><option>Inspection</option><option>Other</option></select></label><label>Date reported *<input name="date_reported" type="date" required /></label><label>Description *<input name="description" required /></label><label>Quotation (PDF/JPG/PNG)<input name="quotation" type="file" accept=".pdf,image/jpeg,image/png,application/pdf" /></label><label>Maintenance request (PDF/JPG/PNG)<input name="maintenance_request" type="file" accept=".pdf,image/jpeg,image/png,application/pdf" /></label><label>Service order (PDF/JPG/PNG)<input name="service_order" type="file" accept=".pdf,image/jpeg,image/png,application/pdf" /></label><label>Invoice (PDF/JPG/PNG)<input name="invoice" type="file" accept=".pdf,image/jpeg,image/png,application/pdf" /></label><label className="full-width">Remarks<textarea name="remarks" rows={2} /></label><div className="form-action"><button className="btn btn-primary" disabled={busy}>Save maintenance and documents</button></div></form></section>}</>}
          {view === 'availability' && <section className="panel form-panel"><PanelHeading title="My availability" subtitle="Update your expected leave, course or unavailability period." /><form className="form-grid" onSubmit={setAvailability}><label>Status *<select name="availability_status" required><option value="available">Available</option><option value="on_leave">On leave</option><option value="on_course">On course</option><option value="unavailable">Unavailable</option></select></label><label>Start date<input name="availability_start" type="date" /></label><label>End date<input name="availability_end" type="date" /></label><label className="check-label full-width"><input type="checkbox" name="whatsapp_opt_in" checked={driverWhatsAppOptIn} onChange={e => setDriverWhatsAppOptIn(e.target.checked)} /> <span>I agree to receive trip assignment, rejection and cancellation updates from FMS Sarawak by WhatsApp on my registered phone number.</span></label><label className="full-width">Remarks<textarea name="availability_remarks" rows={3} /></label><div className="form-action"><button className="btn btn-primary">Update availability</button></div></form></section>}
          {view === 'agencies' && profile.role === 'super_admin' && <><section className="panel"><PanelHeading title="Agency registry" subtitle="Create and manage the agencies served by FMS." /><DataTable rows={rows} kind="agencies" loading={loading} role={profile.role} onApprove={r => void toggleAgency(r)} /></section><section className="panel form-panel"><PanelHeading title="Register an agency" subtitle="Only active agencies appear in the public vehicle request form." /><form className="form-grid" onSubmit={createAgency}><label>Agency name *<input name="name" required maxLength={180} /></label><label>Agency code<input name="code" maxLength={16} placeholder="Example: SIBU-TR" /></label><div className="form-action"><button className="btn btn-primary" disabled={busy}>Create agency</button></div></form></section></>}{view === 'users' && <><section className="panel"><PanelHeading title="Staff directory" subtitle="View accounts visible within your authorized scope." /><DataTable rows={rows} kind="users" loading={loading} role={profile.role} onApprove={r => void approveStaff(r)} /></section><section className="panel form-panel"><PanelHeading title="Invite a staff user" subtitle="An invitation email will be sent. Role and agency permissions are validated server-side." /><form className="form-grid" onSubmit={inviteUser}><label>Full name *<input name="full_name" required /></label><label>Email address *<input name="email" type="email" required /></label><label>Role *<select name="role" required defaultValue=""><option value="" disabled>Select role</option>{(profile.role === 'super_admin' ? ['super_admin','fleet_manager','data_entry','driver'] : ['data_entry','driver']).map(r => <option key={r} value={r}>{roleTitles[r as Role]}</option>)}</select></label><label>Agency *<select name="agency_id" required defaultValue=""><option value="" disabled>Select agency</option>{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><div className="form-action"><button className="btn btn-primary" disabled={busy}>Send invitation</button></div></form><div className="panel-foot">Super Admin can appoint Fleet Managers to any active agency. Fleet Managers can invite Data Entry and Drivers for their own agency only.</div></section></>}
          {view === 'reports' && <Reports counts={counts} />}
        </div>
        <footer className="main-footer"><span>FMS · Fleet Management System</span><span>Authorized access only</span><span>Sarawak · Malaysia</span></footer>
      </main>
      {selectedApp && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={() => setSelectedApp(null)}>×</button><div className="card-kicker">PROPOSED ASSIGNMENT</div><h2>{selectedApp.reference || selectedApp.id.slice(0,8).toUpperCase()}</h2><p className="muted">{selectedApp.applicant_name} · {selectedApp.destination}</p><div className="trip-date-box"><span>{dateText(selectedApp.start_date)}</span><b>→</b><span>{dateText(selectedApp.end_date)}</span></div><form className="form-stack" onSubmit={createAssignment}><label>Vehicle *<select name="vehicle_id" required defaultValue=""><option value="" disabled>Select approved available vehicle</option>{vehicles.map(v => <option key={v.id} value={v.id}>{v.plate_number} · {v.brand} {v.model} · {v.seat_capacity} seats</option>)}</select></label><label>Driver *<select name="driver_id" required defaultValue=""><option value="" disabled>Select approved driver</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.full_name} · {d.email}</option>)}</select></label>{vehicles.length === 0 && <p className="alert alert-error">No approved vehicles are available in this agency.</p>}{drivers.length === 0 && <p className="alert alert-error">No approved drivers are available in this agency.</p>}<button className="btn btn-primary btn-wide" disabled={busy || !vehicles.length || !drivers.length}>Submit for Fleet Manager approval</button></form></section></div>}
    </div>
  );
}

function vehiclesForFuel(rows: Row[], agencyId: string | null) {
  return rows.filter(r => r.agency_id === agencyId && r.approval_status === 'approved');
}
function glyphFor(view: View) {
  const glyphs: Record<View, string> = { dashboard:'▦', agencies:'⌂', applications:'▤', vehicles:'▰', drivers:'♙', assignments:'⇄', fuel:'◉', maintenance:'⌁', users:'♧', availability:'◷', reports:'▥' };
  return glyphs[view];
}
function welcomeLine(view: View, role: Role) {
  if (view === 'dashboard') return 'A clear view of your fleet, assignments and operational activity.';
  if (view === 'applications') return role === 'data_entry' ? 'Review requests and propose suitable vehicle and driver assignments.' : 'Review requests and track the approval lifecycle.';
  return 'Manage ' + titleByView[view].toLowerCase() + ' within your authorized access.';
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={'brand ' + (compact ? 'brand-compact' : '')}><div className="brand-crest" aria-label="Sarawak State Crest placeholder"><span>SC</span></div><div className="brand-copy"><strong>FMS</strong><small>FLEET MANAGEMENT SYSTEM</small></div></div>;
}
function SetupScreen() {
  return <div className="setup-page"><Brand /><div className="setup-card"><div className="status-mark">⚙</div><h2>Connect your FMS database</h2><p>The web interface is ready, but the Supabase project settings have not been supplied to this deployment.</p><ol><li>Copy <strong>web/.env.example</strong> to <strong>web/.env.local</strong>.</li><li>Set the Supabase project URL and publishable key.</li><li>Apply the migration in <strong>supabase/migrations</strong>.</li><li>Deploy the private storage policies and trusted admin/email functions before production use.</li></ol><div className="config-line">VITE_SUPABASE_URL<br />VITE_SUPABASE_PUBLISHABLE_KEY</div><p className="tiny-note">Never place a Supabase service-role or secret key in a VITE_* variable.</p></div></div>;
}
function PanelHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><span className="panel-accent" /></div>;
}

function Dashboard({ profile, counts, onNavigate }: { profile: Profile; counts: Record<string, number>; onNavigate: (v: View) => void }) {
  const role = profile.role;
  const stats = [
    {label:'Applications', value:counts.applications || 0, key:'applications' as View, tone:'blue', icon:'▤'},
    {label:'Vehicles', value:counts.vehicles || 0, key:'vehicles' as View, tone:'gold', icon:'▰'},
    {label:'Drivers', value:counts.drivers || 0, key:'drivers' as View, tone:'green', icon:'♙'},
    {label:'Assignments', value:counts.assignments || 0, key:'assignments' as View, tone:'violet', icon:'⇄'}
  ];
  return <div className="dashboard-stack">
    <section className="welcome-banner"><div><div className="eyebrow light"><span className="eyebrow-dot" /> FLEET OVERVIEW</div><h2>Good day, {profile.full_name.split(' ')[0]}.</h2><p>{role === 'super_admin' ? 'System-wide fleet oversight and agency administration.' : 'Here is the latest overview for your authorized fleet workspace.'}</p></div><div className="banner-mark">FMS<span>✦</span></div></section>
    <div className="stat-grid">{stats.map((s) => <button className="stat-card" key={s.label} onClick={() => onNavigate(s.key)}><div className={'stat-icon '+s.tone}>{s.icon}</div><div className="stat-top"><span>{s.label}</span><span className="stat-arrow">↗</span></div><strong>{s.value.toLocaleString()}</strong><small>Live records in your access scope</small></button>)}</div>
    <div className="two-col">
      <section className="panel"><PanelHeading title="Quick actions" subtitle="Continue with common fleet operations." /><div className="quick-actions">{(role === 'driver' ? [{view:'fuel' as View,title:'Submit fuel receipt',text:'Log a fuel purchase and upload receipt',symbol:'◉'},{view:'assignments' as View,title:'View assignments',text:'Check approved vehicle trips',symbol:'⇄'},{view:'availability' as View,title:'Update availability',text:'Record leave or course dates',symbol:'◷'}] : role === 'data_entry' ? [{view:'applications' as View,title:'Review applications',text:'Prepare vehicle and driver assignments',symbol:'▤'},{view:'vehicles' as View,title:'Register vehicle',text:'Submit a vehicle record for approval',symbol:'▰'},{view:'maintenance' as View,title:'Add maintenance',text:'Record vehicle servicing details',symbol:'⌁'}] : [{view:'applications' as View,title:'Review applications',text:'Track incoming vehicle requests',symbol:'▤'},{view:'assignments' as View,title:'Pending approvals',text:'Review proposed vehicle assignments',symbol:'⇄'},{view:'reports' as View,title:'Open reports',text:'View operational records and totals',symbol:'▥'}]).map(a => <button className="quick-action" key={a.view} onClick={() => onNavigate(a.view)}><span className="quick-symbol">{a.symbol}</span><span><strong>{a.title}</strong><small>{a.text}</small></span><span className="quick-arrow">→</span></button>)}</div></section>
      <section className="panel"><PanelHeading title="Workflow at a glance" subtitle="From request to confirmed trip." /><div className="workflow"><div className="workflow-step"><span>01</span><div><strong>Applicant submits</strong><small>Trip dates and one combined PDF</small></div><b>›</b></div><div className="workflow-step"><span>02</span><div><strong>Data Entry assigns</strong><small>Check vehicle and driver availability</small></div><b>›</b></div><div className="workflow-step"><span>03</span><div><strong>Fleet Manager approves</strong><small>Confirm assignment or reject with reason</small></div><b>›</b></div><div className="workflow-step"><span>04</span><div><strong>Monitoring updates</strong><small>Approved trips appear in the charts</small></div><b>✓</b></div></div></section>
    </div>
    <section className="panel"><PanelHeading title="System notes" subtitle="Items requiring configuration before production." /><div className="note-grid"><div><span className="note-dot gold-dot" /><strong>Official crest asset</strong><p>Replace the SC placeholder with the approved Sarawak State Crest file.</p></div><div><span className="note-dot blue-dot" /><strong>Email delivery</strong><p>Configure a trusted server-side email provider and verify sender domain.</p></div><div><span className="note-dot green-dot" /><strong>Staff access</strong><p>Create staff profiles through the protected administrator process.</p></div></div></section>
  </div>;
}

function DataTable({ rows, kind, loading, role, onAssign, onApprove, onReject, onCancel, onDocument }: { rows: Row[]; kind: string; loading: boolean; role: Role; onAssign?: (r: Row) => void; onApprove?: (r: Row) => void; onReject?: (r: Row) => void; onCancel?: (r: Row) => void; onDocument?: (path: string) => void }) {
  if (loading) return <Loading />;
  const columns: Record<string, {key:string;label:string}[]> = {
    agencies: [{key:'name',label:'Agency name'},{key:'code',label:'Code'},{key:'is_active',label:'Status'}],
    applications: [{key:'reference',label:'Reference'},{key:'applicant_name',label:'Applicant'},{key:'destination',label:'Destination'},{key:'purpose',label:'Purpose'},{key:'start_date',label:'Start'},{key:'end_date',label:'End'},{key:'document_path',label:'PDF'},{key:'status',label:'Status'}],
    vehicles: [{key:'brand',label:'Brand'},{key:'model',label:'Model'},{key:'vehicle_type',label:'Type'},{key:'plate_number',label:'Registration'},{key:'approval_status',label:'Approval'},{key:'vehicle_status',label:'Status'}],
    drivers: [{key:'full_name',label:'Driver'},{key:'email',label:'Email'},{key:'phone',label:'Phone'},{key:'availability_status',label:'Availability'},{key:'approval_status',label:'Approval'}],
    assignments: [{key:'application',label:'Request'},{key:'vehicle',label:'Vehicle'},{key:'driver',label:'Driver'},{key:'start_date',label:'Start'},{key:'end_date',label:'End'},{key:'status',label:'Status'}],
    fuel: [{key:'reporting_month',label:'Month'},{key:'purchase_date',label:'Purchase date'},{key:'odometer_reading',label:'Odometer'},{key:'litres',label:'Litres'},{key:'amount_rm',label:'Cost (RM)'},{key:'receipt_path',label:'Receipt'},{key:'status',label:'Status'}],
    maintenance: [{key:'vehicle_id',label:'Vehicle ID'},{key:'category',label:'Category'},{key:'description',label:'Description'},{key:'date_reported',label:'Reported'},{key:'documents',label:'Documents'},{key:'status',label:'Status'}],
    users: [{key:'full_name',label:'Name'},{key:'role',label:'Role'},{key:'agency_id',label:'Agency ID'},{key:'status',label:'Account'}]
  };
  const cols = columns[kind] || [];
  function value(row: Row, key: string) {
    if (key === 'application') return row.applications?.reference || row.application_id?.slice(0,8) || '—';
    if (key === 'vehicle') return row.vehicles ? row.vehicles.plate_number + ' · ' + row.vehicles.brand + ' ' + row.vehicles.model : row.vehicle_id?.slice(0,8) || '—';
    if (key === 'driver') return row.drivers?.full_name || row.driver_id?.slice(0,8) || '—';
    if (key === 'is_active') return row.is_active ? 'Active' : 'Inactive';
    if (key === 'documents') return (row.documents || []).length ? row.documents.length + ' file(s)' : '—';
    const v = row[key];
    if (['start_date','end_date','purchase_date','date_reported'].includes(key)) return dateText(v);
    if (key === 'amount_rm') return moneyText(v);
    if (key === 'role') return roleTitles[v as Role] || statusText(v);
    return v === null || v === undefined || v === '' ? '—' : String(v);
  }
  return <div className="table-wrap">{rows.length === 0 ? <div className="empty-state"><div>▤</div><strong>No records yet</strong><p>Records will appear here when they are saved in FMS.</p></div> : <table><thead><tr>{cols.map(c => <th key={c.key}>{c.label}</th>)}{((kind === 'applications' && ['data_entry','fleet_manager','super_admin'].includes(role)) || (kind === 'assignments' && (role === 'fleet_manager' || role === 'super_admin')) || ((kind === 'vehicles' || kind === 'drivers' || kind === 'users') && (role === 'fleet_manager' || role === 'super_admin')) || (kind === 'agencies' && role === 'super_admin') || (kind === 'fuel' && (role === 'fleet_manager' || role === 'super_admin'))) && <th>Action</th>}</tr></thead><tbody>{rows.map(row => <tr key={row.id || row.reference}>{cols.map(c => <td key={c.key}>{c.key === 'document_path' && row.document_path ? <button className="btn btn-small btn-outline" onClick={() => onDocument?.(row.document_path)}>Open PDF</button> : c.key === 'receipt_path' && row.receipt_path ? <button className="btn btn-small btn-outline" onClick={() => onDocument?.(row.receipt_path)}>Open receipt</button> : c.key === 'documents' && row.documents?.length ? <div className="doc-buttons">{row.documents.map((doc: Row) => <button className="btn btn-small btn-outline" key={doc.id} onClick={() => onDocument?.(doc.file_path)}>{statusText(doc.document_type)}</button>)}</div> : c.key.includes('status') ? <span className={'status-pill ' + String(row[c.key] || '').replaceAll('_','-')}>{statusText(value(row,c.key))}</span> : value(row,c.key)}</td>)}{kind === 'applications' && ['data_entry','fleet_manager','super_admin'].includes(role) ? <td>{['pending_assignment','returned_for_correction'].includes(row.status) ? <button className="btn btn-small btn-outline" onClick={() => onAssign?.(row)}>Assign</button> : <span className="muted">—</span>}</td> : null}{kind === 'assignments' && (role === 'fleet_manager' || role === 'super_admin') ? <td>{row.status === 'proposed' ? <div className="action-pair"><button className="btn btn-small btn-primary" onClick={() => onApprove?.(row)}>Approve</button><button className="btn btn-small btn-danger" onClick={() => onReject?.(row)}>Reject</button></div> : row.status === 'approved' ? <button className="btn btn-small btn-danger" onClick={() => onCancel?.(row)}>Cancel trip</button> : <span className="muted">—</span>}</td> : null}{(kind === 'vehicles' || kind === 'drivers') && (role === 'fleet_manager' || role === 'super_admin') ? <td>{row.approval_status === 'pending' || row.approval_status === 'returned' ? <button className="btn btn-small btn-primary" onClick={() => onApprove?.(row)}>Approve</button> : <span className="muted">—</span>}</td> : null}{kind === 'users' && (role === 'fleet_manager' || role === 'super_admin') ? <td>{row.status === 'pending' ? <button className="btn btn-small btn-primary" onClick={() => onApprove?.(row)}>Approve account</button> : <span className="muted">—</span>}</td> : null}{kind === 'agencies' && role === 'super_admin' ? <td><button className={'btn btn-small ' + (row.is_active ? 'btn-danger' : 'btn-primary')} onClick={() => onApprove?.(row)}>{row.is_active ? 'Deactivate' : 'Activate'}</button></td> : null}{kind === 'fuel' && (role === 'fleet_manager' || role === 'super_admin') ? <td>{row.status === 'submitted' ? <div className="action-pair"><button className="btn btn-small btn-primary" onClick={() => onApprove?.(row)}>Approve</button><button className="btn btn-small btn-danger" onClick={() => onReject?.(row)}>Return</button></div> : <span className="muted">—</span>}</td> : null}</tr>)}</tbody></table>}</div>;
}
function Loading() { return <div className="loading-state"><span className="spinner" />Loading records…</div>; }
function AssignmentCalendar({ rows }: { rows: Row[] }) {
  const [month, setMonth] = useState(() => new Date().getUTCMonth());
  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthLabel = new Intl.DateTimeFormat('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthStart);
  const startOffset = (monthStart.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = Array.from({ length: startOffset + daysInMonth }, (_, i) => i < startOffset ? null : i - startOffset + 1);
  const approved = rows.filter(row => row.status === 'approved');
  const dayKey = (day: number) => new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  const countForDay = (day: number) => approved.filter(row => row.start_date <= dayKey(day) && row.end_date >= dayKey(day)).length;
  function changeMonth(delta: number) {
    const next = new Date(Date.UTC(year, month + delta, 1));
    setMonth(next.getUTCMonth()); setYear(next.getUTCFullYear());
  }
  return <section className="panel calendar-panel">
    <div className="calendar-header"><div><div className="card-kicker">APPROVED TRIPS</div><h2>Assignment calendar</h2><p>Only confirmed assignments count toward the daily schedule.</p></div><div className="calendar-controls"><button className="btn btn-small btn-outline" onClick={() => changeMonth(-1)}>←</button><strong>{monthLabel}</strong><button className="btn btn-small btn-outline" onClick={() => changeMonth(1)}>→</button></div></div>
    <div className="calendar-grid">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => <div className="calendar-weekday" key={day}>{day}</div>)}{cells.map((day, index) => day === null ? <div className="calendar-blank" key={'blank-'+index} /> : <div className={'calendar-day ' + (countForDay(day) ? 'has-trips' : '')} key={day}><span>{day}</span>{countForDay(day) > 0 && <small>{countForDay(day)} trip{countForDay(day) === 1 ? '' : 's'}</small>}</div>)}</div>
    <div className="calendar-legend"><span><i /> Confirmed assignments</span><span>{approved.length} approved assignment(s) in the loaded records</span></div>
  </section>;
}

function FuelSummary({ rows }: { rows: Row[] }) {
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuching', year: 'numeric', month: '2-digit' }).format(new Date());
  const monthRows = rows.filter(row => row.reporting_month === month);
  const amount = monthRows.reduce((sum, row) => sum + Number(row.amount_rm || 0), 0);
  const litres = monthRows.reduce((sum, row) => sum + Number(row.litres || 0), 0);
  const avg = litres > 0 ? amount / litres : 0;
  return <div className="fuel-summary"><div className="fuel-summary-card"><small>Current month · {month}</small><span>Recorded fuel expenditure</span><strong>{moneyText(amount)}</strong></div><div className="fuel-summary-card"><small>Volume</small><span>Total litres recorded</span><strong>{litres.toLocaleString('en-MY',{maximumFractionDigits:2})} L</strong></div><div className="fuel-summary-card"><small>Average price</small><span>Based on recorded transactions</span><strong>{moneyText(avg)} / L</strong></div></div>;
}

function Reports({ counts }: { counts: Record<string, number> }) {
  const items = [{label:'Applications',value:counts.applications || 0},{label:'Vehicles',value:counts.vehicles || 0},{label:'Drivers',value:counts.drivers || 0},{label:'Assignments',value:counts.assignments || 0},{label:'Fuel transactions',value:counts.fuel_transactions || 0},{label:'Maintenance records',value:counts.maintenance_records || 0}];
  const max = Math.max(1, ...items.map(i => i.value));
  return <section className="panel"><PanelHeading title="Operational snapshot" subtitle="Live record counts from the database, filtered by your permissions." /><div className="report-bars">{items.map(i => <div className="report-bar-row" key={i.label}><div><span>{i.label}</span><strong>{i.value}</strong></div><div className="bar-track"><span style={{width:(i.value / max * 100) + '%'}} /></div></div>)}</div><p className="muted report-foot">Detailed PDF and Excel exports can be enabled after deployment and reporting templates are configured.</p></section>;
}
