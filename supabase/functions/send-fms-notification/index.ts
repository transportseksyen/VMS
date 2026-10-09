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
    const { data: actor } = await admin.from("fms_profiles").select("id,role,agency_id,status").eq("id", authData.user.id).maybeSingle();
    if (!actor || actor.status !== "active" || !["fleet_manager","super_admin"].includes(actor.role)) return reply(403, { error: "Only authorized Fleet Managers can send decision notifications" });
    if (!["assignment-approved","assignment-rejected","assignment-cancelled"].includes(type)) return reply(400, { error: "Unsupported notification type" });

    const { data: application } = await admin.from("fms_applications").select("*").eq("id", applicationId).maybeSingle();
    if (!application) return reply(404, { error: "Application not found" });
    if (actor.role !== "super_admin" && actor.agency_id !== application.agency_id) return reply(403, { error: "Agency access denied" });

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
    const subject = isApproved ? "FMS vehicle request approved — " + application.reference
      : type === "assignment-rejected" ? "FMS vehicle request decision — " + application.reference
      : "FMS assignment cancelled — " + application.reference;
    const details = vehicle && driver
      ? "<p><strong>Driver:</strong> " + esc(driver.full_name) + "<br><strong>Vehicle:</strong> " + esc(vehicle.brand) + " " + esc(vehicle.model) + " (" + esc(vehicle.plate_number) + ")<br><strong>Travel dates:</strong> " + esc(application.start_date) + " to " + esc(application.end_date) + "</p>"
      : "";
    const reason = body.reason ? "<p><strong>Remarks:</strong> " + esc(body.reason) + "</p>" : "";
    const decisionLabel = isApproved ? "approved" : type === "assignment-rejected" ? "rejected" : "cancelled";
    const applicantResult = await sendEmail(application.email, subject,
      "<p>Dear " + esc(application.applicant_name) + ",</p><p>Your FMS vehicle request <strong>" + esc(application.reference) + "</strong> has been " + decisionLabel + ".</p>" + details + reason + "<p>Fleet Management System — Sarawak</p>");
    const applicantWhatsApp = application.whatsapp_opt_in && application.phone
      ? await sendWhatsApp(application.phone, application.reference, "Vehicle request " + decisionLabel, "Destination: " + application.destination)
      : { status: "not_opted_in", error: null };
    await admin.from("fms_notifications").insert({
      recipient_email: application.email, subject, body: subject + " " + (body.reason || ""),
      notification_type: type, related_table: "fms_applications", related_record_id: application.id,
      email_status: applicantResult.status, email_error: applicantResult.error ? String(applicantResult.error).slice(0,1000) : null,
      sent_at: applicantResult.status === "sent" ? new Date().toISOString() : null,
      whatsapp_status: applicantWhatsApp.status,
      whatsapp_error: applicantWhatsApp.error ? String(applicantWhatsApp.error).slice(0,1000) : null,
      whatsapp_sent_at: applicantWhatsApp.status === "sent" ? new Date().toISOString() : null
    });

    let driverStatus = "not_applicable";
    let driverWhatsAppStatus = "not_applicable";
    if (driver?.email && assignmentId) {
      const driverSubject = isApproved
        ? "FMS trip assignment confirmed — " + application.reference
        : type === "assignment-rejected"
          ? "FMS proposed trip not approved — " + application.reference
          : "FMS trip assignment cancelled — " + application.reference;
      const driverMessage = isApproved
        ? "Your vehicle assignment has been approved."
        : type === "assignment-rejected"
          ? "The proposed trip assignment was not approved. Please review the remarks below with your Fleet Manager."
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
        notification_type: type === "assignment-approved" ? "driver_assignment" : type === "assignment-rejected" ? "driver_assignment_rejected" : "driver_assignment_cancelled",
        related_table: "fms_assignments", related_record_id: assignmentId,
        email_status: result.status, email_error: result.error ? String(result.error).slice(0,1000) : null,
        sent_at: result.status === "sent" ? new Date().toISOString() : null,
        whatsapp_status: driverWhatsApp.status,
        whatsapp_error: driverWhatsApp.error ? String(driverWhatsApp.error).slice(0,1000) : null,
        whatsapp_sent_at: driverWhatsApp.status === "sent" ? new Date().toISOString() : null
      });
    }
    return reply(200, { success: true, applicantEmailStatus: applicantResult.status, applicantWhatsAppStatus: applicantWhatsApp.status, driverEmailStatus: driverStatus, driverWhatsAppStatus });
  } catch (error) {
    console.error("send-fms-notification", error);
    return reply(500, { error: "An unexpected notification error occurred" });
  }
});