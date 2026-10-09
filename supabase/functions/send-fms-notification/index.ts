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
    const { data: actor } = await admin.from("profiles").select("id,role,agency_id,status").eq("id", authData.user.id).maybeSingle();
    if (!actor || actor.status !== "active" || !["fleet_manager","super_admin"].includes(actor.role)) return reply(403, { error: "Only authorized Fleet Managers can send decision notifications" });
    if (!["assignment-approved","assignment-rejected","assignment-cancelled"].includes(type)) return reply(400, { error: "Unsupported notification type" });

    const { data: application } = await admin.from("applications").select("*").eq("id", applicationId).maybeSingle();
    if (!application) return reply(404, { error: "Application not found" });
    if (actor.role !== "super_admin" && actor.agency_id !== application.agency_id) return reply(403, { error: "Agency access denied" });

    let driver: Record<string, any> | null = null;
    let vehicle: Record<string, any> | null = null;
    if (assignmentId) {
      const { data: assignment } = await admin.from("assignments").select("id,application_id,driver_id,vehicle_id,status,start_date,end_date").eq("id", assignmentId).eq("application_id", applicationId).maybeSingle();
      if (assignment) {
        const [driverResult, vehicleResult] = await Promise.all([
          admin.from("drivers").select("full_name,email,phone").eq("id", assignment.driver_id).maybeSingle(),
          admin.from("vehicles").select("brand,model,plate_number").eq("id", assignment.vehicle_id).maybeSingle()
        ]);
        driver = driverResult.data;
        vehicle = vehicleResult.data;
      }
    }

    const isApproved = type === "assignment-approved";
    const subject = isApproved ? "FMS vehicle request approved — " + application.reference
      : type === "assignment-rejected" ? "FMS vehicle request decision — " + application.reference
      : "FMS assignment cancelled — " + application.reference;
    const details = isApproved && vehicle && driver
      ? "<p><strong>Driver:</strong> " + esc(driver.full_name) + "<br><strong>Vehicle:</strong> " + esc(vehicle.brand) + " " + esc(vehicle.model) + " (" + esc(vehicle.plate_number) + ")<br><strong>Travel dates:</strong> " + esc(application.start_date) + " to " + esc(application.end_date) + "</p>"
      : "";
    const reason = body.reason ? "<p><strong>Remarks:</strong> " + esc(body.reason) + "</p>" : "";
    const applicantResult = await sendEmail(application.email, subject,
      "<p>Dear " + esc(application.applicant_name) + ",</p><p>Your FMS vehicle request <strong>" + esc(application.reference) + "</strong> has been " + (isApproved ? "approved" : type === "assignment-rejected" ? "rejected" : "cancelled") + ".</p>" + details + reason + "<p>Fleet Management System — Sarawak</p>");
    await admin.from("notifications").insert({
      recipient_email: application.email, subject, body: subject + " " + (body.reason || ""),
      notification_type: type, related_table: "applications", related_record_id: application.id,
      email_status: applicantResult.status, email_error: applicantResult.error ? String(applicantResult.error).slice(0,1000) : null,
      sent_at: applicantResult.status === "sent" ? new Date().toISOString() : null
    });

    let driverStatus = "not_applicable";
    if (isApproved && driver?.email) {
      const result = await sendEmail(driver.email, "FMS trip assignment — " + application.reference,
        "<p>Dear " + esc(driver.full_name) + ",</p><p>You have a confirmed vehicle assignment.</p>" + details + "<p>Reference: " + esc(application.reference) + "</p><p>Fleet Management System — Sarawak</p>");
      driverStatus = result.status;
      await admin.from("notifications").insert({
        recipient_email: driver.email, subject: "FMS trip assignment — " + application.reference,
        body: "Confirmed assignment for " + application.reference,
        notification_type: "driver_assignment", related_table: "assignments", related_record_id: assignmentId || null,
        email_status: result.status, email_error: result.error ? String(result.error).slice(0,1000) : null,
        sent_at: result.status === "sent" ? new Date().toISOString() : null
      });
    }
    return reply(200, { success: true, applicantEmailStatus: applicantResult.status, driverEmailStatus: driverStatus });
  } catch (error) {
    console.error("send-fms-notification", error);
    return reply(500, { error: "An unexpected notification error occurred" });
  }
});