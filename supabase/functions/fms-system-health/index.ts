import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};
function reply(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", {headers:corsHeaders});
  if (request.method !== "GET" && request.method !== "POST") return reply(405,{error:"Method not allowed"});
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(500,{error:"Health check service is not configured"});
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return reply(401,{error:"Authentication required"});
  const admin = createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const token = authorization.slice("Bearer ".length);
  const {data:authData,error:authError} = await admin.auth.getUser(token);
  if (authError || !authData.user) return reply(401,{error:"Authentication required"});
  const {data:profile,error:profileError} = await admin.from("fms_profiles")
    .select("id,role,status").eq("id",authData.user.id).maybeSingle();
  if (profileError || !profile || profile.role !== "super_admin" || profile.status !== "active") {
    return reply(403,{error:"Only an active Super Admin may view system status"});
  }

  const {count:agencyCount,error:agencyError} = await admin.from("fms_agencies")
    .select("id",{count:"exact",head:true});
  const {data:bucket,error:bucketError} = await admin.storage.listBuckets();
  const requiredEmail = ["RESEND_API_KEY","FMS_EMAIL_FROM"];
  const requiredWhatsApp = ["WHATSAPP_ACCESS_TOKEN","WHATSAPP_PHONE_NUMBER_ID","WHATSAPP_GRAPH_API_VERSION","WHATSAPP_TEMPLATE_NAME","WHATSAPP_TEMPLATE_LANGUAGE"];
  const emailMissing = requiredEmail.filter(name => !Deno.env.get(name));
  const whatsappMissing = requiredWhatsApp.filter(name => !Deno.env.get(name));
  const emailReady = emailMissing.length === 0;
  const whatsappReady = whatsappMissing.length === 0;
  return reply(200,{
    success:true,
    checked_at:new Date().toISOString(),
    database:{connected:!agencyError,agency_count:agencyCount || 0},
    storage:{private_bucket_ready:!bucketError && (bucket || []).some((item:any)=>item.name === "fms-documents")},
    integrations:{
      email:{ready:emailReady,missing:emailMissing},
      whatsapp:{ready:whatsappReady,missing:whatsappMissing,template_approval_is_manual:true}
    },
    branding:{official_crest_configured:false,reason:"Awaiting the approved official Sarawak State Crest asset."},
    security:{leaked_password_protection:"manual_dashboard_check",reason:"Supabase Auth leaked-password protection is currently reported disabled by the security advisor."}
  });
});
