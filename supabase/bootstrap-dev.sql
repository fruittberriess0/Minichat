-- ONLY for an empty development Supabase project, BEFORE migrations.
-- Plain CREATE TABLE deliberately refuses to overwrite an existing database.
begin;
create schema if not exists minichat_private;
revoke all on schema minichat_private from public,anon;
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 username text not null unique,
 avatar_url text,avatar_path text,status_text text,last_seen timestamptz,
 created_at timestamptz default now()
);
create table public.chats (
 id uuid primary key default gen_random_uuid(),title text,is_group boolean default false,created_at timestamptz default now()
);
create table public.chat_members (
 chat_id uuid references public.chats(id) on delete cascade,
 user_id uuid references auth.users(id) on delete cascade,
 joined_at timestamptz default now(),primary key(chat_id,user_id)
);
create table public.messages (
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null references public.chats(id) on delete cascade,
 sender_id uuid not null references auth.users(id),content text,
 image_url text,file_url text,media_path text,file_name text,mime_type text,
 message_type text not null default 'text',created_at timestamptz not null default now(),
 read_at timestamptz,edited_at timestamptz,deleted_at timestamptz,
 reply_to_id uuid references public.messages(id) on delete set null,
 forwarded_from_id uuid,is_pinned boolean not null default false
);
create function public.is_chat_member(check_chat_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.chat_members where chat_id=check_chat_id and user_id=auth.uid());
$$;
revoke all on function public.is_chat_member(uuid) from public,anon;
grant execute on function public.is_chat_member(uuid) to authenticated;

alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.profiles enable row level security;
grant select,insert,update,delete on public.chats,public.chat_members,public.messages,public.profiles to authenticated;
create policy chats_member on public.chats for select to authenticated using(public.is_chat_member(id));
create policy members_member on public.chat_members for select to authenticated using(public.is_chat_member(chat_id));
create policy messages_member on public.messages for select to authenticated using(public.is_chat_member(chat_id));
create policy messages_sender_insert on public.messages for insert to authenticated with check(sender_id=auth.uid() and public.is_chat_member(chat_id));
create policy messages_sender_update on public.messages for update to authenticated using(sender_id=auth.uid() and public.is_chat_member(chat_id)) with check(sender_id=auth.uid() and public.is_chat_member(chat_id));
create policy messages_sender_delete on public.messages for delete to authenticated using(sender_id=auth.uid() and public.is_chat_member(chat_id));
create policy profiles_visible on public.profiles for select to authenticated using(id=auth.uid() or exists(
 select 1 from public.chat_members mine join public.chat_members theirs using(chat_id) where mine.user_id=auth.uid() and theirs.user_id=profiles.id
));
create policy profiles_self_insert on public.profiles for insert to authenticated with check(id=auth.uid());
create policy profiles_self_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());

create function minichat_private.create_profile() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,username) values(new.id,'Участник-'||left(new.id::text,8));
 return new;
end $$;
revoke all on function minichat_private.create_profile() from public,anon,authenticated;
create trigger minichat_create_profile after insert on auth.users for each row execute function minichat_private.create_profile();
commit;
