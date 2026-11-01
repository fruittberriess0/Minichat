# Web Push setup

The application shell and notification event handler are in place. Sending pushes requires project-level configuration; no private key is committed.

1. Generate a VAPID public/private key pair outside the browser.
2. Set the following secrets for this Supabase project:
   - PUSH_WEBHOOK_SECRET: a long random value used only between the Supabase Database Webhook and the Edge Function.
   - VAPID_PUBLIC_KEY
   - VAPID_PRIVATE_KEY
   - VAPID_SUBJECT: a mailto: contact or the application's HTTPS origin.
   - SUPABASE_SERVICE_ROLE_KEY is supplied by the Supabase Edge Function environment; never expose it in the browser.
3. Deploy the push-notify Edge Function.
4. Create a Database Webhook for INSERT on public.messages, targeting the deployed function URL. Add an Authorization header with Bearer followed by the exact PUSH_WEBHOOK_SECRET value.
5. Configure the matching public key as `VITE_WEB_PUSH_VAPID_PUBLIC_KEY` in Vercel Project Settings → Environment Variables (Preview/Development/Production as appropriate), or in `.env.local` for local development. Rebuild/redeploy, then enable notifications in the user settings. The browser key is public; the VAPID private key must remain only in the Edge Function secrets.
6. Test with two users and remove subscriptions that receive 404/410 responses.

The function intentionally sends generic notification text instead of message contents to reduce sensitive lock-screen exposure. Do not log subscription payloads or VAPID secrets.

## Vault-backed setup

Migration runtime_storage_and_push creates a private media bucket, member-scoped Storage policies and a database webhook using pg_net. Server push configuration may be stored in Supabase Vault under minichat_vapid_public, minichat_vapid_private, minichat_vapid_subject, minichat_push_webhook and minichat_project_url. The browser receives only the public VAPID key.

The Edge Function reads the four notification values through a service-role-only RPC. Anonymous and signed-in browser clients cannot call that RPC. The webhook sends only the message ID to this project's own Edge Function; push providers receive only an encrypted generic notification. No chat ID, user ID, message ID, private file URL or message text is included in the push payload. Supported endpoint hosts are the browser push services operated by Google, Mozilla, Apple and Microsoft. The function verifies the stored message before sending and removes subscriptions returning 404/410.
