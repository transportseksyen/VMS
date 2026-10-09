import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function reply(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(500, { error: "Status service is not configured" });

  try {
    const forwarded = request.headers.get("cf-connecting-ip")
      || request.headers.get("x-real-ip")
      || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
      || "unknown";
    const ipHash = await sha256("application-status:" + forwarded);
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { count, error: rateError } = await admin.from("fms_public_submission_rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash).gte("created_at", since);
    if (rateError) return reply(503, { error: "Status checking is temporarily unavailable" });
    if ((count || 0) >= 8) return reply(429, { error: "Too many status checks. Please try again later." });
    const { error: rateInsertError } = await admin.from("fms_public_submission_rate_limits").insert({ ip_hash: ipHash });
    if (rateInsertError) return reply(503, { error: "Status checking is temporarily unavailable" });

    const body = await request.json();
    const reference = String(body?.reference || "").trim().toUpperCase();
    const email = String(body?.email || "").trim().toLowerCase();
    if (!/^FMS-[A-Z0-9]{8}$/.test(reference) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply(400, { error: "Enter a valid application reference and email address." });
    }

    const { data, error } = await admin.from("fms_applications")
      .select("reference,status,destination,start_date,end_date,vehicles_requested,decision_reason,submitted_at,decided_at")
      .eq("reference", reference)
      .ilike("email", email)
      .maybeSingle();
    if (error) return reply(503, { error: "Status checking is temporarily unavailable" });
    if (!data) return reply(404, { error: "We could not find a matching application. Check the reference and applicant email." });

    return reply(200, {
      success: true,
      application: {
        reference: data.reference,
        status: data.status,
        destination: data.destination,
        start_date: data.start_date,
        end_date: data.end_date,
        vehicles_requested: data.vehicles_requested,
        decision_reason: data.decision_reason,
        submitted_at: data.submitted_at,
        decided_at: data.decided_at
      }
    });
  } catch (error) {
    console.error("application-status", error);
    return reply(400, { error: "The status request could not be processed." });
  }
});
