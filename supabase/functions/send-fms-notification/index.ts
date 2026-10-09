import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};
function reply(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders });
}
function esc(v: unknown) {
  return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FMS_EMAIL_FROM");
  if (!key || !from) return { status: "not_configured", error: null };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html })
  });
  if (!response.ok) return { status: "failed", error: await response.text() };
  return { status: "sent", error: null };
}

async function sendWhatsApp(phone: string, reference: string, statusMessage: string, detail: string) {
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const graphVersion = Deno.env.get("WHATSAPP_GRAPH_API_VERSION");
  const templateName = Deno.env.get("WHATSAPP_TEMPLATE_NAME");
  const templateLanguage = Deno.env.get("WHATSAPP_TEMPLATE_LANGUAGE") || "en_US";
  if (!accessToken || !phoneNumberId || !graphVersion || !templateName) {
    return { status: "not_configured", error: null };
  }
  if (!/^v\d+\.\d+$/.test(graphVersion)) {
    return { status: "failed", error: "WHATSAPP_GRAPH_API_VERSION must look like vNN.0" };
  }
  const recipient = normalizeWhatsAppNumber(phone);
  if (!recipient) return { status: "failed", error: "Recipient phone number is invalid" };

  const response = await fetch("https://graph.facebook.com/" + graphVersion + "/" + phoneNumberId + "/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: reference.slice(0, 200) },
            { type: "text", text: statusMessage.slice(0, 200) },
            { type: "text", text: detail.slice(0, 200) }
          ]
        }]
      }
    })
  });
  const responseText = await response.text();
  if (!response.ok) return { status: "failed", error: responseText.slice(0, 1000) };
  return { status: "sent", error: null };
}

function normalizeWhatsAppNumber(raw: string): string | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+")) return digits.length >= 10 && digits.length <= 15 ? digits : null;
  if (digits.startsWith("60")) return digits.length >= 10 && digits.length <= 15 ? digits : null;
  if (digits.startsWith("0")) digits = "60" + digits.slice(1);
  else return null;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed" });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(500, { error: "Notification service is not configured" });
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Authentication required" });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return reply(401, { error: "Invalid session" });

  try {
    const body = await request.json();
    const type = String(body?.type || "");
    const applicationId = String(body?.application_id || "");
    const assignmentId = String(body?.assignment_id || "");
    const fuelTransactionId = String(body?.fuel_transaction_id || "");
    const registryEntityId = String(body?.entity_id || "");
    const changeRequestId = String(body?.change_request_id || "");
    const registryEntityType = String(body?.entity_type || "");
    const registryDecision = String(body?.decision || "");
    const { data: actor } = await admin.from("fms_profiles").select("id,full_name,email,role,agency_id,status").eq("id", authData.user.id).maybeSingle();
    if (!actor || actor.status !== "active") return reply(403, { error: "An active FMS account is required" });
    const isSubmissionNotice = type === "assignment-submitted";
    const isFuelSubmission = type === "fuel-submitted";
    const isRegistrySubmission = type === "registry-record-submitted" || type === "registry-change-submitted";
    const isRegistryReview = type === "registry-record-reviewed" || type === "registry-change-reviewed";
    if (isSubmissionNotice) {
      if (!["data_entry","fleet_manager","super_admin"].includes(actor.role)) return reply(403, { error: "Only authorized fleet staff may submit assignments for review" });
    } else if (isFuelSubmission) {
      if (actor.role !== "driver") return reply(403, { error: "Only the assigned driver may notify reviewers about a fuel submission" });
    } else if (isRegistrySubmission) {
      if (!["data_entry","fleet_manager","super_admin"].includes(actor.role)) return reply(403, { error: "Only authorized fleet staff may submit registry records for review" });
    } else if (isRegistryReview) {
      if (!["fleet_manager","super_admin"].includes(actor.role)) return reply(403, { error: "Only a Fleet Manager or Super Admin can send registry review notifications" });
    } else if (!["fleet_manager","super_admin"].includes(actor.role)) {
      return reply(403, { error: "Only authorized Fleet Managers can send decision notifications" });
    }
    const fuelDecision = type === "fuel-approved" || type === "fuel-returned";
    if (!["assignment-approved","assignment-rejected","assignment-returned","assignment-cancelled","assignment-submitted","fuel-approved","fuel-returned","fuel-submitted","registry-record-submitted","registry-record-reviewed","registry-change-submitted","registry-change-reviewed"].includes(type)) return reply(400, { error: "Unsupported notification type" });

    if (type === "registry-record-submitted" || type === "registry-record-reviewed") {
      if (!registryEntityId || !["vehicle","driver"].includes(registryEntityType)) return reply(400,{error:"Registry entity type and ID are required"});
      const table = registryEntityType === "vehicle" ? "fms_vehicles" : "fms_drivers";
      const {data: record,error: recordError} = await admin.from(table).select("*").eq("id",registryEntityId).maybeSingle();
      if (recordError || !record) return reply(404,{error:"Registry record not found"});
      if (actor.role !== "super_admin" && actor.agency_id !== record.agency_id) return reply(403,{error:"Agency access denied"});

      if (type === "registry-record-submitted") {
        if (record.approval_status !== "pending") return reply(409,{error:"Registry record is not pending review"});
        const {data: reviewers,error: reviewerError} = await admin.from("fms_profiles")
          .select("id,full_name,email,role,agency_id").eq("status","active").in("role",["fleet_manager","super_admin"]);
        if (reviewerError) return reply(503,{error:"Registry reviewers could not be checked"});
        const recipients = (reviewers || []).filter((person: Record<string,any>) =>
          person.role === "super_admin" || person.agency_id === record.agency_id
        );
        const label = registryEntityType === "vehicle"
          ? String(record.brand || "") + " " + String(record.model || "") + " (" + String(record.plate_number || "") + ")"
          : String(record.full_name || record.email || "Driver");
        const subject = "FMS " + (registryEntityType === "vehicle" ? "vehicle" : "driver") + " requires approval — " + label;
        const statuses = await Promise.all(recipients.filter((person: Record<string,any>) => person.id !== actor.id).map(async (person: Record<string,any>) => {
          const result = await sendEmail(String(person.email || ""),subject,
            "<p>Dear " + esc(person.full_name || "Fleet Manager") + ",</p><p>A " + esc(registryEntityType) + " registration has been submitted or resubmitted and awaits review.</p><p><strong>Record:</strong> " + esc(label) + "<br><strong>Submitted by:</strong> " + esc(actor.full_name || actor.email) + "</p><p>Sign in to FMS to approve, reject or return the record.</p><p>Fleet Management System — Sarawak</p>");
          await admin.from("fms_notifications").insert({
            recipient_profile_id:person.id,recipient_email:person.email,subject,
            body:"Registry record awaiting review: " + label,
            notification_type:"registry_record_pending_review",related_table:table,related_record_id:record.id,
            email_status:result.status,email_error:result.error ? String(result.error).slice(0,1000) : null,
            sent_at:result.status === "sent" ? new Date().toISOString() : null
          });
          return {recipient:person.email,status:result.status};
        }));
        return reply(200,{success:true,recipients:statuses.length,statuses});
      }

      const expected = registryDecision === "approve" ? "approved" : registryDecision === "reject" ? "rejected" : registryDecision === "return" ? "returned" : "";
      if (!expected || record.approval_status !== expected) return reply(409,{error:"Registry status does not match the review decision"});
      const {data: audit,error: auditError} = await admin.from("fms_audit_logs").select("id")
        .eq("actor_profile_id",actor.id).eq("action","registry_" + registryDecision)
        .eq("entity_type",registryEntityType).eq("entity_id",registryEntityId).order("created_at",{ascending:false}).limit(1).maybeSingle();
      if (auditError || !audit) return reply(403,{error:"A matching registry decision audit event was not found"});
      const recipients: Array<{profileId:string|null;email:string;name:string}> = [];
      if (record.created_by) {
        const {data: creator} = await admin.from("fms_profiles").select("id,full_name,email").eq("id",record.created_by).maybeSingle();
        if (creator?.email) recipients.push({profileId:creator.id,email:creator.email,name:creator.full_name || "Fleet staff"});
      }
      if (registryEntityType === "driver" && record.email) {
        recipients.push({profileId:record.profile_id || null,email:record.email,name:record.full_name || "Driver"});
      }
      const uniqueRecipients = Array.from(new Map(recipients.map(person => [person.email.toLowerCase(),person])).values());
      const label = registryEntityType === "vehicle"
        ? String(record.brand || "") + " " + String(record.model || "") + " (" + String(record.plate_number || "") + ")"
        : String(record.full_name || record.email || "Driver");
      const decisionLabel = expected === "approved" ? "approved" : expected === "rejected" ? "rejected" : "returned for correction";
      const subject = "FMS " + registryEntityType + " registration " + decisionLabel + " — " + label;
      const statuses = await Promise.all(uniqueRecipients.map(async person => {
        const result = await sendEmail(person.email,subject,
          "<p>Dear " + esc(person.name) + ",</p><p>The " + esc(registryEntityType) + " registration <strong>" + esc(label) + "</strong> was " + decisionLabel + ".</p>" +
          (record.decision_reason ? "<p><strong>Reason / instructions:</strong> " + esc(record.decision_reason) + "</p>" : "") +
          "<p>Fleet Management System — Sarawak</p>");
        await admin.from("fms_notifications").insert({
          recipient_profile_id:person.profileId,recipient_email:person.email,subject,
          body:subject + (record.decision_reason ? ". " + String(record.decision_reason) : ""),
          notification_type:"registry_record_" + expected,related_table:table,related_record_id:record.id,
          email_status:result.status,email_error:result.error ? String(result.error).slice(0,1000) : null,
          sent_at:result.status === "sent" ? new Date().toISOString() : null
        });
        return {recipient:person.email,status:result.status};
      }));
      return reply(200,{success:true,emailStatus:statuses.some(item => item.status === "failed") ? "failed" : statuses.some(item => item.status === "not_configured") ? "not_configured" : "sent",statuses});
    }

    if (type === "registry-change-submitted" || type === "registry-change-reviewed") {
      if (!changeRequestId) return reply(400,{error:"Registry change request ID is required"});
      const {data: change,error: changeError} = await admin.from("fms_registry_change_requests").select("*").eq("id",changeRequestId).maybeSingle();
      if (changeError || !change) return reply(404,{error:"Registry change request not found"});
      if (actor.role !== "super_admin" && actor.agency_id !== change.agency_id) return reply(403,{error:"Agency access denied"});
      const entityLabel = String(change.entity_type || "registry") + " " + String(change.entity_id || "").slice(0,8);
      if (type === "registry-change-submitted") {
        if (change.status !== "pending" || change.submitted_by !== actor.id) return reply(409,{error:"Only the owner can notify reviewers about a pending change request"});
        const {data: prior} = await admin.from("fms_notifications").select("id").eq("related_table","fms_registry_change_requests").eq("related_record_id",change.id).eq("notification_type","registry_change_pending_review").limit(1);
        if (prior?.length) return reply(200,{success:true,already_notified:true,recipients:0,statuses:[]});
        const {data: reviewers,error: reviewerError} = await admin.from("fms_profiles")
          .select("id,full_name,email,role,agency_id").eq("status","active").in("role",["fleet_manager","super_admin"]);
        if (reviewerError) return reply(503,{error:"Registry reviewers could not be checked"});
        const recipients = (reviewers || []).filter((person: Record<string,any>) => person.role === "super_admin" || person.agency_id === change.agency_id);
        const subject = "FMS registry change requires approval — " + entityLabel;
        const statuses = await Promise.all(recipients.filter((person: Record<string,any>) => person.id !== actor.id).map(async (person: Record<string,any>) => {
          const result = await sendEmail(String(person.email || ""),subject,
            "<p>Dear " + esc(person.full_name || "Fleet Manager") + ",</p><p>A change to an approved " + esc(change.entity_type) + " record is awaiting review.</p><p><strong>Proposed changes:</strong> " + esc(JSON.stringify(change.proposed_changes)) + "<br><strong>Reason:</strong> " + esc(change.reason) + "</p><p>Sign in to FMS to approve, reject or return this request.</p><p>Fleet Management System — Sarawak</p>");
          await admin.from("fms_notifications").insert({
            recipient_profile_id:person.id,recipient_email:person.email,subject,
            body:subject + ": " + String(change.reason || ""),
            notification_type:"registry_change_pending_review",related_table:"fms_registry_change_requests",related_record_id:change.id,
            email_status:result.status,email_error:result.error ? String(result.error).slice(0,1000) : null,
            sent_at:result.status === "sent" ? new Date().toISOString() : null
          });
          return {recipient:person.email,status:result.status};
        }));
        return reply(200,{success:true,recipients:statuses.length,statuses});
      }

      const expected = registryDecision === "approve" ? "approved" : registryDecision === "reject" ? "rejected" : registryDecision === "return" ? "returned" : "";
      if (!expected || change.status !== expected) return reply(409,{error:"Registry change status does not match the review decision"});
      const {data: audit,error: auditError} = await admin.from("fms_audit_logs").select("id")
        .eq("actor_profile_id",actor.id).eq("action","registry_change_" + registryDecision)
        .eq("entity_type",change.entity_type).eq("entity_id",change.entity_id).order("created_at",{ascending:false}).limit(1).maybeSingle();
      if (auditError || !audit) return reply(403,{error:"A matching registry change audit event was not found"});
      const {data: requester} = await admin.from("fms_profiles").select("id,full_name,email").eq("id",change.submitted_by).maybeSingle();
      if (!requester?.email) return reply(404,{error:"Change request submitter email not found"});
      const label = "FMS " + change.entity_type + " change " + expected;
      const subject = label + " — " + entityLabel;
      const result = await sendEmail(requester.email,subject,
        "<p>Dear " + esc(requester.full_name || "FMS user") + ",</p><p>Your proposed change to <strong>" + esc(entityLabel) + "</strong> was " + expected + ".</p>" +
        (change.decision_reason ? "<p><strong>Reason / instructions:</strong> " + esc(change.decision_reason) + "</p>" : "") +
        "<p>Fleet Management System — Sarawak</p>");
      const notificationType = "registry_change_" + expected;
      const {data: existing} = await admin.from("fms_notifications").select("id")
        .eq("recipient_profile_id",requester.id).eq("related_table","fms_registry_change_requests")
        .eq("related_record_id",change.id).eq("notification_type",notificationType)
        .order("created_at",{ascending:false}).limit(1).maybeSingle();
      const notificationRow = {
        recipient_profile_id:requester.id,recipient_email:requester.email,subject,body:subject + (change.decision_reason ? ". " + String(change.decision_reason) : ""),
        notification_type:notificationType,related_table:"fms_registry_change_requests",related_record_id:change.id,
        email_status:result.status,email_error:result.error ? String(result.error).slice(0,1000) : null,
        sent_at:result.status === "sent" ? new Date().toISOString() : null
      };
      if (existing?.id) await admin.from("fms_notifications").update(notificationRow).eq("id",existing.id);
      else await admin.from("fms_notifications").insert(notificationRow);
      return reply(200,{success:true,emailStatus:result.status});
    }

    if (isFuelSubmission) {
      if (!fuelTransactionId) return reply(400, { error: "Fuel transaction ID is required" });
      const { data: fuel, error: fuelError } = await admin.from("fms_fuel_transactions")
        .select("id,agency_id,driver_id,vehicle_id,reporting_month,purchase_date,odometer_reading,litres,amount_rm,status")
        .eq("id", fuelTransactionId).maybeSingle();
      if (fuelError || !fuel) return reply(404, { error: "Fuel transaction not found" });
      if (fuel.status !== "submitted") return reply(409, { error: "Only submitted fuel reports can notify reviewers" });
      const { data: driver, error: driverError } = await admin.from("fms_drivers")
        .select("id,profile_id,agency_id,full_name,account_status,approval_status")
        .eq("id", fuel.driver_id).eq("profile_id", actor.id).maybeSingle();
      if (driverError || !driver || driver.agency_id !== fuel.agency_id ||
          driver.account_status !== "active" || driver.approval_status !== "approved" ||
          actor.agency_id !== fuel.agency_id) {
        return reply(403, { error: "The authenticated driver is not authorized for this fuel report" });
      }
      const { data: staffRows, error: staffError } = await admin.from("fms_profiles")
        .select("id,full_name,email,role,agency_id")
        .eq("status","active").in("role",["fleet_manager","super_admin"]);
      if (staffError) return reply(503, { error: "Reviewer list could not be checked" });
      const recipients = (staffRows || []).filter((staff: Record<string,any>) =>
        staff.role === "super_admin" || staff.agency_id === fuel.agency_id
      );
      if (!recipients.length) return reply(503, { error: "No active Fleet Manager or Super Admin is configured to receive this report" });
      const subject = "FMS fuel report awaiting review — " + fuel.reporting_month;
      const statuses = await Promise.all(recipients.map(async (staff: Record<string,any>) => {
        const result = await sendEmail(
          String(staff.email || ""), subject,
          "<p>Dear " + esc(staff.full_name || "Fleet Manager") + ",</p>" +
          "<p>A fuel report has been submitted and is awaiting review.</p>" +
          "<p><strong>Driver:</strong> " + esc(driver.full_name) +
          "<br><strong>Reporting month:</strong> " + esc(fuel.reporting_month) +
          "<br><strong>Purchase date:</strong> " + esc(fuel.purchase_date) +
          "<br><strong>Fuel quantity:</strong> " + Number(fuel.litres || 0) + " L" +
          "<br><strong>Total cost:</strong> RM " + Number(fuel.amount_rm || 0).toFixed(2) +
          "<br><strong>Odometer:</strong> " + Number(fuel.odometer_reading || 0) + " km</p>" +
          "<p>Sign in to FMS to review the report and receipt.</p><p>Fleet Management System — Sarawak</p>"
        );
        await admin.from("fms_notifications").insert({
          recipient_profile_id: staff.id, recipient_email: staff.email, subject,
          body: "Fuel report awaiting review for " + fuel.reporting_month,
          notification_type: "fuel_report_submitted", related_table: "fms_fuel_transactions",
          related_record_id: fuel.id, email_status: result.status,
          email_error: result.error ? String(result.error).slice(0,1000) : null,
          sent_at: result.status === "sent" ? new Date().toISOString() : null
        });
        return { recipient: staff.email, status: result.status };
      }));
      return reply(200, { success: true, recipients: recipients.length, statuses });
    }

    if (fuelDecision) {
      if (!fuelTransactionId) return reply(400, { error: "Fuel transaction ID is required" });
      const { data: fuel, error: fuelError } = await admin.from("fms_fuel_transactions").select("*").eq("id",fuelTransactionId).maybeSingle();
      if (fuelError || !fuel) return reply(404, { error: "Fuel transaction not found" });
      if (actor.role !== "super_admin" && actor.agency_id !== fuel.agency_id) return reply(403, { error: "Agency access denied" });
      const expectedStatus = type === "fuel-approved" ? "approved" : "returned";
      if (fuel.status !== expectedStatus) return reply(400, { error: "Fuel transaction status does not match the notification" });
      const { data: driver } = await admin.from("fms_drivers").select("profile_id,full_name,email,phone,whatsapp_opt_in").eq("id",fuel.driver_id).maybeSingle();
      if (!driver) return reply(404, { error: "Assigned driver not found" });
      const approved = type === "fuel-approved";
      const subject = (approved ? "FMS fuel report approved — " : "FMS fuel report returned — ") + fuel.reporting_month;
      const reasonText = approved ? "" : "<p><strong>Correction required:</strong> " + esc(fuel.review_remarks || body?.reason || "Please contact your Fleet Manager for details.") + "</p>";
      const html = "<p>Dear " + esc(driver.full_name) + ",</p><p>Your fuel report for <strong>" + esc(fuel.reporting_month) + "</strong> has been " + (approved ? "approved" : "returned for correction") + ".</p>" +
        "<p><strong>Fuel volume:</strong> " + Number(fuel.litres || 0) + " L<br><strong>Total cost:</strong> RM " + Number(fuel.amount_rm || 0).toFixed(2) +
        "<br><strong>Odometer:</strong> " + esc(fuel.odometer_reading ?? "Not recorded") + "</p>" + reasonText + "<p>Fleet Management System — Sarawak</p>";
      const emailResult = await sendEmail(String(driver.email || ""),subject,html);
      const whatsappResult = driver.whatsapp_opt_in && driver.phone
        ? await sendWhatsApp(String(driver.phone),"FUEL-" + String(fuel.reporting_month),approved ? "Fuel report approved" : "Fuel report returned","Month " + String(fuel.reporting_month) + "; RM " + Number(fuel.amount_rm || 0).toFixed(2))
        : {status:"not_opted_in",error:null};
      await admin.from("fms_notifications").insert({
        recipient_profile_id:driver.profile_id,recipient_email:driver.email,subject,body:subject + " " + String(fuel.review_remarks || ""),
        notification_type:approved ? "fuel_report_approved" : "fuel_report_returned",
        related_table:"fms_fuel_transactions",related_record_id:fuel.id,
        email_status:emailResult.status,email_error:emailResult.error ? String(emailResult.error).slice(0,1000) : null,
        sent_at:emailResult.status === "sent" ? new Date().toISOString() : null,
        whatsapp_status:whatsappResult.status,whatsapp_error:whatsappResult.error ? String(whatsappResult.error).slice(0,1000) : null,
        whatsapp_sent_at:whatsappResult.status === "sent" ? new Date().toISOString() : null
      });
      return reply(200,{success:true,emailStatus:emailResult.status,whatsappStatus:whatsappResult.status});
    }

    const { data: application } = await admin.from("fms_applications").select("*").eq("id", applicationId).maybeSingle();
    if (!application) return reply(404, { error: "Application not found" });
    if (actor.role !== "super_admin" && actor.agency_id !== application.agency_id) return reply(403, { error: "Agency access denied" });
    if (type === "assignment-approved" && application.status !== "approved") return reply(409, { error: "Application is not in the approved state" });
    if (type === "assignment-rejected" && application.status !== "rejected") return reply(409, { error: "Application is not in the rejected state" });
    if (type === "assignment-returned" && application.status !== "returned_for_correction") return reply(409, { error: "Application is not in the returned-for-correction state" });

    if (isSubmissionNotice) {
      if (application.status !== "pending_manager_approval") return reply(400, { error: "Application is not waiting for Fleet Manager approval" });
      const { data: assignments, error: assignmentError } = await admin.from("fms_assignments")
        .select("id,driver_id,vehicle_id,start_date,end_date").eq("application_id", applicationId).eq("status","proposed");
      if (assignmentError) return reply(503, { error: "Proposed assignments could not be checked" });
      if (!assignments || assignments.length !== Number(application.vehicles_requested)) {
        return reply(400, { error: "All requested vehicle assignments must be submitted before notifying reviewers" });
      }
      const { data: alreadyNotified } = await admin.from("fms_notifications")
        .select("id").eq("related_table","fms_applications").eq("related_record_id",applicationId)
        .eq("notification_type","assignment_pending_approval").limit(1);
      if (alreadyNotified && alreadyNotified.length) return reply(200, { success:true, already_notified:true, recipients:0, statuses:[] });

      const driverIds = Array.from(new Set(assignments.map((a: Record<string,any>) => a.driver_id)));
      const vehicleIds = Array.from(new Set(assignments.map((a: Record<string,any>) => a.vehicle_id)));
      const [{ data: driverRows }, { data: vehicleRows }] = await Promise.all([
        admin.from("fms_drivers").select("id,full_name").in("id",driverIds),
        admin.from("fms_vehicles").select("id,brand,model,plate_number,seat_capacity").in("id",vehicleIds)
      ]);
      const driverById = new Map((driverRows || []).map((item: Record<string,any>) => [item.id,item]));
      const vehicleById = new Map((vehicleRows || []).map((item: Record<string,any>) => [item.id,item]));
      const assignmentDetails = assignments.map((item: Record<string,any>, index: number) => {
        const driver = driverById.get(item.driver_id);
        const vehicle = vehicleById.get(item.vehicle_id);
        return "<li>Vehicle " + (index + 1) + ": " + esc(vehicle?.brand || "") + " " + esc(vehicle?.model || "") +
          " (" + esc(vehicle?.plate_number || "") + ") — Driver: " + esc(driver?.full_name || "Not found") +
          "; seats: " + Number(vehicle?.seat_capacity || 0) + "</li>";
      }).join("");
      const { data: staffRows, error: staffError } = await admin.from("fms_profiles")
        .select("id,full_name,email,role,agency_id").eq("status","active").in("role",["fleet_manager","super_admin"]);
      if (staffError) return reply(503, { error: "Reviewer list could not be checked" });
      const recipients = (staffRows || []).filter((staff: Record<string,any>) => staff.role === "super_admin" || staff.agency_id === application.agency_id);
      const subject = "FMS assignment requires approval — " + application.reference;
      const statuses = await Promise.all(recipients.map(async (staff: Record<string,any>) => {
        const result = await sendEmail(
          String(staff.email || ""), subject,
          "<p>Dear " + esc(staff.full_name || "Fleet Manager") + ",</p><p>All vehicle assignments for request <strong>" + esc(application.reference) + "</strong> have been submitted and are awaiting approval.</p>" +
          "<p><strong>Applicant:</strong> " + esc(application.applicant_name) +
          "<br><strong>Organization:</strong> " + esc(application.applicant_agency_name) +
          "<br><strong>Destination:</strong> " + esc(application.destination) +
          "<br><strong>Travel dates:</strong> " + esc(application.start_date) + " to " + esc(application.end_date) +
          "<br><strong>Passengers:</strong> " + Number(application.passenger_count) +
          "<br><strong>Vehicles requested:</strong> " + Number(application.vehicles_requested) + "</p><ul>" + assignmentDetails +
          "</ul><p>Sign in to FMS to approve, reject or return the application.</p><p>Fleet Management System — Sarawak</p>"
        );
        await admin.from("fms_notifications").insert({
          recipient_profile_id:staff.id, recipient_email:staff.email, subject,
          body:"Application " + application.reference + " is awaiting approval.",
          notification_type:"assignment_pending_approval", related_table:"fms_applications", related_record_id:application.id,
          email_status:result.status, email_error:result.error ? String(result.error).slice(0,1000) : null,
          sent_at:result.status === "sent" ? new Date().toISOString() : null
        });
        return {recipient:staff.email,status:result.status};
      }));
      return reply(200, {success:true,recipients:recipients.length,statuses});
    }

    let driver: Record<string, any> | null = null;
    let vehicle: Record<string, any> | null = null;
    if (assignmentId) {
      const { data: assignment } = await admin.from("fms_assignments").select("id,application_id,driver_id,vehicle_id,status,start_date,end_date").eq("id", assignmentId).eq("application_id", applicationId).maybeSingle();
      if (!assignment) return reply(404, { error: "Assignment not found for this application" });
      if (type === "assignment-cancelled" && assignment.status !== "cancelled") return reply(409, { error: "Assignment must be cancelled before sending a cancellation notification" });
      if (type === "assignment-approved" && assignment.status !== "approved") return reply(409, { error: "Assignment is not approved" });
      if (type === "assignment-rejected" && assignment.status !== "rejected") return reply(409, { error: "Assignment is not rejected" });
      if (assignment) {
        const [driverResult, vehicleResult] = await Promise.all([
          admin.from("fms_drivers").select("profile_id,full_name,email,phone,whatsapp_opt_in").eq("id", assignment.driver_id).maybeSingle(),
          admin.from("fms_vehicles").select("brand,model,plate_number").eq("id", assignment.vehicle_id).maybeSingle()
        ]);
        driver = driverResult.data;
        vehicle = vehicleResult.data;
      }
    }

    const isApproved = type === "assignment-approved";
    const isReturned = type === "assignment-returned";
    const subject = isApproved ? "FMS vehicle request approved — " + application.reference
      : type === "assignment-rejected" ? "FMS vehicle request rejected — " + application.reference
      : isReturned ? "FMS vehicle request returned for correction — " + application.reference
      : "FMS assignment cancelled — " + application.reference;
    let details = vehicle && driver
      ? "<p><strong>Driver:</strong> " + esc(driver.full_name) + "<br><strong>Vehicle:</strong> " + esc(vehicle.brand) + " " + esc(vehicle.model) + " (" + esc(vehicle.plate_number) + ")<br><strong>Travel dates:</strong> " + esc(application.start_date) + " to " + esc(application.end_date) + "</p>"
      : "";
    if (type === "assignment-approved" && body?.notifyApplicant !== false) {
      const { data: approvedAssignments, error: approvedAssignmentsError } = await admin.from("fms_assignments")
        .select("id,driver_id,vehicle_id,start_date,end_date")
        .eq("application_id", applicationId).eq("status","approved").order("start_date");
      if (approvedAssignmentsError) return reply(503, { error: "Approved assignment details could not be checked" });
      const driverIds = Array.from(new Set((approvedAssignments || []).map((item: Record<string,any>) => item.driver_id)));
      const vehicleIds = Array.from(new Set((approvedAssignments || []).map((item: Record<string,any>) => item.vehicle_id)));
      const [{ data: driverRows }, { data: vehicleRows }] = await Promise.all([
        driverIds.length ? admin.from("fms_drivers").select("id,full_name").in("id",driverIds) : Promise.resolve({data:[]}),
        vehicleIds.length ? admin.from("fms_vehicles").select("id,brand,model,plate_number").in("id",vehicleIds) : Promise.resolve({data:[]})
      ]);
      const driverById = new Map((driverRows || []).map((item: Record<string,any>) => [item.id,item]));
      const vehicleById = new Map((vehicleRows || []).map((item: Record<string,any>) => [item.id,item]));
      const assignmentList = (approvedAssignments || []).map((item: Record<string,any>, index: number) => {
        const assignedDriver = driverById.get(item.driver_id);
        const assignedVehicle = vehicleById.get(item.vehicle_id);
        return "<li>Vehicle " + (index + 1) + ": " + esc(assignedVehicle?.brand || "") + " " + esc(assignedVehicle?.model || "") +
          " (" + esc(assignedVehicle?.plate_number || "Registration unavailable") + ") — Driver: " + esc(assignedDriver?.full_name || "Not available") +
          "; " + esc(item.start_date) + " to " + esc(item.end_date) + "</li>";
      }).join("");
      details = "<p><strong>Travel dates:</strong> " + esc(application.start_date) + " to " + esc(application.end_date) +
        "</p><p><strong>Confirmed vehicle and driver assignments:</strong></p><ul>" + assignmentList + "</ul>";
    }
    const reason = body.reason ? "<p><strong>Remarks:</strong> " + esc(body.reason) + "</p>" : "";
    const decisionLabel = isApproved ? "approved" : type === "assignment-rejected" ? "rejected" : isReturned ? "returned for correction" : "cancelled";
    let applicantEmailStatus = "skipped";
    let applicantWhatsAppStatus = "skipped";
    if (body?.notifyApplicant !== false) {
      const applicantResult = await sendEmail(application.email, subject,
        "<p>Dear " + esc(application.applicant_name) + ",</p><p>Your FMS vehicle request <strong>" + esc(application.reference) + "</strong> has been " + decisionLabel + ".</p>" + details + reason + "<p>Fleet Management System — Sarawak</p>");
      const applicantWhatsApp = application.whatsapp_opt_in && application.phone
        ? await sendWhatsApp(application.phone, application.reference, "Vehicle request " + decisionLabel, "Destination: " + application.destination)
        : { status: "not_opted_in", error: null };
      applicantEmailStatus = applicantResult.status;
      applicantWhatsAppStatus = applicantWhatsApp.status;
      await admin.from("fms_notifications").insert({
        recipient_email: application.email, subject, body: subject + " " + (body.reason || ""),
        notification_type: type, related_table: "fms_applications", related_record_id: application.id,
        email_status: applicantResult.status, email_error: applicantResult.error ? String(applicantResult.error).slice(0,1000) : null,
        sent_at: applicantResult.status === "sent" ? new Date().toISOString() : null,
        whatsapp_status: applicantWhatsApp.status,
        whatsapp_error: applicantWhatsApp.error ? String(applicantWhatsApp.error).slice(0,1000) : null,
        whatsapp_sent_at: applicantWhatsApp.status === "sent" ? new Date().toISOString() : null
      });
    }

    let driverStatus = "not_applicable";
    let driverWhatsAppStatus = "not_applicable";
    if (driver?.email && assignmentId) {
      const driverSubject = isApproved
        ? "FMS trip assignment confirmed — " + application.reference
        : type === "assignment-rejected"
          ? "FMS proposed trip not approved — " + application.reference
          : isReturned
            ? "FMS trip proposal returned for correction — " + application.reference
            : "FMS trip assignment cancelled — " + application.reference;
      const driverMessage = isApproved
        ? "Your vehicle assignment has been approved."
        : type === "assignment-rejected"
          ? "The proposed trip assignment was not approved. Please review the remarks below with your Fleet Manager."
          : isReturned
            ? "The proposed trip was returned for correction. Please review the updated plan with your Fleet Manager."
            : "The trip assignment has been cancelled. Please review the remarks below with your Fleet Manager.";
      const result = await sendEmail(driver.email, driverSubject,
        "<p>Dear " + esc(driver.full_name) + ",</p><p>" + driverMessage + "</p>" + details + reason + "<p>Reference: " + esc(application.reference) + "</p><p>Fleet Management System — Sarawak</p>");
      const driverWhatsApp = driver.whatsapp_opt_in && driver.phone
        ? await sendWhatsApp(driver.phone, application.reference, driverMessage, "Travel dates: " + application.start_date + " to " + application.end_date)
        : { status: "not_opted_in", error: null };
      driverStatus = result.status;
      driverWhatsAppStatus = driverWhatsApp.status;
      await admin.from("fms_notifications").insert({
        recipient_profile_id: driver.profile_id || null, recipient_email: driver.email, subject: driverSubject,
        body: driverMessage + " Reference: " + application.reference,
        notification_type: type === "assignment-approved" ? "driver_assignment" : type === "assignment-rejected" ? "driver_assignment_rejected" : isReturned ? "driver_assignment_returned" : "driver_assignment_cancelled",
        related_table: "fms_assignments", related_record_id: assignmentId,
        email_status: result.status, email_error: result.error ? String(result.error).slice(0,1000) : null,
        sent_at: result.status === "sent" ? new Date().toISOString() : null,
        whatsapp_status: driverWhatsApp.status,
        whatsapp_error: driverWhatsApp.error ? String(driverWhatsApp.error).slice(0,1000) : null,
        whatsapp_sent_at: driverWhatsApp.status === "sent" ? new Date().toISOString() : null
      });
    }
    return reply(200, { success: true, applicantEmailStatus, applicantWhatsAppStatus, driverEmailStatus: driverStatus, driverWhatsAppStatus });
  } catch (error) {
    console.error("send-fms-notification", error);
    return reply(500, { error: "An unexpected notification error occurred" });
  }
});