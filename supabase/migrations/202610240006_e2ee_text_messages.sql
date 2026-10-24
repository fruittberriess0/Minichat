-- Experimental end-to-end encryption for new text messages.
-- This migration is opt-in and does not modify existing message contents.
-- Apply only after 001-005, first in a separate development Supabase project.
begin;

alter table public.messages
  add column if not exists encrypted_payload jsonb;

alter table public.chat_preferences
  add column if not exists e2ee_enabled boolean not null default false;

create table if not exists public.e2ee_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null check (length(device_id) between 8 and 128),
  public_key jsonb not null
    check (public_key->>'kty' = 'EC' and public_key->>'crv' = 'P-256'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, device_id)
);

create index if not exists e2ee_devices_user_active_idx
  on public.e2ee_devices (user_id, last_seen_at desc)
  where revoked_at is null;

alter table public.e2ee_devices enable row level security;

drop policy if exists e2ee_devices_select_self_or_chat_member on public.e2ee_devices;
create policy e2ee_devices_select_self_or_chat_member on public.e2ee_devices
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.chat_members mine
      join public.chat_members peer on peer.chat_id = mine.chat_id
      where mine.user_id = auth.uid()
        and peer.user_id = e2ee_devices.user_id
    )
  );

drop policy if exists e2ee_devices_insert_self on public.e2ee_devices;
create policy e2ee_devices_insert_self on public.e2ee_devices
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists e2ee_devices_update_self on public.e2ee_devices;
create policy e2ee_devices_update_self on public.e2ee_devices
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists e2ee_devices_delete_self on public.e2ee_devices;
create policy e2ee_devices_delete_self on public.e2ee_devices
  for delete to authenticated
  using (user_id = auth.uid());

commit;
