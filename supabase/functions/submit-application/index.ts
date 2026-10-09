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
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
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
  if (!url || !serviceKey) return reply(500, { error: "Server-side database configuration is missing" });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const forwarded = request.headers.get("cf-connecting-ip")
      || request.headers.get("x-real-ip")
      || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
      || "unknown";
    const ipHash = await sha256(forwarded);
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { count, error: rateError } = await admin.from("fms_public_submission_rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash).gte("created_at", since);
    if (rateError) return reply(503, { error: "Submission validation is temporarily unavailable" });
    if ((count || 0) >= 5) return reply(429, { error: "Too many submissions. Please try again later." });
    const { error: rateInsertError } = await admin.from("fms_public_submission_rate_limits").insert({ ip_hash: ipHash });
    if (rateInsertError) return reply(503, { error: "Submission validation is temporarily unavailable" });

    const body = await request.json();
    const a = body?.application;
    const base64 = String(body?.fileBase64 || "");
    const fileName = String(body?.fileName || "");
    if (!a || typeof a !== "object") return reply(400, { error: "Application data is required" });

    const name = String(a.applicant_name || "").trim();
    const applicantAgency = String(a.applicant_agency_name || "").trim();
    const email = String(a.email || "").trim();
    const phone = String(a.phone || "").trim();
    const destination = String(a.destination || "").trim();
    const purpose = String(a.purpose || "").trim();
    const agencyId = String(a.agency_id || "");
    const passengers = Number(a.passenger_count);
    const cars = Number(a.vehicles_requested);
    const startDate = a.start_date;
    const endDate = a.end_date;

    if (!name || !applicantAgency || !email || !phone || !destination || !purpose || !agencyId) {
      return reply(400, { error: "Please complete all required fields" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Invalid email address" });
    if (!Number.isInteger(passengers) || passengers < 1 || passengers > 500 ||
        !Number.isInteger(cars) || cars < 1 || cars > 50) return reply(400, { error: "Passenger or vehicle count is invalid" });
    if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) return reply(400, { error: "Travel dates are invalid" });
    if (base64.length < 8 || base64.length > 7_100_000) return reply(400, { error: "PDF is missing or larger than 5 MB" });
    if (fileName && !fileName.toLowerCase().endsWith(".pdf")) return reply(400, { error: "Upload one combined PDF only" });

    const { data: agency, error: agencyError } = await admin.from("fms_agencies")
      .select("id,name,is_active").eq("id", agencyId).eq("is_active", true).maybeSingle();
    if (agencyError || !agency) return reply(400, { error: "Please select an active fleet agency" });

    let bytes: Uint8Array;
    try {
      const binary = atob(base64);
      bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    } catch {
      return reply(400, { error: "PDF data could not be decoded" });
    }
    if (bytes.length < 5 || bytes.length > 5 * 1024 * 1024) return reply(400, { error: "PDF must be 5 MB or smaller" });
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return reply(400, { error: "Uploaded file is not a valid PDF" });

    const applicationId = crypto.randomUUID();
    const filePath = "incoming/" + applicationId + ".pdf";
    const { error: uploadError } = await admin.storage.from("fms-documents").upload(filePath, new Blob([bytes], { type: "application/pdf" }), {
      contentType: "application/pdf", upsert: false
    });
    if (uploadError) return reply(500, { error: "Could not securely store the PDF" });

    const { data: saved, error: insertError } = await admin.from("fms_applications").insert({
      id: applicationId,
      agency_id: agencyId,
      applicant_name: name,
      applicant_agency_name: applicantAgency,
      purpose,
      email, phone,
      passenger_count: passengers,
      vehicles_requested: cars,
      passenger_names: String(a.passenger_names || "").trim(),
      destination,
      purpose,
      whatsapp_opt_in: Boolean(a.whatsapp_opt_in),
      hotel_provided: Boolean(a.hotel_provided),
      start_date: startDate,
      end_date: endDate,
      document_path: filePath,
      status: "pending_assignment"
    }).select("id,reference").single();

    if (insertError || !saved) {
      await admin.storage.from("fms-documents").remove([filePath]);
      return reply(500, { error: "Application could not be saved" });
    }

    const reference = saved.reference as string;
    const emailResult = await sendEmail(
      email,
      "FMS vehicle request received — " + reference,
      "<p>Dear " + escapeHtml(name) + ",</p><p>Your vehicle request has been received by FMS.</p><p><strong>Reference:</strong> " + escapeHtml(reference) + "<br><strong>Fleet agency:</strong> " + escapeHtml(agency.name) + "<br><strong>Destination:</strong> " + escapeHtml(destination) + "<br><strong>Vehicle dates:</strong> " + startDate + " to " + endDate + "</p><p>Current status: Pending Assignment.</p><p>Fleet Management System — Sarawak</p>"
    );
    await admin.from("fms_notifications").insert({
      recipient_email: email,
      subject: "FMS vehicle request received — " + reference,
      body: "Application acknowledgement. Reference: " + reference,
      notification_type: "application_submitted",
      related_table: "fms_applications",
      related_record_id: applicationId,
      email_status: emailResult.status,
      email_error: emailResult.error ? String(emailResult.error).slice(0, 1000) : null,
      sent_at: emailResult.status === "sent" ? new Date().toISOString() : null
    });

    // Notify active Fleet Managers in the selected agency and all active Super Admins.
    const { data: staffRows } = await admin.from("fms_profiles")
      .select("id,full_name,email,role,agency_id")
      .eq("status", "active")
      .in("role", ["fleet_manager", "super_admin"]);
    const recipients = (staffRows || []).filter((staff: Record<string, any>) =>
      staff.role === "super_admin" || staff.agency_id === agencyId
    );
    const staffSubject = "New FMS vehicle request awaiting assignment — " + reference;
    const managerDeliveryResults = await Promise.all(recipients.map(async (staff: Record<string, any>) => {
      const result = await sendEmail(
        String(staff.email || ""),
        staffSubject,
        "<p>Dear " + escapeHtml(String(staff.full_name || "Fleet Manager")) + ",</p>" +
        "<p>A new vehicle request requires review and vehicle/driver assignment.</p>" +
        "<p><strong>Reference:</strong> " + escapeHtml(reference) +
        "<br><strong>Applicant:</strong> " + escapeHtml(name) +
        "<br><strong>Organization:</strong> " + escapeHtml(applicantAgency) +
        "<br><strong>Destination:</strong> " + escapeHtml(destination) +
        "<br><strong>Passengers:</strong> " + passengers +
        "<br><strong>Vehicles requested:</strong> " + cars +
        "<br><strong>Travel dates:</strong> " + startDate + " to " + endDate + "</p>" +
        "<p>Sign in to FMS to review the submitted application.</p><p>Fleet Management System — Sarawak</p>"
      );
      await admin.from("fms_notifications").insert({
        recipient_profile_id: staff.id,
        recipient_email: staff.email,
        subject: staffSubject,
        body: "New application " + reference + " awaits assignment. Destination: " + destination,
        notification_type: "application_submitted_internal",
        related_table: "fms_applications",
        related_record_id: applicationId,
        email_status: result.status,
        email_error: result.error ? String(result.error).slice(0, 1000) : null,
        sent_at: result.status === "sent" ? new Date().toISOString() : null
      });
      return result.status;
    }));

    return reply(200, {
      success: true,
      id: applicationId,
      reference,
      emailStatus: emailResult.status,
      internalNotificationCount: managerDeliveryResults.length,
      internalEmailStatuses: managerDeliveryResults
    });
  } catch (error) {
    console.error("submit-application", error);
    return reply(500, { error: "An unexpected server error occurred" });
  }
});

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}