# MiniChat rollout notes

## Present in source
- Paginated messages and day separators.
- Realtime typing broadcast and online Presence (with last-seen fallback).
- Chat list previews, timestamps and unread badges.
- Scroll-to-latest button and reply-to-original navigation.
- Theme toggle, drafts, search, chat text export and keyboard search shortcut.
- PWA manifest/service worker shell and notification-click handler.
- Migration source for reactions, saved messages, chat preferences, push subscriptions, roles, indexes and secure chat-creation helper.
- Source syntax/smoke checks in GitHub Actions.

## Next implementation stages
1. Apply and verify the optional Supabase migration in a backed-up development project first.
2. Finish reaction counts, saved messages, mute preferences and chat-creation UX against the migration.
3. Add real Web Push subscription management and a protected Edge Function with VAPID secrets; test unsubscribe and invalid endpoints.
4. Complete media upload UX, photo viewer and voice recording, then test on iOS Safari and desktop.
5. Move the single-file page into Vite modules without switching production until the preview deployment passes.
6. Add integration tests against a disposable Supabase project and verify RLS with two members and a non-member.
7. Design E2EE and WebRTC separately; do not retrofit them as unreviewed UI-only options.

## Production caveat
The repository migration file is not a live database migration. The PWA install/offline shell works independently, while push notifications require backend setup. The current CSP needs an inline-script allowance until the app's inline JavaScript is extracted to files.
