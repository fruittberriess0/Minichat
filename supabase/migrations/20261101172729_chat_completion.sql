-- Apply after migrations 001..006. Adds receipts and persistent two-person activities.
begin;
create schema if not exists minichat_private;
revoke all on schema minichat_private from public, anon;
grant usage on schema minichat_private to authenticated;

create index if not exists messages_chat_created_id_idx on public.messages(chat_id,created_at desc,id desc);

create table public.message_receipts (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  read_at timestamptz,
  primary key(message_id,user_id)
);
create index message_receipts_user_idx on public.message_receipts(user_id,message_id);
alter table public.message_receipts enable row level security;
grant select,insert,update on public.message_receipts to authenticated;
create policy receipts_member_read on public.message_receipts for select to authenticated
  using(public.can_access_message(message_id));
create policy receipts_recipient_insert on public.message_receipts for insert to authenticated
  with check(user_id=(select auth.uid()) and exists(
    select 1 from public.messages m where m.id=message_id and m.sender_id<>auth.uid()
    and m.deleted_at is null and (m.expires_at is null or m.expires_at>now())
  ));
create policy receipts_recipient_update on public.message_receipts for update to authenticated
  using(user_id=(select auth.uid()) and public.can_access_message(message_id))
  with check(user_id=(select auth.uid()) and public.can_access_message(message_id));
create function minichat_private.guard_receipt() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='UPDATE' and (new.message_id<>old.message_id or new.user_id<>old.user_id) then
    raise exception 'Receipt identity is immutable';
  end if;
  if tg_op='INSERT' then new.delivered_at:=now();
  else new.delivered_at:=old.delivered_at; end if;
  if tg_op='UPDATE' and old.read_at is not null then new.read_at:=old.read_at;
  elsif new.read_at is not null then new.read_at:=now(); end if;
  return new;
end $$;
create trigger guard_message_receipt before insert or update on public.message_receipts
for each row execute function minichat_private.guard_receipt();

create function public.acknowledge_messages(p_ids uuid[],p_read boolean default false)
returns void language sql security invoker set search_path='' as $$
  insert into public.message_receipts(message_id,user_id,read_at)
  select m.id,auth.uid(),case when p_read then now() else null end
  from public.messages m where m.id=any(p_ids[1:200]) and m.sender_id<>auth.uid()
    and m.deleted_at is null and (m.expires_at is null or m.expires_at>now())
    and public.is_chat_member(m.chat_id)
  on conflict(message_id,user_id) do update
  set read_at=coalesce(public.message_receipts.read_at,excluded.read_at)
  where public.message_receipts.read_at is null and excluded.read_at is not null;
$$;
revoke all on function public.acknowledge_messages(uuid[],boolean) from public,anon;
grant execute on function public.acknowledge_messages(uuid[],boolean) to authenticated;

alter table public.shared_items drop constraint if exists shared_items_item_type_check;
alter table public.shared_items add constraint shared_items_item_type_check check
(item_type in ('task','note','event','anniversary','poll','location','countdown','youtube','tictactoe','hangman'));
grant select,insert,update,delete on public.shared_items to authenticated;
grant select,insert,update,delete on public.shared_item_votes to authenticated;
create policy shared_notes_member_update on public.shared_items for update to authenticated
  using(item_type='note' and public.is_chat_member(chat_id))
  with check(item_type='note' and public.is_chat_member(chat_id));
-- Secrets are outside the exposed public schema and have no browser grants.
create table minichat_private.hangman_words (
  item_id uuid primary key references public.shared_items(id) on delete cascade,
  word text not null
);
revoke all on minichat_private.hangman_words from public,anon,authenticated;
alter table minichat_private.hangman_words enable row level security;

create function minichat_private.prepare_shared_item() returns trigger
language plpgsql security definer set search_path='' as $$
declare peer uuid; n integer; word text;
begin
  if auth.uid() is null or new.created_by<>auth.uid() or not public.is_chat_member(new.chat_id) then
    raise exception 'Membership required' using errcode='42501';
  end if;
  if new.item_type in ('tictactoe','hangman') then
    select count(*) into n from public.chat_members where chat_id=new.chat_id;
    if n<>2 then raise exception 'Games require exactly two members'; end if;
    select user_id into peer from public.chat_members where chat_id=new.chat_id and user_id<>auth.uid();
    if new.item_type='tictactoe' then
      new.payload:=jsonb_build_object('players',jsonb_build_array(auth.uid(),peer),
        'board',jsonb_build_array('','','','','','','','',''),'turn',0,'winner',null,'version',0);
    else
      -- Store the word in a private table after the row is inserted.
      new.payload:=jsonb_build_object('players',jsonb_build_array(auth.uid(),peer),
        'guesses','[]'::jsonb,'turn',0,'mistakes',0,'status','playing','version',0);
    end if;
  elsif new.item_type='youtube' then
    if coalesce(new.payload->>'video_id','') !~ '^[A-Za-z0-9_-]{11}$' then raise exception 'Invalid YouTube video'; end if;
    new.payload:=jsonb_build_object('video_id',new.payload->>'video_id','playing',false,'position',0,'changed_at',now());
  elsif new.item_type='countdown' and new.due_at is null then
    raise exception 'Countdown requires a date';
  end if;
  return new;
end $$;
create trigger prepare_shared_item before insert on public.shared_items
for each row execute function minichat_private.prepare_shared_item();

create function minichat_private.prepare_hangman() returns trigger
language plpgsql security definer set search_path='' as $$
declare word text;
begin
  if new.item_type='hangman' then
    word:=(array['РАДУГА','ПЛАНЕТА','УЛЫБКА','КОМЕТА','МУЗЫКА','ПОДАРОК','ПРИВЕТ','СОЛНЦЕ','КОШКА','ЗВЕЗДА'])[1+floor(random()*10)::integer];
    insert into minichat_private.hangman_words values(new.id,word);
    update public.shared_items set payload=payload||jsonb_build_object('mask',repeat('•',length(word))) where id=new.id;
  end if;
  return new;
end $$;
create trigger prepare_hangman after insert on public.shared_items
for each row execute function minichat_private.prepare_hangman();

-- Direct browser updates cannot rewrite a game, move an item to another chat,
-- change its author or forge synchronized playback. RPCs below own those changes.
create function minichat_private.guard_shared_item() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.id<>old.id or new.chat_id<>old.chat_id or new.created_by<>old.created_by or new.item_type<>old.item_type then
    raise exception 'Item identity is immutable';
  end if;
  if current_user in ('authenticated','anon') and old.item_type in ('tictactoe','hangman','youtube') then
    raise exception 'Use the activity action' using errcode='42501';
  end if;
  new.updated_at:=now();
  return new;
end $$;
create trigger guard_shared_item before update on public.shared_items
for each row execute function minichat_private.guard_shared_item();

create function minichat_private.play_shared_game(p_item_id uuid,p_move text,p_version integer)
returns void language plpgsql security definer set search_path='' as $$
declare item public.shared_items; state jsonb; players jsonb; board jsonb; turn integer;
cell integer; mark text; winner text; word text; mask text:=''; guesses jsonb; mistakes integer;
letter text; line integer[]; i integer; j integer;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_move is null or p_version is null then raise exception 'Invalid move or version'; end if;
  select * into item from public.shared_items where id=p_item_id for update;
  if not found or not public.is_chat_member(item.chat_id) then raise exception 'Membership required' using errcode='42501'; end if;
  if item.item_type not in ('tictactoe','hangman') then raise exception 'Not a game'; end if;
  state:=item.payload; players:=state->'players'; turn:=(state->>'turn')::integer;
  if players->>turn<>auth.uid()::text then raise exception 'Wait for your turn'; end if;
  if (state->>'version')::integer<>p_version then raise exception 'Game changed; refresh and try again'; end if;
  -- Membership may have changed since the game was created.
  if (select count(*) from public.chat_members where chat_id=item.chat_id)<>2 or
    not exists(select 1 from public.chat_members where chat_id=item.chat_id and user_id=(players->>0)::uuid) or
    not exists(select 1 from public.chat_members where chat_id=item.chat_id and user_id=(players->>1)::uuid) then
    raise exception 'Start a new game with the current two members';
  end if;
  if item.item_type='tictactoe' then
    if state->>'winner' is not null then raise exception 'Game has finished'; end if;
    if p_move !~ '^[0-8]$' then raise exception 'Invalid cell'; end if;
    cell:=p_move::integer; board:=state->'board';
    if board->>cell<>'' then raise exception 'Cell is occupied'; end if;
    mark:=case when turn=0 then 'X' else 'O' end;
    board:=jsonb_set(board,array[cell::text],to_jsonb(mark));
    foreach line slice 1 in array array[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]] loop
      if board->>line[1]=mark and board->>line[2]=mark and board->>line[3]=mark then winner:=mark; end if;
    end loop;
    if winner is null and not exists(select 1 from jsonb_array_elements_text(board) b(value) where value='') then winner:='draw'; end if;
    state:=state||jsonb_build_object('board',board,'turn',1-turn,'winner',winner);
  else
    if state->>'status'<>'playing' then raise exception 'Game has finished'; end if;
    letter:=upper(p_move);
    if letter !~ '^[А-ЯЁ]$' then raise exception 'Choose a Russian letter'; end if;
    guesses:=state->'guesses';
    if guesses ? letter then raise exception 'Letter already tried'; end if;
    guesses:=guesses||jsonb_build_array(letter);
    select h.word into word from minichat_private.hangman_words h where h.item_id=p_item_id;
    if word is null then raise exception 'Game word unavailable'; end if;
    mistakes:=(state->>'mistakes')::integer+case when position(letter in word)=0 then 1 else 0 end;
    for i in 1..length(word) loop
      mask:=mask||case when guesses ? substr(word,i,1) then substr(word,i,1) else '•' end;
    end loop;
    state:=state||jsonb_build_object('guesses',guesses,'mask',case when mistakes>=6 then word else mask end,
      'mistakes',mistakes,'turn',1-turn,'status',case when mistakes>=6 then 'lost' when position('•' in mask)=0 then 'won' else 'playing' end);
  end if;
  update public.shared_items set payload=state||jsonb_build_object('version',p_version+1) where id=p_item_id;
end $$;
revoke all on function minichat_private.play_shared_game(uuid,text,integer) from public,anon;
grant execute on function minichat_private.play_shared_game(uuid,text,integer) to authenticated;
create function public.play_shared_game(p_item_id uuid,p_move text,p_version integer)
returns void language sql security invoker set search_path='' as $$
  select minichat_private.play_shared_game(p_item_id,p_move,p_version);
$$;
revoke all on function public.play_shared_game(uuid,text,integer) from public,anon;
grant execute on function public.play_shared_game(uuid,text,integer) to authenticated;

create function minichat_private.set_watch_state(p_item_id uuid,p_playing boolean,p_position double precision)
returns void language plpgsql security definer set search_path='' as $$
declare item public.shared_items;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_playing is null or p_position is null or p_position<0 or p_position>604800 or p_position='NaN'::float8 then
    raise exception 'Invalid playback state';
  end if;
  select * into item from public.shared_items where id=p_item_id for update;
  if not found or item.item_type<>'youtube' or not public.is_chat_member(item.chat_id) then
    raise exception 'Membership required' using errcode='42501';
  end if;
  update public.shared_items set payload=payload||jsonb_build_object('playing',p_playing,'position',p_position,'changed_at',now()) where id=p_item_id;
end $$;
revoke all on function minichat_private.set_watch_state(uuid,boolean,double precision) from public,anon;
grant execute on function minichat_private.set_watch_state(uuid,boolean,double precision) to authenticated;
create function public.set_watch_state(p_item_id uuid,p_playing boolean,p_position double precision)
returns void language sql security invoker set search_path='' as $$
  select minichat_private.set_watch_state(p_item_id,p_playing,p_position);
$$;
revoke all on function public.set_watch_state(uuid,boolean,double precision) from public,anon;
grant execute on function public.set_watch_state(uuid,boolean,double precision) to authenticated;


alter table public.chat_preferences drop constraint if exists chat_preferences_message_expiry_seconds_check;
alter table public.chat_preferences add constraint chat_preferences_message_expiry_seconds_check
  check(message_expiry_seconds in (0,300,3600,86400,604800));
create policy messages_guard_unexpired on public.messages as restrictive for select to authenticated
  using(expires_at is null or expires_at>now());

create or replace function public.get_chat_summaries()
returns table(chat_id uuid,latest_id uuid,latest_sender_id uuid,latest_content text,
  latest_created_at timestamptz,latest_message_type text,latest_file_name text,unread_count bigint)
language sql stable security invoker set search_path='' as $$
  select cm.chat_id,latest.id,latest.sender_id,latest.content,latest.created_at,latest.message_type,latest.file_name,
    (select count(*) from public.messages m where m.chat_id=cm.chat_id and m.sender_id<>auth.uid()
      and m.deleted_at is null and (m.expires_at is null or m.expires_at>now())
      and m.read_at is null and not exists(select 1 from public.message_receipts r
        where r.message_id=m.id and r.user_id=auth.uid() and r.read_at is not null))
  from public.chat_members cm left join lateral (
    select m.* from public.messages m where m.chat_id=cm.chat_id and m.deleted_at is null
      and (m.expires_at is null or m.expires_at>now()) order by m.created_at desc,m.id desc limit 1
  ) latest on true where cm.user_id=auth.uid();
$$;
revoke all on function public.get_chat_summaries() from public,anon;
grant execute on function public.get_chat_summaries() to authenticated;

create function public.search_messages_in_chat(p_chat uuid,p_query text)
returns setof public.messages language sql stable security invoker set search_path='' as $$
  select m.* from public.messages m where m.chat_id=p_chat and public.is_chat_member(p_chat)
    and length(trim(p_query)) between 2 and 200 and m.deleted_at is null
    and (m.expires_at is null or m.expires_at>now())
    and position(lower(trim(p_query)) in lower(coalesce(m.content,'')))>0
  order by m.created_at,m.id limit 100;
$$;
revoke all on function public.search_messages_in_chat(uuid,text) from public,anon;
grant execute on function public.search_messages_in_chat(uuid,text) to authenticated;

-- pg_cron is optional. Install it in the Supabase project before applying this
-- migration to physically purge expired rows even while both clients are closed.
create function minichat_private.purge_expired() returns void
language sql security definer set search_path='' as $$
  delete from public.messages where expires_at<=now();
$$;
revoke all on function minichat_private.purge_expired() from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('minichat-expiry','* * * * *','select minichat_private.purge_expired()');
  end if;
end $$;

-- Close anonymous grants left by the original hand-configured installation.
do $$ begin
  if to_regprocedure('public.mark_chat_read(uuid)') is not null then
    revoke all on function public.mark_chat_read(uuid) from public,anon;
  end if;
  if to_regprocedure('public.toggle_pin_message(uuid)') is not null then
    revoke all on function public.toggle_pin_message(uuid) from public,anon;
  end if;
end $$;

-- New tables need explicit publication membership for postgres_changes.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='messages') then
      alter publication supabase_realtime add table public.messages;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='message_reactions') then
      alter publication supabase_realtime add table public.message_reactions;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='message_receipts') then
      alter publication supabase_realtime add table public.message_receipts;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='shared_items') then
      alter publication supabase_realtime add table public.shared_items;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='shared_item_votes') then
      alter publication supabase_realtime add table public.shared_item_votes;
    end if;
  end if;
end $$;
revoke all on function minichat_private.guard_receipt() from public,anon,authenticated;
revoke all on function minichat_private.prepare_shared_item() from public,anon,authenticated;
revoke all on function minichat_private.prepare_hangman() from public,anon,authenticated;
revoke all on function minichat_private.guard_shared_item() from public,anon,authenticated;
commit;
