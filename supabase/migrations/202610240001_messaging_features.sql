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
alter table public.messages add column if not exists is_pinned boolean not null default false;
create index if not exists messages_expires_at_idx on public.messages (expires_at) where expires_at is not null;

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
  message_expiry_seconds integer not null default 0 check (message_expiry_seconds in (0,3600,86400,604800)),
  updated_at timestamptz not null default now(),
  primary key (user_id, chat_id)
);
alter table public.chat_preferences add column if not exists message_expiry_seconds integer not null default 0;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_preferences_message_expiry_seconds_check'
  ) then
    alter table public.chat_preferences
      add constraint chat_preferences_message_expiry_seconds_check
      check (message_expiry_seconds in (0,3600,86400,604800));
  end if;
end $$;
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


create or replace function public.search_chat_messages(p_query text)
returns table(id uuid, chat_id uuid, sender_id uuid, content text, created_at timestamptz, file_name text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare q text := trim(coalesce(p_query, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(q) < 2 or length(q) > 200 then raise exception 'Search query must be 2-200 characters'; end if;
  return query
    select m.id, m.chat_id, m.sender_id, m.content, m.created_at, m.file_name
    from public.messages m
    where public.is_chat_member(m.chat_id)
      and m.deleted_at is null
      and (m.expires_at is null or m.expires_at > now())
      and coalesce(m.content,'') <> ''
      and to_tsvector('simple', coalesce(m.content,'')) @@ plainto_tsquery('simple', q)
    order by m.created_at desc
    limit 100;
end;
$$;
revoke all on function public.search_chat_messages(text) from public;
grant execute on function public.search_chat_messages(text) to authenticated;

create or replace function public.update_chat_member_role(p_chat_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare caller_role text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_role not in ('admin','member') then raise exception 'Role must be admin or member'; end if;
  select cm.role into caller_role from public.chat_members cm
    where cm.chat_id = p_chat_id and cm.user_id = auth.uid();
  if caller_role is null or caller_role not in ('owner','admin') then raise exception 'Only an owner or admin can change roles'; end if;
  if not exists (select 1 from public.chat_members cm where cm.chat_id=p_chat_id and cm.user_id=p_user_id) then
    raise exception 'Target user is not a member';
  end if;
  if exists (select 1 from public.chat_members cm where cm.chat_id=p_chat_id and cm.user_id=p_user_id and cm.role='owner') then
    raise exception 'Owner role cannot be changed';
  end if;
  update public.chat_members set role=p_role where chat_id=p_chat_id and user_id=p_user_id;
end;
$$;
revoke all on function public.update_chat_member_role(uuid,uuid,text) from public;
grant execute on function public.update_chat_member_role(uuid,uuid,text) to authenticated;

create or replace function public.remove_chat_member(p_chat_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare caller_role text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select cm.role into caller_role from public.chat_members cm
    where cm.chat_id=p_chat_id and cm.user_id=auth.uid();
  if caller_role is null or caller_role not in ('owner','admin') then raise exception 'Only an owner or admin can remove members'; end if;
  if p_user_id = auth.uid() then raise exception 'Use leave-chat flow to remove yourself'; end if;
  if exists (select 1 from public.chat_members cm where cm.chat_id=p_chat_id and cm.user_id=p_user_id and cm.role='owner') then
    raise exception 'The owner cannot be removed';
  end if;
  delete from public.chat_members where chat_id=p_chat_id and user_id=p_user_id;
end;
$$;
revoke all on function public.remove_chat_member(uuid,uuid) from public;
grant execute on function public.remove_chat_member(uuid,uuid) to authenticated;


create index if not exists messages_sender_created_desc_idx
  on public.messages (sender_id, created_at desc);

create or replace function public.get_chat_summaries()
returns table(
  chat_id uuid,
  latest_id uuid,
  latest_sender_id uuid,
  latest_content text,
  latest_created_at timestamptz,
  latest_message_type text,
  latest_file_name text,
  unread_count bigint
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return query
  select cm.chat_id,
         latest.id,
         latest.sender_id,
         latest.content,
         latest.created_at,
         latest.message_type,
         latest.file_name,
         coalesce(unread.total,0)::bigint
  from public.chat_members cm
  left join lateral (
    select m.id,m.sender_id,m.content,m.created_at,m.message_type,m.file_name
    from public.messages m
    where m.chat_id=cm.chat_id and m.deleted_at is null
      and (m.expires_at is null or m.expires_at > now())
    order by m.created_at desc
    limit 1
  ) latest on true
  left join lateral (
    select count(*)::bigint as total
    from public.messages m
    where m.chat_id=cm.chat_id and m.sender_id <> auth.uid()
      and m.read_at is null and m.deleted_at is null
      and (m.expires_at is null or m.expires_at > now())
  ) unread on true
  where cm.user_id=auth.uid();
end;
$$;
revoke all on function public.get_chat_summaries() from public;
grant execute on function public.get_chat_summaries() to authenticated;

create or replace function public.get_chat_stats(p_chat_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.is_chat_member(p_chat_id) then
    raise exception 'Chat membership required';
  end if;
  select jsonb_build_object(
    'total_messages',count(*),
    'my_messages',count(*) filter (where sender_id=auth.uid()),
    'other_messages',count(*) filter (where sender_id<>auth.uid()),
    'first_message_at',min(created_at),
    'latest_message_at',max(created_at),
    'active_days',count(distinct (created_at at time zone 'UTC')::date)
  ) into result
  from public.messages
  where chat_id=p_chat_id and deleted_at is null
    and (expires_at is null or expires_at > now());
  return result;
end;
$$;
revoke all on function public.get_chat_stats(uuid) from public;
grant execute on function public.get_chat_stats(uuid) to authenticated;


create or replace function public.set_message_pinned(p_msg uuid, p_pinned boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare target_chat uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select m.chat_id into target_chat from public.messages m where m.id=p_msg and m.deleted_at is null;
  if target_chat is null or not public.is_chat_member(target_chat) then
    raise exception 'Message not found or chat membership required';
  end if;
  if p_pinned then
    update public.messages set is_pinned=false
    where chat_id=target_chat and is_pinned=true;
  end if;
  update public.messages set is_pinned=p_pinned
  where id=p_msg and chat_id=target_chat;
end;
$$;
revoke all on function public.set_message_pinned(uuid,boolean) from public;
grant execute on function public.set_message_pinned(uuid,boolean) to authenticated;

create or replace function public.add_chat_member(p_chat_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare caller_role text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select cm.role into caller_role from public.chat_members cm
    where cm.chat_id=p_chat_id and cm.user_id=auth.uid();
  if caller_role is null or caller_role not in ('owner','admin') then raise exception 'Only an owner or admin can add members'; end if;
  if not exists (select 1 from auth.users u where u.id=p_user_id) then raise exception 'User not found'; end if;
  insert into public.chat_members (chat_id,user_id,role)
  values (p_chat_id,p_user_id,'member')
  on conflict do nothing;
end;
$$;
revoke all on function public.add_chat_member(uuid,uuid) from public;
grant execute on function public.add_chat_member(uuid,uuid) to authenticated;

create or replace function public.rename_chat(p_chat_id uuid, p_title text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare caller_role text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_title,''))) < 1 or length(trim(p_title)) > 80 then
    raise exception 'Group name must be 1-80 characters';
  end if;
  select cm.role into caller_role from public.chat_members cm
    where cm.chat_id=p_chat_id and cm.user_id=auth.uid();
  if caller_role is null or caller_role not in ('owner','admin') then raise exception 'Only an owner or admin can rename the group'; end if;
  update public.chats set title=trim(p_title)
    where id=p_chat_id and is_group=true;
  if not found then raise exception 'Group chat not found'; end if;
end;
$$;
revoke all on function public.rename_chat(uuid,text) from public;
grant execute on function public.rename_chat(uuid,text) to authenticated;

create or replace function public.purge_expired_messages()
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare removed_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.messages m
  where m.expires_at is not null and m.expires_at <= now()
    and public.is_chat_member(m.chat_id);
  get diagnostics removed_count = row_count;
  return removed_count;
end;
$$;
revoke all on function public.purge_expired_messages() from public;
grant execute on function public.purge_expired_messages() to authenticated;

commit;
