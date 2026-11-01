-- Only used by the disposable PostgreSQL test database; no live credentials.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create table auth.users(id uuid primary key,email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
alter default privileges in schema public grant select,insert,update,delete on tables to authenticated;
alter default privileges in schema public grant execute on functions to anon,authenticated;
create schema realtime;
create table realtime.messages(extension text);
create function realtime.topic() returns text language sql stable as $$select 'chat:test'::text$$;


-- Managed Supabase schemas: local stubs exercise policies, not HTTP delivery.
create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('role',current_setting('role',true),'sub',auth.uid())$$;
grant execute on function auth.jwt() to authenticated,service_role;
grant usage on schema auth to service_role;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner_id text);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select,insert,update,delete on storage.objects to authenticated;
create schema vault;
create table vault.decrypted_secrets(name text,decrypted_secret text);
create schema net;
create function net.http_post(url text,body jsonb default '{}'::jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 5000)
returns bigint language sql as $$select 1::bigint$$;
