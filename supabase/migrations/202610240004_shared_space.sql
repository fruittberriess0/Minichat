-- Shared-space features: tasks, calendar events, relationship dates, polls and location cards.
begin;

create table if not exists public.shared_items (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('task','event','anniversary','poll','location')),
  title text not null check (length(trim(title)) between 1 and 120),
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  due_at timestamptz,
  is_done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shared_items_chat_type_created_idx
  on public.shared_items (chat_id,item_type,created_at desc);
create index if not exists shared_items_due_idx
  on public.shared_items (chat_id,due_at) where due_at is not null;

alter table public.shared_items enable row level security;
drop policy if exists shared_items_member_select on public.shared_items;
create policy shared_items_member_select on public.shared_items
  for select to authenticated using (public.is_chat_member(chat_id));
drop policy if exists shared_items_member_insert on public.shared_items;
create policy shared_items_member_insert on public.shared_items
  for insert to authenticated with check (created_by=auth.uid() and public.is_chat_member(chat_id));
drop policy if exists shared_items_author_admin_update on public.shared_items;
create policy shared_items_author_admin_update on public.shared_items
  for update to authenticated
  using (created_by=auth.uid() or public.can_manage_chat(chat_id))
  with check (created_by=auth.uid() or public.can_manage_chat(chat_id));
drop policy if exists shared_items_author_admin_delete on public.shared_items;
create policy shared_items_author_admin_delete on public.shared_items
  for delete to authenticated
  using (created_by=auth.uid() or public.can_manage_chat(chat_id));

create or replace function public.can_access_shared_item(p_item_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.shared_items si
    join public.chat_members cm on cm.chat_id=si.chat_id
    where si.id=p_item_id and cm.user_id=auth.uid()
  );
$$;
revoke all on function public.can_access_shared_item(uuid) from public;
grant execute on function public.can_access_shared_item(uuid) to authenticated;

create table if not exists public.shared_item_votes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.shared_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  option_index integer not null check (option_index >= 0),
  created_at timestamptz not null default now(),
  unique(item_id,user_id)
);
create index if not exists shared_item_votes_item_idx
  on public.shared_item_votes (item_id,option_index);
alter table public.shared_item_votes enable row level security;

create or replace function public.can_vote_shared_item(p_item_id uuid,p_option_index integer)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare options jsonb; item_kind text;
begin
  if auth.uid() is null or p_option_index < 0 then return false; end if;
  select si.payload->'options',si.item_type into options,item_kind
  from public.shared_items si
  join public.chat_members cm on cm.chat_id=si.chat_id and cm.user_id=auth.uid()
  where si.id=p_item_id;
  if not found or item_kind <> 'poll' or jsonb_typeof(options) <> 'array' then return false; end if;
  return p_option_index < jsonb_array_length(options);
end;
$$;
revoke all on function public.can_vote_shared_item(uuid,integer) from public;
grant execute on function public.can_vote_shared_item(uuid,integer) to authenticated;

drop policy if exists shared_item_votes_member_select on public.shared_item_votes;
create policy shared_item_votes_member_select on public.shared_item_votes
  for select to authenticated using (public.can_access_shared_item(item_id));
drop policy if exists shared_item_votes_own_insert on public.shared_item_votes;
create policy shared_item_votes_own_insert on public.shared_item_votes
  for insert to authenticated
  with check (user_id=auth.uid() and public.can_vote_shared_item(item_id,option_index));
drop policy if exists shared_item_votes_own_update on public.shared_item_votes;
create policy shared_item_votes_own_update on public.shared_item_votes
  for update to authenticated
  using (user_id=auth.uid() and public.can_access_shared_item(item_id))
  with check (user_id=auth.uid() and public.can_vote_shared_item(item_id,option_index));
drop policy if exists shared_item_votes_own_delete on public.shared_item_votes;
create policy shared_item_votes_own_delete on public.shared_item_votes
  for delete to authenticated using (user_id=auth.uid() and public.can_access_shared_item(item_id));

create or replace function public.set_shared_item_done(p_item_id uuid,p_is_done boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare target_chat uuid; target_type text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select si.chat_id,si.item_type into target_chat,target_type
  from public.shared_items si where si.id=p_item_id;
  if target_chat is null or target_type <> 'task' or not public.is_chat_member(target_chat) then
    raise exception 'Task not found or membership required';
  end if;
  update public.shared_items set is_done=p_is_done,updated_at=now() where id=p_item_id;
end;
$$;
revoke all on function public.set_shared_item_done(uuid,boolean) from public;
grant execute on function public.set_shared_item_done(uuid,boolean) to authenticated;

commit;
