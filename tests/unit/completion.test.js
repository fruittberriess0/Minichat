import {test,expect} from 'vitest';
import {createOutbox,insertOnce,mergePending} from '../../src/features/outbox.js';
import {messageStatus} from '../../src/features/receipts.js';
import {youtubeId,countdownLabel} from '../../src/features/together-utils.js';
import {readChatHistory} from '../../src/features/export.js';
function storage() { const map=new Map(); return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)}; }
function pending(id='one') {return {id:'local-'+id,sender_id:'a',chat_id:'chat',created_at:'2026-11-01T12:00:00Z',content:'Текст',__pending:true,__payload:{id,sender_id:'a',chat_id:'chat',content:'Текст'}};}
test('outbox survives reload and is scoped to the signed-in account',()=>{
  const disk=storage(),box=createOutbox(disk,'a'); box.put(pending());
  const reloaded=createOutbox(disk,'a'); expect(reloaded.list()).toHaveLength(1); expect(reloaded.list()[0].__failed).toBe(true);
  expect(createOutbox(disk,'b').list()).toEqual([]);
  expect(()=>box.put({...pending(),sender_id:'b'})).toThrow();
  reloaded.remove('local-one'); expect(reloaded.list()).toEqual([]);
});
test('outbox storage failures surface before the composer is cleared',()=>{
  const box=createOutbox({getItem:()=>null,setItem:()=>{throw new Error('quota');}},'a');
  expect(()=>box.put(pending())).toThrow('quota');
});
test('retry after an uncertain response reconciles the existing server UUID',async()=>{
  let inserted=0; const row=pending().__payload;
  const query={select(){return this;},eq(){return this;},async single(){return {data:row,error:null};}};
  const sb={from(){return {insert(){inserted++;return {select(){return {single:async()=>({error:{code:'23505'}})};}};},select(){return query;}};}};
  expect(await insertOnce(sb,row)).toEqual(row); expect(inserted).toBe(1);
  expect(mergePending([row],[pending()],'chat')).toEqual([row]);
});
test('delivery requires another recipient, sent and read are different states',()=>{
  const row={id:'m',sender_id:'a'};
  expect(messageStatus(row).state).toBe('sent');
  expect(messageStatus(row,[{message_id:'m',user_id:'a',read_at:'now'}]).state).toBe('sent');
  expect(messageStatus(row,[{message_id:'m',user_id:'b',delivered_at:'now'}]).state).toBe('delivered');
  expect(messageStatus(row,[{message_id:'m',user_id:'b',delivered_at:'now',read_at:'now'}]).state).toBe('read');
});
test('YouTube links accept watch/shorts/share URLs and reject forged hosts and protocols',()=>{
  for(const url of ['https://youtu.be/dQw4w9WgXcQ?t=42','https://www.youtube.com/watch?v=dQw4w9WgXcQ','https://youtube.com/shorts/dQw4w9WgXcQ']) expect(youtubeId(url)).toBe('dQw4w9WgXcQ');
  for(const url of ['https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ','javascript:alert(1)','http://youtu.be/dQw4w9WgXcQ','https://youtu.be/bad']) expect(youtubeId(url)).toBeNull();
});
test('countdown reaches zero without negative durations',()=>{
  expect(countdownLabel('2026-11-02T00:00:00Z',Date.parse('2026-11-01T00:00:00Z'))).toBe('1 дн. 00:00:00');
  expect(countdownLabel('2026-11-01T00:00:00Z',Date.parse('2026-11-02T00:00:00Z'))).toContain('наступило');
});
test('export paginates past 500 rows with a stable keyset, excludes expired rows and fails atomically',async()=>{
  const rows=Array.from({length:551},(_,i)=>({id:String(i).padStart(6,'0'),created_at:'2026-10-31T12:00:00Z',content:'m'+i,...(i===550?{expires_at:'2026-10-31T13:00:00Z'}:{})}));
  let calls=0,cursorUsed=false;
  const sb={from(){const q={select(){return this;},eq(){return this;},is(){return this;},lte(){return this;},order(){return this;},or(value){cursorUsed=value.includes('id.gt.000499');return this;},limit(){return this;},then(resolve){return Promise.resolve({data:calls++===0?rows.slice(0,500):rows.slice(500)}).then(resolve);}};return q;}};
  const exported=await readChatHistory(sb,'chat','2026-11-01T00:00:00Z');
  expect(exported).toHaveLength(550); expect(cursorUsed).toBe(true); expect(calls).toBe(2);
});
