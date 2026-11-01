import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite();
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',outsider='33333333-3333-4333-8333-333333333333';
const chat='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const msg='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function asUser(user,sql,params=[]) {
  return db.transaction(async tx=>{
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    await tx.exec('set local role authenticated');
    return tx.query(sql,params);
  });
}
async function createGame(kind='tictactoe') {
  const result=await asUser(a,"insert into public.shared_items(chat_id,created_by,item_type,title) values($1,$2,$3,'Игра') returning id",[chat,a,kind]);
  return result.rows[0].id;
}
async function game(id) { return (await asUser(a,'select payload from public.shared_items where id=$1',[id])).rows[0].payload; }
await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../../supabase/bootstrap-dev.sql',import.meta.url),'utf8'));
const migrationDir=new URL('../../supabase/migrations/',import.meta.url);
for(const name of (await readdir(migrationDir)).filter(name=>name.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name,migrationDir),'utf8'));
await db.query('insert into auth.users(id,email) values($1,\'a@example.test\'),($2,\'b@example.test\'),($3,\'c@example.test\')',[a,b,outsider]);
await db.query('insert into public.chats(id) values($1)',[chat]);
await db.query("insert into public.chat_members(chat_id,user_id,role) values($1,$2,'owner'),($1,$3,'member')",[chat,a,b]);
await db.query("insert into public.messages(id,chat_id,sender_id,content) values($1,$2,$3,'Привет')",[msg,chat,a]);

test('receipts: sender cannot forge delivery; outsider cannot read or acknowledge',async()=>{
  await asUser(a,'select public.acknowledge_messages(array[$1]::uuid[],false)',[msg]);
  assert.equal((await asUser(a,'select * from public.message_receipts')).rows.length,0);
  await asUser(outsider,'select public.acknowledge_messages(array[$1]::uuid[],true)',[msg]);
  assert.equal((await asUser(outsider,'select * from public.message_receipts')).rows.length,0);
  await assert.rejects(asUser(outsider,'insert into public.message_receipts(message_id,user_id) values($1,$2)',[msg,outsider]),/row-level security/);
});
test('receipts: delivered then read, stable timestamps and unread counts',async()=>{
  assert.equal(Number((await asUser(b,'select unread_count from public.get_chat_summaries()')).rows[0].unread_count),1);
  await asUser(b,'select public.acknowledge_messages(array[$1]::uuid[],false)',[msg]);
  const delivered=(await asUser(a,'select * from public.message_receipts')).rows[0];
  assert.ok(delivered.delivered_at); assert.equal(delivered.read_at,null);
  await asUser(b,'select public.acknowledge_messages(array[$1]::uuid[],true)',[msg]);
  const read=(await asUser(a,'select * from public.message_receipts')).rows[0];
  assert.ok(read.read_at); assert.deepEqual(read.delivered_at,delivered.delivered_at);
  await asUser(b,'select public.acknowledge_messages(array[$1]::uuid[],false)',[msg]);
  assert.deepEqual((await asUser(a,'select * from public.message_receipts')).rows[0],read);
  assert.equal(Number((await asUser(b,'select unread_count from public.get_chat_summaries()')).rows[0].unread_count),0);
});
test('receipt cannot be moved to another identity or forged with an earlier timestamp',async()=>{
  await assert.rejects(asUser(b,'update public.message_receipts set user_id=$1 where message_id=$2',[a,msg]),/immutable/);
  const before=(await asUser(a,'select * from public.message_receipts')).rows[0];
  await asUser(b,"update public.message_receipts set read_at='2000-01-01',delivered_at='2000-01-01' where message_id=$1",[msg]);
  assert.deepEqual((await asUser(a,'select * from public.message_receipts')).rows[0],before);
});
test('tic-tac-toe: alternates turns, rejects stale or occupied moves, detects winner',async()=>{
  const id=await createGame();
  await assert.rejects(asUser(b,'select public.play_shared_game($1,\'0\',0)',[id]),/your turn/);
  await asUser(a,'select public.play_shared_game($1,\'0\',0)',[id]);
  await assert.rejects(asUser(b,'select public.play_shared_game($1,\'1\',0)',[id]),/Game changed/);
  await assert.rejects(asUser(b,'select public.play_shared_game($1,\'0\',1)',[id]),/occupied/);
  await asUser(b,'select public.play_shared_game($1,\'3\',1)',[id]);
  await asUser(a,'select public.play_shared_game($1,\'1\',2)',[id]);
  await asUser(b,'select public.play_shared_game($1,\'4\',3)',[id]);
  await asUser(a,'select public.play_shared_game($1,\'2\',4)',[id]);
  assert.equal((await game(id)).winner,'X');
  await assert.rejects(asUser(b,'select public.play_shared_game($1,\'8\',5)',[id]),/finished/);
});
test('game: outsiders and direct edits cannot change game state',async()=>{
  const id=await createGame();
  await assert.rejects(asUser(outsider,'select public.play_shared_game($1,\'0\',0)',[id]),/Membership/);
  assert.equal((await asUser(outsider,'select * from public.shared_items where id=$1',[id])).rows.length,0);
  await assert.rejects(asUser(a,"update public.shared_items set payload='{}' where id=$1",[id]),/activity action/);
  await assert.rejects(asUser(a,'select public.play_shared_game($1,\'0\',null)',[id]),/Invalid/);
});
test('hangman: secret is inaccessible, mask only reveals guessed letters, duplicates rejected',async()=>{
  const id=await createGame('hangman');
  const state=await game(id);
  assert.match(state.mask,/^•+$/);
  assert.equal(state.word,undefined);
  await assert.rejects(asUser(a,'select * from minichat_private.hangman_words'),/permission denied/);
  await asUser(a,'select public.play_shared_game($1,\'А\',0)',[id]);
  const after=await game(id);
  assert.match(after.mask,/^[•А]+$/); assert.deepEqual(after.guesses,['А']);
  await assert.rejects(asUser(b,'select public.play_shared_game($1,\'А\',1)',[id]),/already tried/);
});
test('watch state: only members can control it, validates values and video IDs',async()=>{
  await assert.rejects(asUser(a,"insert into public.shared_items(chat_id,created_by,item_type,title,payload) values($1,$2,'youtube','x','{}')",[chat,a]),/Invalid YouTube/);
  const id=(await asUser(a,"insert into public.shared_items(chat_id,created_by,item_type,title,payload) values($1,$2,'youtube','x','{\"video_id\":\"dQw4w9WgXcQ\"}') returning id",[chat,a])).rows[0].id;
  await asUser(b,'select public.set_watch_state($1,true,42)',[id]);
  const state=await game(id); assert.equal(state.position,42); assert.equal(state.playing,true); assert.ok(state.changed_at);
  await assert.rejects(asUser(outsider,'select public.set_watch_state($1,false,0)',[id]),/Membership/);
  await assert.rejects(asUser(b,'select public.set_watch_state($1,true,-1)',[id]),/Invalid/);
});
test('notes: both members can edit, cannot move note to another chat',async()=>{
  const id=(await asUser(a,"insert into public.shared_items(chat_id,created_by,item_type,title) values($1,$2,'note','Заметка') returning id",[chat,a])).rows[0].id;
  await asUser(b,"update public.shared_items set body='Общий текст' where id=$1",[id]);
  assert.equal((await asUser(a,'select body from public.shared_items where id=$1',[id])).rows[0].body,'Общий текст');
  await assert.rejects(asUser(a,'update public.shared_items set created_by=$1 where id=$2',[b,id]),/immutable/);
});
test('expired rows are hidden by RLS, including from raw API reads',async()=>{
  await db.query("insert into public.messages(chat_id,sender_id,content,expires_at) values($1,$2,'Expired',now()-interval '1 second')",[chat,a]);
  const rows=(await asUser(b,"select * from public.messages where content='Expired'")).rows;
  assert.equal(rows.length,0);
});
test('full-history search is scoped to membership and matches a partial word',async()=>{
  const result=await asUser(b,"select content from public.search_messages_in_chat($1,'Прив')",[chat]);
  assert.deepEqual(result.rows,[{content:'Привет'}]);
  assert.equal((await asUser(outsider,"select * from public.search_messages_in_chat($1,'Прив')",[chat])).rows.length,0);
  assert.equal((await asUser(b,"select * from public.search_messages_in_chat($1,'П')",[chat])).rows.length,0);
});
test.after(()=>db.close());
