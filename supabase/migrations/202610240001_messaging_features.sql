-- MiniChat feature migration. Versioned in GitHub; not applied to production automatically.
begin;

create index if not exists messages_chat_created_desc_idx
  on public.messages (chat_id, created_at desc);
create index if not exists messages_chat_unread_idx
  on public.messages (chat_id, read_at)
  where read_at is null and deleted_at is null;
create index if not exists chat_members_user_chat_idx
  on public.chat_members (user_id, chat_id);
create index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

alter table public.chat_members add column if not exists role text not null default 'member';
alter table public.messages add column if not exists expires_at timestamptz;

create or replace function public.is_chat_member(p_chat_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.chat_members cm
    where cm.chat_id = p_chat_id and cm.user_id = auth.uid()
  );
$$;

create or replace function public.can_access_message(p_message_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.messages m
    join public.chat_members cm on cm.chat_id = m.chat_id
    where m.id = p_message_id and cm.user_id = auth.uid()
  );
$$;

revoke all on function public.is_chat_member(uuid) from public;
revoke all on function public.can_access_message(uuid) from public;
grant execute on function public.is_chat_member(uuid) to authenticated;
grant execute on function public.can_access_message(uuid) to authenticated;

create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null check (reaction in ('❤️','👍','😂')),
  created_at timestamptz not null default now(),
  unique (message_id, user_id, reaction)
);
create index if not exists message_reactions_message_idx
  on public.message_reactions (message_id, created_at);
alter table public.message_reactions enable row level security;
drop policy if exists message_reactions_select_member on public.message_reactions;
create policy message_reactions_select_member on public.message_reactions
  for select to authenticated using (public.can_access_message(message_id));
drop policy if exists message_reactions_insert_self on public.message_reactions;
create policy message_reactions_insert_self on public.message_reactions
  for insert to authenticated with check (user_id = auth.uid() and public.can_access_message(message_id));
drop policy if exists message_reactions_delete_self on public.message_reactions;
create policy message_reactions_delete_self on public.message_reactions
  for delete to authenticated using (user_id = auth.uid() and public.can_access_message(message_id));

create table if not exists public.saved_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, message_id)
);
alter table public.saved_messages enable row level security;
drop policy if exists saved_messages_select_self on public.saved_messages;
create policy saved_messages_select_self on public.saved_messages
  for select to authenticated using (user_id = auth.uid() and public.can_access_message(message_id));
drop policy if exists saved_messages_insert_self on public.saved_messages;
create policy saved_messages_insert_self on public.saved_messages
  for insert to authenticated with check (user_id = auth.uid() and public.can_access_message(message_id));
drop policy if exists saved_messages_delete_self on public.saved_messages;
create policy saved_messages_delete_self on public.saved_messages
  for delete to authenticated using (user_id = auth.uid() and public.can_access_message(message_id));

create table if not exists public.chat_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  muted boolean not null default false,
  wallpaper text not null default 'dots' check (wallpaper in ('dots','plain','hearts')),
  updated_at timestamptz not null default now(),
  primary key (user_id, chat_id)
);
alter table public.chat_preferences enable row level security;
drop policy if exists chat_preferences_select_self on public.chat_preferences;
create policy chat_preferences_select_self on public.chat_preferences
  for select to authenticated using (user_id = auth.uid() and public.is_chat_member(chat_id));
drop policy if exists chat_preferences_insert_self on public.chat_preferences;
create policy chat_preferences_insert_self on public.chat_preferences
  for insert to authenticated with check (user_id = auth.uid() and public.is_chat_member(chat_id));
drop policy if exists chat_preferences_update_self on public.chat_preferences;
create policy chat_preferences_update_self on public.chat_preferences
  for update to authenticated using (user_id = auth.uid() and public.is_chat_member(chat_id))
  with check (user_id = auth.uid() and public.is_chat_member(chat_id));

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_select_self on public.push_subscriptions;
create policy push_subscriptions_select_self on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
drop policy if exists push_subscriptions_insert_self on public.push_subscriptions;
create policy push_subscriptions_insert_self on public.push_subscriptions
  for insert to authenticated with check (user_id = auth.uid() and endpoint = subscription->>'endpoint');
drop policy if exists push_subscriptions_update_self on public.push_subscriptions;
create policy push_subscriptions_update_self on public.push_subscriptions
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid() and endpoint = subscription->>'endpoint');
drop policy if exists push_subscriptions_delete_self on public.push_subscriptions;
create policy push_subscriptions_delete_self on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

create or replace function public.find_chat_user(p_query text)
returns table(user_id uuid, username text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare q text := trim(coalesce(p_query, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(q) < 2 or length(q) > 254 then raise exception 'Query must be 2-254 characters'; end if;
  return query
    select p.id, p.username
    from public.profiles p
    left join auth.users u on u.id = p.id
    where p.id <> auth.uid()
      and (lower(coalesce(p.username,'')) = lower(q)
        or lower(coalesce(u.email,'')) = lower(q))
    order by case when lower(coalesce(p.username,'')) = lower(q) then 0 else 1 end
    limit 1;
end;
$$;
revoke all on function public.find_chat_user(text) from public;
grant execute on function public.find_chat_user(text) to authenticated;

create or replace function public.create_chat_with_members(
  p_title text,
  p_is_group boolean,
  p_member_ids uuid[]
)
returns uuid language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  new_chat_id uuid;
  member_id uuid;
  unique_members uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if coalesce(array_length(p_member_ids,1),0) < 1 or array_length(p_member_ids,1) > 50 then
    raise exception 'A chat must include 1-50 other members';
  end if;
  select array_agg(distinct x) into unique_members
    from unnest(p_member_ids || array[auth.uid()]) x
    where x is not null;
  if p_is_group and length(trim(coalesce(p_title,''))) = 0 then
    raise exception 'Group title is required';
  end if;
  insert into public.chats (title, is_group)
  values (case when p_is_group then left(trim(p_title),80) else null end, p_is_group)
  returning id into new_chat_id;
  foreach member_id in array unique_members loop
    insert into public.chat_members (chat_id, user_id, role)
    values (new_chat_id, member_id, case when member_id = auth.uid() then 'owner' else 'member' end)
    on conflict do nothing;
  end loop;
  return new_chat_id;
end;
$$;
revoke all on function public.create_chat_with_members(text,boolean,uuid[]) from public;
grant execute on function public.create_chat_with_members(text,boolean,uuid[]) to authenticated;

commit;
