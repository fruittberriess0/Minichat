# MiniChat security notes

## Current browser architecture
- The browser uses the Supabase publishable key. Never replace it with a service-role or secret key.
- Private media access depends on the Storage policies and signed-URL creation in index.html. A private bucket alone is not enough; test the policies with both chat members and unrelated accounts.
- The Vercel Content Security Policy must currently allow inline scripts because the application remains a single-file HTML page. Moving scripts to versioned files and removing the unsafe-inline allowance is a follow-up hardening task.
- The app-shell service worker caches only same-origin static resources. It does not cache Supabase API, auth, Realtime or Storage responses.

## Supabase migration
supabase/migrations/202610240001_messaging_features.sql adds optional feature tables, indexes, membership helpers and chat-creation RPCs. It is versioned in GitHub but is not automatically applied to production Supabase. Review it and take a database backup before applying.

## Important limitations
- Reactions require the messaging feature migration.
- Web Push needs real VAPID keys and a trusted server/Edge Function that sends signed push payloads; never put VAPID private keys or the Supabase service-role key in browser code.
- OAuth providers must be configured in Supabase Auth and in the provider consoles.
- A local PIN is not a substitute for account authentication or end-to-end encryption.
- E2EE requires a reviewed key-exchange, identity verification, multi-device and recovery design. Do not label the product end-to-end encrypted until implemented and independently reviewed.
