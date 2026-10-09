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

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const allowedEmail = (Deno.env.get("FMS_BOOTSTRAP_ADMIN_EMAIL") || "").trim().toLowerCase();
  if (!url || !serviceKey || !allowedEmail) {
    return reply(503, { error: "First-admin setup is disabled. Configure FMS_BOOTSTRAP_ADMIN_EMAIL securely in Supabase Function Secrets." });
  }

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Sign in with the designated administrator account first." });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user?.email) return reply(401, { error: "Invalid authenticated user." });
  if (authData.user.email.trim().toLowerCase() !== allowedEmail) {
    return reply(403, { error: "This email is not authorized to bootstrap the first Super Admin." });
  }

  const { count, error: countError } = await admin.from("fms_profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "super_admin");
  if (countError) return reply(503, { error: "Could not verify whether FMS has already been initialized." });
  if ((count || 0) > 0) return reply(409, { error: "A Super Admin already exists. Bootstrap is closed." });

  const user = authData.user;
  const fullName = String(user.user_metadata?.full_name || user.user_metadata?.name || user.email.split("@")[0]).slice(0, 180);
  const { error: profileError } = await admin.from("fms_profiles").insert({
    id: user.id, full_name: fullName, email: user.email, role: "super_admin",
    agency_id: null, status: "active"
  });
  if (profileError) return reply(500, { error: "Could not create the initial administrator profile." });

  await admin.from("fms_audit_logs").insert({
    actor_profile_id: user.id, agency_id: null, action: "bootstrap_first_super_admin",
    entity_type: "profile", entity_id: user.id, details: { email: user.email }
  });

  return reply(200, { success: true, message: "Initial Super Admin created. Remove FMS_BOOTSTRAP_ADMIN_EMAIL from Function Secrets to disable bootstrap." });
});