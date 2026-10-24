-- Private Supabase Realtime channels for chat Broadcast (typing) and Presence.
-- Apply after the messaging migrations. Do not ALTER realtime.messages: Supabase owns its RLS state.
begin;

create or replace function public.minichat_realtime_topic_is_member()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  topic_value text;
  topic_chat_id uuid;
begin
  if auth.uid() is null then return false; end if;
  topic_value := realtime.topic();
  if topic_value is null or topic_value !~ '^chat:[0-9a-fA-F-]{36}$' then return false; end if;
  begin
    topic_chat_id := substring(topic_value from 6)::uuid;
  exception when others then
    return false;
  end;
  return exists (
    select 1 from public.chat_members cm
    where cm.chat_id = topic_chat_id and cm.user_id = auth.uid()
  );
end;
$$;
revoke all on function public.minichat_realtime_topic_is_member() from public;
grant execute on function public.minichat_realtime_topic_is_member() to authenticated;

-- Permissive policies let valid members join. Restrictive guards also constrain any
-- older broad permissive policies that may already exist in this project.
drop policy if exists minichat_realtime_member_select on realtime.messages;
create policy minichat_realtime_member_select on realtime.messages
  as permissive for select to authenticated
  using (
    extension in ('broadcast','presence')
    and public.minichat_realtime_topic_is_member()
  );
drop policy if exists minichat_realtime_member_select_guard on realtime.messages;
create policy minichat_realtime_member_select_guard on realtime.messages
  as restrictive for select to authenticated
  using (
    extension in ('broadcast','presence')
    and public.minichat_realtime_topic_is_member()
  );

drop policy if exists minichat_realtime_member_insert on realtime.messages;
create policy minichat_realtime_member_insert on realtime.messages
  as permissive for insert to authenticated
  with check (
    extension in ('broadcast','presence')
    and public.minichat_realtime_topic_is_member()
  );
drop policy if exists minichat_realtime_member_insert_guard on realtime.messages;
create policy minichat_realtime_member_insert_guard on realtime.messages
  as restrictive for insert to authenticated
  with check (
    extension in ('broadcast','presence')
    and public.minichat_realtime_topic_is_member()
  );

commit;
