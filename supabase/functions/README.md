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
5. Add the matching VAPID public key to the WEB_PUSH_VAPID_PUBLIC_KEY constant in index.html, deploy, then enable notifications in the user settings.
6. Test with two users and remove subscriptions that receive 404/410 responses.

The function intentionally sends generic notification text instead of message contents to reduce sensitive lock-screen exposure. Do not log subscription payloads or VAPID secrets.
