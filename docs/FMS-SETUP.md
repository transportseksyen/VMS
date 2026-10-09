# FMS Web Application — Setup & Deployment

Repository: https://github.com/transportseksyen/VMS  
Web source: `web/`  
Database migration: `supabase/migrations/202610090001_fms_core.sql`  
Supabase Edge Functions: `supabase/functions/`

## Current architecture

- React + TypeScript + Vite responsive web app.
- Supabase Auth for staff sign-in.
- PostgreSQL tables prefixed with `fms_` so the earlier VMS schema is not overwritten.
- Row-level security (RLS) and server-side approval RPCs.
- Private Supabase Storage bucket `fms-documents`.
- Edge Functions for public applications, staff administration, initial Super Admin setup and email notifications.
- The public Applicant form needs no staff account; staff pages require Supabase authentication and an active FMS profile.

## Supabase project

The FMS Supabase project is named `FMS` and has project ref `onxxgdbnonctwiykwdxo`.

Web environment variables (set in Vercel Project Settings → Environment Variables):

```env
VITE_SUPABASE_URL=https://onxxgdbnonctwiykwdxo.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_WITH_CURRENT_PROJECT_KEY
```

Use the enabled publishable key shown in Supabase → Project Settings → API Keys. The publishable key is designed to be present in client code; the service-role key is not.

## Edge Function secrets

Configure these under Supabase → Edge Functions → Secrets, or using the Supabase CLI:

- `FMS_BOOTSTRAP_ADMIN_EMAIL`: exact email address allowed to create the first Super Admin. Set this only for initial bootstrap.
- `RESEND_API_KEY`: Resend transactional email API key.
- `FMS_EMAIL_FROM`: verified sender, for example `FMS <notifications@your-verified-domain.example>`.
- `FMS_INVITE_REDIRECT_URL`: optional application URL used for staff invitation links after a public deployment is available.

Supabase's built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are read only inside Edge Functions. Never create `VITE_SUPABASE_SERVICE_ROLE_KEY` or expose a service-role key in frontend code.

The functions deployed to the current Supabase project are:
- `submit-application` — public application intake and private PDF upload.
- `admin-users` — agency and staff administration.
- `send-fms-notification` — approval and assignment email notifications.
- `bootstrap-admin` — allowlisted first administrator creation.

Email actions report `not_configured` if the Resend secrets are not set. Staff invitations also depend on the Supabase Auth email configuration.

## First-time administrator bootstrap

1. In Supabase Dashboard → Authentication → Users, create the designated administrator account using the same email that will be set as `FMS_BOOTSTRAP_ADMIN_EMAIL`.
2. Set `FMS_BOOTSTRAP_ADMIN_EMAIL` under Edge Function Secrets.
3. Open the FMS web app and sign in with that account.
4. On the “Account awaiting authorization” screen, select **Set up first Super Admin**.
5. After success, remove `FMS_BOOTSTRAP_ADMIN_EMAIL` from Edge Function Secrets. The function also refuses to run once any FMS Super Admin profile exists.
6. Open **Agencies** and add the agency records needed by the public request form.
7. Open **User Management** and invite Fleet Managers. Fleet Managers can then invite Data Entry and Drivers for their own agency.

Do not create a second Super Admin using the bootstrap method. Other administrators should be invited through the protected User Management workflow.

## Local web development

From the repository root:

```bash
cd web
cp .env.example .env.local
# Edit .env.local with the values above
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run preview
```

GitHub Actions workflow: `.github/workflows/fms-web-check.yml`. It installs dependencies and runs the TypeScript/Vite production build on changes to the web app or Supabase files.

## Live web deployment

The FMS web app is deployed through GitHub Pages at:

**https://transportseksyen.github.io/VMS/**

The GitHub Actions deployment reported success on October 9, 2026. The build is also synchronized to the repository root as a fallback for branch-based GitHub Pages configuration. Future changes under `web/` automatically rebuild and publish the web app.

A Vercel project named `fms-sarawak` was also created, but Vercel integration could not be completed because its API rejected operations with a scope authorization error for `fms-e513`. GitHub Pages is the current deployment path.

To finish deployment:
1. Connect the GitHub account to Vercel using the required GitHub Login Connection and ensure the Vercel account has access to the project's team/scope.
2. Open the `fms-sarawak` project in Vercel.
3. Set Root Directory to `web`, Framework Preset to Vite, Build Command to `npm run build`, and Output Directory to `dist`.
4. Confirm `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are configured for Production and Preview.
5. Deploy the `main` branch and verify the generated URL in a private/incognito browser.

If a custom domain is needed later, connect it through the GitHub Pages or Vercel project settings and verify it before changing the mobile wrappers.

## Security and production checklist

- Replace the “SC” logo placeholder with an authentic, approved Sarawak State Crest asset. No crest image was supplied to this repository.
- Set Resend secrets and verify the sender domain before relying on email notifications.
- Configure staff invitation email delivery and the final redirect URL.
- Configure CAPTCHA/anti-bot protection or edge/WAF rate limiting for the public application function before opening it widely.
- Test RLS with accounts for every role and at least two different agencies.
- Verify that Applicants, Drivers, Data Entry and Fleet Managers cannot read documents outside their authorized access.
- Confirm no double-booking when two users attempt overlapping assignments.
- Use test records first; do not upload real government passenger lists or official documents until your agency's ICT/security approval is complete.
- Review retention, backup, disaster recovery and audit-log requirements with the agency administrator.

## Current functional scope and known gaps

The web app has working database-backed login, public vehicle request submission with start/end dates and one combined PDF, agency administration, staff invitations/approval, vehicle and driver registry submissions/approval, proposed assignment submission and approval/rejection RPCs, a basic assignment calendar, fuel transaction/receipt submission and review, maintenance record/document upload, short-lived signed document URLs and live record-count reports.

The following still require further implementation/testing before the platform can be called fully production-ready:
- Public application status lookup by reference and verification code.
- Multi-vehicle assignments when an application requests more than one vehicle.
- Full CRUD/edit/delete flows with approval history for every registry type.
- Complete exports to PDF/Excel and richer monthly/yearly reporting.
- SMS/WhatsApp notifications (email is the current notification channel).
- End-to-end testing of assignment changes/cancellations and email delivery.
- Final official crest asset and agency-approved privacy text.
- Production deployment URL and real-device validation.
- The current native iOS wrapper still points at the old OnHercules prototype URL; update it to the verified FMS production URL after deployment, then rebuild and test on real devices.
- A signed iOS application and a final Android package are separate mobile deliverables; they must be built and tested before claiming app-store/phone distribution readiness.
- The existing mobile wrappers are not yet verified to use the new React/Supabase FMS web app.
