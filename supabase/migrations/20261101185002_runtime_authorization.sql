-- Supabase can explicitly grant anon EXECUTE through its default privileges;
-- revoking PUBLIC alone does not remove those grants.
begin;
do $$ declare fn record; begin
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'is_chat_member','can_access_message','can_manage_chat','can_view_profile','find_chat_user',
      'create_chat_with_members','search_chat_messages','update_chat_member_role','remove_chat_member',
      'get_chat_summaries','get_chat_stats','set_message_pinned','add_chat_member','rename_chat',
      'purge_expired_messages','minichat_realtime_topic_is_member','can_access_shared_item',
      'can_vote_shared_item','set_shared_item_done','touch_device_session','list_user_devices',
      'revoke_user_device','acknowledge_messages','play_shared_game','set_watch_state','search_messages_in_chat'
    ) loop
    execute format('revoke all on function %s from public, anon',fn.signature);
    execute format('grant execute on function %s to authenticated',fn.signature);
  end loop;
end $$;
revoke all on function public.enforce_message_insert_rate_limit() from public,anon,authenticated;
commit;
