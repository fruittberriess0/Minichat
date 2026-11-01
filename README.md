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
2. Run `npm ci`.
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

## Mobile workspace update

- All chat actions are in **•••** in the conversation header: calls, shared album, tasks, group management, export, selection, and refresh. The panel scrolls on short screens.
- **＋** beside the composer opens emoji, stickers, formatting, file attachments, audio/video recording, and message lifetime. A separate stop-and-send button remains visible during recording.
- The profile opens from the chat list on phones and scrolls through all settings. The login screen also scrolls on short viewports.
- Chat filters show all, unread, or favorite chats. Favorites are pinned first and saved for the current account on this browser; they do not sync between devices.
- Drafts are isolated by account and chat. Offline sends keep the text in the composer. Failed sends survive switching chats in the same tab and can be retried manually with the same message UUID to avoid duplicate inserts. Failed sends are **not** a persistent offline outbox: keep the tab open until delivered.
- Chat creation, message search, saved messages, forwarding, and group administration use dialogs. Group controls respect the displayed membership role; the existing Supabase RPCs still enforce permissions on the server.
- Forwarding copies text or the attachment name, not the file itself. Encrypted source messages cannot be forwarded. Forwarding to an E2EE-enabled target requires its device keys and does not fall back to plaintext.
- Export includes only currently loaded history and is labeled accordingly.

No database migration is introduced by this update. Existing RPCs and tables from the committed migrations are still required for backend features. Older unscoped drafts are intentionally not imported across accounts on shared devices.

### Validation in the cloud environment

```sh
cd /workspace/Minichat
npm ci --no-audit --no-fund
npm test
npm run build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is optional. It selects a system Chromium when the cloud image already provides one. Otherwise install the normal Playwright browser with `npx playwright install --with-deps chromium` and omit this variable. The browser configuration uses an isolated local Supabase URL with mocked responses; it never sends test writes to the fallback production project. Run the browser tests without a previously running server on port 4173 so that the test environment settings take effect.

Browser tests cover 320, 390, 768, and 1280 pixel layouts, account-scoped drafts/favorites, offline handling, stale chat requests, duplicate-safe retries, safe search output, group RPC contracts, and forwarding safeguards. These tests do not establish live Supabase authorization, RLS, WebRTC connectivity, push delivery, hardware recording on iOS, or audited E2EE. Test those separately against a development Supabase project with two members and a non-member before rollout.
