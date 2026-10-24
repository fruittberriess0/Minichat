-- Defense-in-depth policies for existing core tables plus a database insert rate limit.
-- Review against the current Supabase policies in a dev project before applying to production.
begin;

create or replace function public.can_view_profile(p_profile_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select p_profile_id = auth.uid() or exists (
    select 1
    from public.chat_members mine
    join public.chat_members theirs on theirs.chat_id = mine.chat_id
    where mine.user_id = auth.uid() and theirs.user_id = p_profile_id
  );
$$;

create or replace function public.can_manage_chat(p_chat_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.chat_members cm
    where cm.chat_id = p_chat_id
      and cm.user_id = auth.uid()
      and cm.role in ('owner','admin')
  );
$$;

revoke all on function public.can_view_profile(uuid) from public;
revoke all on function public.can_manage_chat(uuid) from public;
grant execute on function public.can_view_profile(uuid) to authenticated;
grant execute on function public.can_manage_chat(uuid) to authenticated;

alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.profiles enable row level security;

-- Restrictive policies add a membership/ownership ceiling even when older permissive
-- policies remain in place; helper functions are SECURITY DEFINER to avoid recursion.
drop policy if exists chats_guard_member_select on public.chats;
create policy chats_guard_member_select on public.chats
  as restrictive for select to authenticated using (public.is_chat_member(id));
drop policy if exists chats_guard_no_direct_insert on public.chats;
create policy chats_guard_no_direct_insert on public.chats
  as restrictive for insert to authenticated with check (false);
drop policy if exists chats_guard_no_direct_update on public.chats;
create policy chats_guard_no_direct_update on public.chats
  as restrictive for update to authenticated using (false) with check (false);
drop policy if exists chats_guard_no_direct_delete on public.chats;
create policy chats_guard_no_direct_delete on public.chats
  as restrictive for delete to authenticated using (false);

drop policy if exists chat_members_guard_member_select on public.chat_members;
create policy chat_members_guard_member_select on public.chat_members
  as restrictive for select to authenticated using (public.is_chat_member(chat_id));
drop policy if exists chat_members_guard_no_direct_insert on public.chat_members;
create policy chat_members_guard_no_direct_insert on public.chat_members
  as restrictive for insert to authenticated with check (false);
drop policy if exists chat_members_guard_no_direct_update on public.chat_members;
create policy chat_members_guard_no_direct_update on public.chat_members
  as restrictive for update to authenticated using (false) with check (false);
drop policy if exists chat_members_guard_no_direct_delete on public.chat_members;
create policy chat_members_guard_no_direct_delete on public.chat_members
  as restrictive for delete to authenticated using (false);

drop policy if exists messages_guard_member_select on public.messages;
create policy messages_guard_member_select on public.messages
  as restrictive for select to authenticated using (public.is_chat_member(chat_id));
drop policy if exists messages_guard_sender_insert on public.messages;
create policy messages_guard_sender_insert on public.messages
  as restrictive for insert to authenticated
  with check (public.is_chat_member(chat_id) and sender_id = auth.uid());
drop policy if exists messages_guard_owner_update on public.messages;
create policy messages_guard_owner_update on public.messages
  as restrictive for update to authenticated
  using (public.is_chat_member(chat_id) and (sender_id = auth.uid() or public.can_manage_chat(chat_id)))
  with check (public.is_chat_member(chat_id) and (sender_id = auth.uid() or public.can_manage_chat(chat_id)));
drop policy if exists messages_guard_owner_delete on public.messages;
create policy messages_guard_owner_delete on public.messages
  as restrictive for delete to authenticated
  using (public.is_chat_member(chat_id) and (sender_id = auth.uid() or public.can_manage_chat(chat_id)));

drop policy if exists profiles_guard_member_select on public.profiles;
create policy profiles_guard_member_select on public.profiles
  as restrictive for select to authenticated using (public.can_view_profile(id));
drop policy if exists profiles_guard_self_insert on public.profiles;
create policy profiles_guard_self_insert on public.profiles
  as restrictive for insert to authenticated with check (id = auth.uid());
drop policy if exists profiles_guard_self_update on public.profiles;
create policy profiles_guard_self_update on public.profiles
  as restrictive for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_guard_no_browser_delete on public.profiles;
create policy profiles_guard_no_browser_delete on public.profiles
  as restrictive for delete to authenticated using (false);

-- A count against already-committed inserts cannot be rolled back by the rate-limit
-- exception itself, unlike a counter table updated in this same transaction.
create or replace function public.enforce_message_insert_rate_limit()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  recent_count integer;
begin
  if actor is null then return new; end if;
  if new.sender_id is distinct from actor then
    raise exception 'Sender must match authenticated user' using errcode = '42501';
  end if;
  -- Do not trust a client-supplied timestamp to bypass the quota.
  new.created_at := now();
  -- Serialize concurrent inserts from the same user to make the quota meaningful.
  perform pg_advisory_xact_lock(hashtext(actor::text));
  select count(*) into recent_count
    from public.messages m
    where m.sender_id = actor and m.created_at > now() - interval '1 minute';
  if recent_count >= 60 then
    raise exception 'Message rate limit exceeded; try again in a minute' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists messages_insert_rate_limit on public.messages;
create trigger messages_insert_rate_limit
  before insert on public.messages
  for each row execute function public.enforce_message_insert_rate_limit();

commit;
