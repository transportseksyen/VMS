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
  if (!/^v\\d+\\.\\d+$/.test(graphVersion)) {
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
  let digits = trimmed.replace(/\\D/g, "");
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
    const { data: actor } = await admin.from("fms_profiles").select("id,role,agency_id,status").eq("id", authData.user.id).maybeSingle();
    if (!actor || actor.status !== "active") return reply(403, { error: "An active FMS account is required" });
    const isSubmissionNotice = type === "assignment-submitted";
    if (isSubmissionNotice) {
      if (!["data_entry","fleet_manager","super_admin"].includes(actor.role)) return reply(403, { error: "Only authorized fleet staff may submit assignments for review" });
    } else if (!["fleet_manager","super_admin"].includes(actor.role)) {
      return reply(403, { error: "Only authorized Fleet Managers can send decision notifications" });
    }
    const fuelDecision = type === "fuel-approved" || type === "fuel-returned";
    if (!["assignment-approved","assignment-rejected","assignment-returned","assignment-cancelled","assignment-submitted","fuel-approved","fuel-returned"].includes(type)) return reply(400, { error: "Unsupported notification type" });

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
      if (assignment) {
        const [driverResult, vehicleResult] = await Promise.all([
          admin.from("fms_drivers").select("full_name,email,phone,whatsapp_opt_in").eq("id", assignment.driver_id).maybeSingle(),
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
    const details = vehicle && driver
      ? "<p><strong>Driver:</strong> " + esc(driver.full_name) + "<br><strong>Vehicle:</strong> " + esc(vehicle.brand) + " " + esc(vehicle.model) + " (" + esc(vehicle.plate_number) + ")<br><strong>Travel dates:</strong> " + esc(application.start_date) + " to " + esc(application.end_date) + "</p>"
      : "";
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
        recipient_email: driver.email, subject: driverSubject,
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