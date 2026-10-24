# MiniChat ❤️

Private chat UI built with Vite, Supabase Auth/Database/Storage/Realtime, and a PWA app shell.

## Current architecture

- `index.html`: semantic app shell.
- `src/main.js`: application event flows and chat UI.
- `src/style.css`: app styling.
- `src/supabase.js`: Supabase browser client.
- `src/utils/format.js`: safe message formatting helpers.
- `public/`: PWA manifest, service worker, and app icon.
- `supabase/migrations/`: versioned SQL. These files do not automatically alter a Supabase project.
- `supabase/functions/push-notify/`: Web Push endpoint.

## Local development

1. Install Node.js 22.12 or later.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. Fill the public Supabase URL, publishable key, and Storage bucket for a separate **development** project.
5. Review and apply migrations to that development project before testing schema-dependent features.
6. Run `npm run dev`.

Never put a Supabase service-role key in a `VITE_*` variable. Values prefixed with `VITE_` are bundled into the browser.

## Vercel deployment

Build with `npm run build`; Vercel publishes the `dist` directory. The committed `vercel.json` has build settings and security headers. Configure Production, Preview, and Development Supabase values separately in Vercel Project Settings → Environment Variables.

The app retains the existing Supabase URL and publishable key as a backward-compatible fallback. Set environment variables before deploying Preview builds so that test traffic cannot accidentally modify production data.

## Applying database migrations

Review and apply the migrations in a separate development project first, in timestamp order:

1. `202610240001_messaging_features.sql`
2. `202610240002_core_rls_and_rate_limit.sql`
3. `202610240003_private_realtime_channels.sql`
4. `202610240004_e2ee_text_messages.sql` (experimental, opt-in; review the caveats below)

Back up the database and test login, reads/writes, group creation, media Storage policies, and Realtime using two chat members plus a non-member. Migration 002 adds restrictive policies to existing core tables; review the existing permissive policies and grants before applying it to production.

Migration 003 uses private Realtime topics. In Supabase Dashboard, disable public-channel access for this project if that matches the intended security model. The client uses member-scoped private topics (`chat:<chat-uuid>`) for typing and Presence.

Migration 004 only adds the E2EE payload column, a device-key directory, and an opt-in preference; it does **not** turn encryption on automatically. E2EE is experimental and not independently audited. It encrypts only new text messages (not media, chat names, timestamps, push metadata, existing history, or all database metadata). Each participant must register every device before a chat can send encrypted text. A newly added device cannot decrypt earlier messages because it did not receive a key envelope when they were sent; losing local browser data/private key may make messages unrecoverable. Do not promise audited Signal-level security, and test this on a separate development project before enabling it for sensitive content.

## Web Push setup

See `supabase/functions/README.md`. Deploy `push-notify`, configure VAPID and webhook secrets in the Supabase function environment, set the matching **public** VAPID key in `src/main.js`, and create a Database Webhook for INSERT on `public.messages`. Never put a VAPID private key or service-role key in browser code.

## Tests

- `node scripts/check-inline-js.mjs`: module syntax and no-inline-script check.
- `node --test tests/*.test.mjs`: lightweight source smoke tests.
- GitHub Actions runs these checks and a production Vite build on pushes and pull requests.

The repository changes have not yet been fully verified against a live Supabase test project. Migration SQL is committed to GitHub but is not applied automatically to the existing production database.
