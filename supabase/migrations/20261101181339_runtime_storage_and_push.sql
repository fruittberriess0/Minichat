-- Private media and a Vault-backed push webhook. Credentials are provisioned
-- separately; this file contains no private key or webhook secret.
begin;
do $$ begin
  if exists(select 1 from pg_available_extensions where name='pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end $$;
insert into storage.buckets(id,name,public,file_size_limit)
values('chat-media','chat-media',false,26214400) on conflict(id) do nothing;

create or replace function minichat_private.can_read_media(p_name text)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare owner_part text:=split_part(p_name,'/',1); folder text:=split_part(p_name,'/',2); target uuid;
begin
  if auth.uid() is null or owner_part !~ '^[0-9a-fA-F-]{36}$' then return false; end if;
  begin target:=owner_part::uuid; exception when others then return false; end;
  if folder='avatar' then return public.can_view_profile(target); end if;
  if folder !~ '^[0-9a-fA-F-]{36}$' then return false; end if;
  begin target:=folder::uuid; exception when others then return false; end;
  return public.is_chat_member(target) and (owner_part=auth.uid()::text or exists(
    select 1 from public.messages m where m.chat_id=target and m.media_path=p_name
      and m.deleted_at is null and (m.expires_at is null or m.expires_at>now())
  ));
end $$;
create or replace function minichat_private.can_write_media(p_name text)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare folder text:=split_part(p_name,'/',2); target uuid;
begin
  if auth.uid() is null or split_part(p_name,'/',1)<>auth.uid()::text then return false; end if;
  if folder='avatar' then return true; end if;
  if folder !~ '^[0-9a-fA-F-]{36}$' then return false; end if;
  begin target:=folder::uuid; exception when others then return false; end;
  return public.is_chat_member(target);
end $$;
revoke all on function minichat_private.can_read_media(text),minichat_private.can_write_media(text) from public,anon;
grant execute on function minichat_private.can_read_media(text),minichat_private.can_write_media(text) to authenticated;

drop policy if exists minichat_media_read on storage.objects;
create policy minichat_media_read on storage.objects for select to authenticated
  using(bucket_id='chat-media' and minichat_private.can_read_media(name));
drop policy if exists minichat_media_insert on storage.objects;
create policy minichat_media_insert on storage.objects for insert to authenticated
  with check(bucket_id='chat-media' and minichat_private.can_write_media(name));
drop policy if exists minichat_media_update on storage.objects;
create policy minichat_media_update on storage.objects for update to authenticated
  using(bucket_id='chat-media' and minichat_private.can_write_media(name))
  with check(bucket_id='chat-media' and minichat_private.can_write_media(name));
drop policy if exists minichat_media_delete on storage.objects;
create policy minichat_media_delete on storage.objects for delete to authenticated
  using(bucket_id='chat-media' and minichat_private.can_write_media(name));

create or replace function minichat_private.push_configuration()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare config jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'Service access required' using errcode='42501';
  end if;
  select coalesce(jsonb_object_agg(name,decrypted_secret),'{}'::jsonb) into config
    from vault.decrypted_secrets where name in
      ('minichat_vapid_public','minichat_vapid_private','minichat_vapid_subject','minichat_push_webhook');
  return config;
end $$;
revoke all on function minichat_private.push_configuration() from public,anon,authenticated;
grant usage on schema minichat_private to service_role;
grant execute on function minichat_private.push_configuration() to service_role;
create or replace function public.get_minichat_push_configuration()
returns jsonb language sql security invoker set search_path='' as $$
  select minichat_private.push_configuration();
$$;
revoke all on function public.get_minichat_push_configuration() from public,anon,authenticated;
grant execute on function public.get_minichat_push_configuration() to service_role;

create or replace function minichat_private.enqueue_message_push()
returns trigger language plpgsql security definer set search_path='' as $$
declare project_url text; webhook text;
begin
  select decrypted_secret into project_url from vault.decrypted_secrets where name='minichat_project_url' limit 1;
  select decrypted_secret into webhook from vault.decrypted_secrets where name='minichat_push_webhook' limit 1;
  if project_url is null or webhook is null then return new; end if;
  perform net.http_post(
    url:=project_url||'/functions/v1/push-notify',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||webhook),
    body:=jsonb_build_object('type','INSERT','schema','public','table','messages',
      'record',jsonb_build_object('id',new.id,'chat_id',new.chat_id,'sender_id',new.sender_id)),
    timeout_milliseconds:=10000
  );
  return new;
exception when others then
  raise warning 'Push notification could not be queued';
  return new;
end $$;
revoke all on function minichat_private.enqueue_message_push() from public,anon,authenticated;
drop trigger if exists minichat_push_on_message on public.messages;
create trigger minichat_push_on_message after insert on public.messages
  for each row execute function minichat_private.enqueue_message_push();
commit;
