-- Only used by the disposable PostgreSQL test database; no live credentials.
create role anon;
create role authenticated;
create schema auth;
create table auth.users(id uuid primary key,email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
alter default privileges in schema public grant select,insert,update,delete on tables to authenticated;
create schema realtime;
create table realtime.messages(extension text);
create function realtime.topic() returns text language sql stable as $$select 'chat:test'::text$$;

