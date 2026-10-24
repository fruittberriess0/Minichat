-- Browser-device session list and remote revocation. Does not expose auth refresh tokens.
begin;

create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  device_label text not null default 'Browser',
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id,device_id)
);
create index if not exists user_devices_user_last_seen_idx
  on public.user_devices (user_id,last_seen desc) where revoked_at is null;
alter table public.user_devices enable row level security;
revoke all on public.user_devices from anon,authenticated;

create or replace function public.touch_device_session(p_device_id uuid,p_device_label text)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare affected integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_device_id is null then raise exception 'Device ID is required'; end if;
  insert into public.user_devices(user_id,device_id,device_label)
  values(auth.uid(),p_device_id,left(coalesce(nullif(trim(p_device_label),''),'Browser'),180))
  on conflict(user_id,device_id) do update
    set device_label=excluded.device_label,last_seen=now()
    where public.user_devices.revoked_at is null;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;
revoke all on function public.touch_device_session(uuid,text) from public;
grant execute on function public.touch_device_session(uuid,text) to authenticated;

create or replace function public.list_user_devices(p_current_device_id uuid)
returns table(
  device_id uuid,
  device_label text,
  created_at timestamptz,
  last_seen timestamptz,
  is_current boolean
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return query
    select d.device_id,d.device_label,d.created_at,d.last_seen,
      (d.device_id=p_current_device_id)
    from public.user_devices d
    where d.user_id=auth.uid() and d.revoked_at is null
    order by d.last_seen desc
    limit 50;
end;
$$;
revoke all on function public.list_user_devices(uuid) from public;
grant execute on function public.list_user_devices(uuid) to authenticated;

create or replace function public.revoke_user_device(p_device_id uuid,p_current_device_id uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare affected integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_device_id is null or p_device_id=p_current_device_id then
    raise exception 'Use sign out on this device or global sign out';
  end if;
  update public.user_devices d set revoked_at=now()
    where d.user_id=auth.uid() and d.device_id=p_device_id and d.revoked_at is null;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;
revoke all on function public.revoke_user_device(uuid,uuid) from public;
grant execute on function public.revoke_user_device(uuid,uuid) to authenticated;

commit;
