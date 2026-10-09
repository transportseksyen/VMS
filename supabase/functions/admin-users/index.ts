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
  if (!url || !serviceKey) return reply(500, { error: "Admin function is not configured" });

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Authentication required" });
  const callerClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await callerClient.auth.getUser(token);
  if (authError || !authData.user) return reply(401, { error: "Invalid session" });

  const { data: actor } = await callerClient.from("fms_profiles")
    .select("id,role,agency_id,status").eq("id", authData.user.id).maybeSingle();
  if (!actor || actor.status !== "active" || !["super_admin", "fleet_manager"].includes(actor.role)) {
    return reply(403, { error: "You do not have permission to administer staff accounts" });
  }

  try {
    const body = await request.json();
    const action = String(body?.action || "");
    if (action === "create_agency" || action === "update_agency_status") {
      if (actor.role !== "super_admin") return reply(403, { error: "Only the Super Admin can manage agencies" });
      if (action === "create_agency") {
        const name = String(body.name || "").trim();
        const code = String(body.code || "").trim().toUpperCase();
        if (name.length < 2 || name.length > 180) return reply(400, { error: "Agency name must be between 2 and 180 characters" });
        if (code && !/^[A-Z0-9_-]{2,16}$/.test(code)) return reply(400, { error: "Agency code may use 2–16 letters, numbers, hyphens or underscores" });
        const { data: agency, error: createError } = await callerClient.from("fms_agencies")
          .insert({ name, code: code || null, is_active: true }).select("id,name,code,is_active").single();
        if (createError || !agency) return reply(400, { error: createError?.message || "Could not create agency" });
        await callerClient.from("fms_audit_logs").insert({
          actor_profile_id: actor.id, agency_id: agency.id, action: "create_agency",
          entity_type: "agency", entity_id: agency.id, details: { name: agency.name, code: agency.code }
        });
        return reply(200, { success: true, agency });
      }
      const agencyId = String(body.agency_id || "");
      const isActive = Boolean(body.is_active);
      const { data: agency, error: agencyError } = await callerClient.from("fms_agencies")
        .update({ is_active: isActive }).eq("id", agencyId).select("id,name,code,is_active").maybeSingle();
      if (agencyError || !agency) return reply(400, { error: agencyError?.message || "Agency not found" });
      await callerClient.from("fms_audit_logs").insert({
        actor_profile_id: actor.id, agency_id: agency.id, action: "update_agency_status",
        entity_type: "agency", entity_id: agency.id, details: { is_active: isActive }
      });
      return reply(200, { success: true, agency });
    }

    if (action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      const fullName = String(body.full_name || "").trim();
      const role = String(body.role || "");
      const agencyId = body.agency_id ? String(body.agency_id) : null;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName) return reply(400, { error: "Name and a valid email are required" });
      if (!["super_admin", "fleet_manager", "data_entry", "driver"].includes(role)) return reply(400, { error: "Invalid role" });
      if (actor.role === "fleet_manager" && (!["data_entry","driver"].includes(role) || agencyId !== actor.agency_id)) {
        return reply(403, { error: "Fleet Managers may invite only Data Entry and Drivers for their own agency" });
      }
      if (role !== "super_admin" && !agencyId) return reply(400, { error: "Select an agency for this role" });
      if (agencyId) {
        const { data: agency } = await callerClient.from("fms_agencies").select("id").eq("id", agencyId).eq("is_active", true).maybeSingle();
        if (!agency) return reply(400, { error: "Selected agency is not active" });
      }
      const { data: inviteData, error: inviteError } = await callerClient.auth.admin.inviteUserByEmail(email, {
        data: { full_name: fullName },
        redirectTo: Deno.env.get("FMS_INVITE_REDIRECT_URL")
      });
      if (inviteError || !inviteData.user) return reply(400, { error: inviteError?.message || "Could not invite user" });
      const profileStatus = ["data_entry", "driver"].includes(role) ? "pending" : "active";
      const { error: profileError } = await callerClient.from("fms_profiles").upsert({
        id: inviteData.user.id, full_name: fullName, email, role, agency_id: agencyId, status: profileStatus
      });
      if (profileError) return reply(500, { error: "User invited but the FMS profile could not be created. Contact the administrator." });
      if (role === "driver") {
        const { error: driverError } = await callerClient.from("fms_drivers").upsert({
          profile_id: inviteData.user.id, agency_id: agencyId, full_name: fullName, email,
          account_status: "active", availability_status: "available", approval_status: "pending",
          created_by: actor.id
        }, { onConflict: "profile_id" });
        if (driverError) return reply(500, { error: "Invitation created but the driver record could not be created." });
      }
      await callerClient.from("fms_audit_logs").insert({
        actor_profile_id: actor.id, agency_id: agencyId, action: "invite_user",
        entity_type: "profile", entity_id: inviteData.user.id,
        details: { email, role, status: profileStatus }
      });
      return reply(200, { success: true, user_id: inviteData.user.id, status: profileStatus });
    }

    if (action === "approve") {
      const targetId = String(body.user_id || "");
      const { data: target } = await callerClient.from("fms_profiles")
        .select("id,role,agency_id,status").eq("id", targetId).maybeSingle();
      if (!target) return reply(404, { error: "User not found" });
      if (actor.role === "fleet_manager" &&
          (target.agency_id !== actor.agency_id || !["data_entry","driver"].includes(target.role))) {
        return reply(403, { error: "Fleet Managers may approve only Data Entry or Driver accounts in their own agency" });
      }
      if (actor.role !== "super_admin" && actor.role !== "fleet_manager") {
        return reply(403, { error: "Not authorized" });
      }
      if (target.status !== "pending") return reply(400, { error: "Only pending accounts can be approved" });
      const { error: profileUpdateError } = await callerClient.from("fms_profiles")
        .update({ status: "active", updated_at: new Date().toISOString() }).eq("id", targetId);
      if (profileUpdateError) return reply(400, { error: profileUpdateError.message });
      if (target.role === "driver") {
        const { error: driverUpdateError } = await callerClient.from("fms_drivers")
          .update({ approval_status: "approved", approved_by: actor.id, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("profile_id", targetId).eq("agency_id", target.agency_id);
        if (driverUpdateError) return reply(400, { error: "Account approved but driver registry could not be approved." });
      }
      await callerClient.from("fms_audit_logs").insert({
        actor_profile_id: actor.id, agency_id: target.agency_id, action: "approve_user",
        entity_type: "profile", entity_id: targetId, details: { role: target.role }
      });
      return reply(200, { success: true });
    }

    if (action === "change_role_agency") {
      if (actor.role !== "super_admin") return reply(403, { error: "Only a Super Admin can change a user's role or agency" });
      const targetId = String(body.user_id || "");
      const newRole = String(body.role || "");
      const newAgencyId = body.agency_id ? String(body.agency_id) : null;
      if (!targetId || !["super_admin","fleet_manager","data_entry","driver"].includes(newRole)) {
        return reply(400, { error: "A valid user and role are required" });
      }
      if (targetId === actor.id) return reply(400, { error: "You cannot change your own role or agency" });
      if (newRole === "super_admin" && newAgencyId) return reply(400, { error: "Super Admin accounts must not be assigned to a single agency" });
      if (newRole !== "super_admin" && !newAgencyId) return reply(400, { error: "Select an active agency for this role" });
      const { data: target, error: targetError } = await callerClient.from("fms_profiles")
        .select("id,full_name,email,role,agency_id,status").eq("id", targetId).maybeSingle();
      if (targetError || !target) return reply(404, { error: "User not found" });
      if (target.role === "super_admin" && target.status === "active" && newRole !== "super_admin") {
        const { count, error: countError } = await callerClient.from("fms_profiles")
          .select("id", { count: "exact", head: true }).eq("role","super_admin").eq("status","active");
        if (countError) return reply(503, { error: "Could not verify the remaining Super Admin accounts" });
        if ((count || 0) <= 1) return reply(400, { error: "The last active Super Admin cannot be demoted" });
      }
      if (newAgencyId) {
        const { data: agency } = await callerClient.from("fms_agencies")
          .select("id").eq("id",newAgencyId).eq("is_active",true).maybeSingle();
        if (!agency) return reply(400, { error: "Selected agency is not active" });
      }
      const now = new Date().toISOString();
      const { error: profileError } = await callerClient.from("fms_profiles")
        .update({ role:newRole, agency_id:newAgencyId, updated_at:now }).eq("id",targetId);
      if (profileError) return reply(400, { error: profileError.message });

      if (newRole === "driver") {
        const { error: driverError } = await callerClient.from("fms_drivers").upsert({
          profile_id: targetId, agency_id: newAgencyId, full_name: target.full_name, email: target.email,
          account_status: "active", availability_status: "available", approval_status: "pending",
          approved_by: null, approved_at: null, created_by: actor.id, updated_at: now
        }, { onConflict: "profile_id" });
        if (driverError) {
          await callerClient.from("fms_profiles").update({ role:target.role, agency_id:target.agency_id, updated_at:new Date().toISOString() }).eq("id",targetId);
          return reply(500, { error: "Role update rolled back because the driver registry could not be synchronized" });
        }
      } else if (target.role === "driver") {
        const { error: driverError } = await callerClient.from("fms_drivers")
          .update({ account_status:"inactive", updated_at:now }).eq("profile_id",targetId);
        if (driverError) {
          await callerClient.from("fms_profiles").update({ role:target.role, agency_id:target.agency_id, updated_at:new Date().toISOString() }).eq("id",targetId);
          return reply(500, { error: "Role update rolled back because the driver registry could not be synchronized" });
        }
      }
      await callerClient.from("fms_audit_logs").insert({
        actor_profile_id:actor.id, agency_id:newAgencyId || target.agency_id,
        action:"change_role_agency", entity_type:"profile", entity_id:targetId,
        details:{previous_role:target.role,previous_agency_id:target.agency_id,new_role:newRole,new_agency_id:newAgencyId}
      });
      return reply(200, { success:true });
    }

    if (action === "suspend" || action === "activate") {
      const targetId = String(body.user_id || "");
      const { data: target } = await callerClient.from("fms_profiles")
        .select("id,role,agency_id,status").eq("id", targetId).maybeSingle();
      if (!target) return reply(404, { error: "User not found" });
      if (targetId === actor.id) return reply(400, { error: "You cannot suspend or reactivate your own account" });
      if (actor.role === "fleet_manager" && (target.agency_id !== actor.agency_id || !["data_entry","driver"].includes(target.role))) {
        return reply(403, { error: "Fleet Managers may change only Data Entry or Driver accounts in their agency" });
      }
      if (target.role === "super_admin" && actor.role !== "super_admin") return reply(403, { error: "Only a Super Admin can change a Super Admin account" });
      if (action === "suspend" && target.status !== "active") return reply(400, { error: "Only an active account can be suspended" });
      if (action === "activate" && target.status !== "suspended") return reply(400, { error: "Only a suspended account can be reactivated. Pending accounts must be approved first." });
      if (action === "suspend" && target.role === "super_admin" && target.status === "active") {
        const { count, error: countError } = await callerClient.from("fms_profiles")
          .select("id", { count:"exact", head:true }).eq("role","super_admin").eq("status","active");
        if (countError) return reply(503, { error:"Could not verify remaining Super Admin accounts" });
        if ((count || 0) <= 1) return reply(400, { error:"The last active Super Admin cannot be suspended" });
      }
      const status = action === "suspend" ? "suspended" : "active";
      const { error: updateError } = await callerClient.from("fms_profiles")
        .update({ status, updated_at: new Date().toISOString() }).eq("id", targetId);
      if (updateError) return reply(400, { error: updateError.message });
      const { error: authUpdateError } = action === "suspend"
        ? await callerClient.auth.admin.updateUserById(targetId, { ban_duration:"876000h" })
        : await callerClient.auth.admin.updateUserById(targetId, { ban_duration:"none" });
      if (authUpdateError) {
        await callerClient.from("fms_profiles").update({ status:target.status, updated_at:new Date().toISOString() }).eq("id",targetId);
        return reply(500, { error:"Account status could not be synchronized with authentication. The profile update was rolled back." });
      }
      await callerClient.from("fms_audit_logs").insert({
        actor_profile_id:actor.id, agency_id:target.agency_id,
        action:action + "_user", entity_type:"profile", entity_id:targetId
      });
      return reply(200, { success:true });
    }
    return reply(400, { error: "Unsupported action" });
  } catch (error) {
    console.error("admin-users", error);
    return reply(500, { error: "An unexpected server error occurred" });
  }
});