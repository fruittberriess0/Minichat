import {test,expect} from '@playwright/test';
const user='11111111-1111-4111-8111-111111111111',peer='22222222-2222-4222-8222-222222222222';
const chat='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seed={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',chat_id:chat,sender_id:peer,content:'Привет <img src=x onerror=alert(1)>',message_type:'text',created_at:'2026-11-01T12:00:00Z'};
async function fixture(page) {
  const rows=[{...seed}],shared=[],receipts=[];
  let rejectInsert=false,loseResponse=false,insertAttempts=0;
  const token='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'+Buffer.from(JSON.stringify({sub:user,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.test-signature';
  await page.addInitScript(({token,user})=>{
    localStorage.setItem('sb-minichat-dev-auth-token',JSON.stringify({access_token:token,refresh_token:'test-refresh',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user:{id:user,email:'a@example.test',aud:'authenticated',role:'authenticated'}}));
  },{token,user});
  await page.route('https://minichat-dev.invalid/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    const body=request.postDataJSON?.() || {};
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET, POST, PATCH, DELETE, OPTIONS','content-type':'application/json'};
    const respond=(data,status=200)=>route.fulfill({status,headers,body:JSON.stringify(data)});
    if(method==='OPTIONS') return respond({});
    if(path.includes('/auth/')) return respond({id:user,email:'a@example.test'});
    if(path.endsWith('/rpc/get_chat_summaries')) {
      const latest=rows.at(-1);
      return respond([{chat_id:chat,latest_id:latest.id,latest_sender_id:latest.sender_id,latest_content:latest.content,latest_created_at:latest.created_at,latest_message_type:'text',unread_count:0}]);
    }
    if(path.endsWith('/rpc/acknowledge_messages')) {
      for(const id of body.p_ids) { if(!receipts.some(r=>r.message_id===id)) receipts.push({message_id:id,user_id:user,delivered_at:new Date().toISOString(),read_at:body.p_read?new Date().toISOString():null}); }
      return respond(null);
    }
    if(path.endsWith('/rpc/touch_device_session')) return respond(true);
    if(path.includes('/rpc/')) return respond(null);
    const table=path.split('/').at(-1);
    if(table==='messages' && method==='POST') {
      insertAttempts++;
      if(rejectInsert) return respond({message:'Network unavailable',code:'TEMP'},503);
      if(rows.some(row=>row.id===body.id)) return respond({code:'23505',message:'duplicate'},409);
      const row={...body,created_at:new Date().toISOString()}; rows.push(row);
      if(loseResponse) {loseResponse=false;return route.abort('failed');}
      return respond(row);
    }
    if(table==='messages' && method==='PATCH') {
      const id=url.searchParams.get('id')?.replace('eq.',''); Object.assign(rows.find(row=>row.id===id)||{},body); return respond(null);
    }
    if(table==='shared_items' && method==='POST') {
      shared.unshift({...body,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',created_at:new Date().toISOString()}); return respond(null);
    }
    if(method==='POST' || method==='PATCH' || method==='DELETE') return respond(null);
    let data=[];
    if(table==='profiles') data=[{id:user,username:'Тимур'},{id:peer,username:'Собеседник'}];
    if(table==='chat_members') data=[{chat_id:chat,user_id:user,role:'owner'},{chat_id:chat,user_id:peer,role:'member'}];
    if(table==='chats') data=[{id:chat,title:'Наш чат',is_group:false,created_at:seed.created_at}];
    if(table==='messages') data=[...rows].reverse().filter(row=>url.searchParams.get('is_pinned')!=='eq.true' || row.is_pinned);
    if(table==='message_receipts') data=receipts;
    if(table==='chat_preferences') data=[{user_id:user,chat_id:chat,muted:false,wallpaper:'dots',message_expiry_seconds:0,e2ee_enabled:false}];
    if(table==='shared_items') data=shared;
    const id=url.searchParams.get('id'); if(id?.startsWith('eq.')) data=data.filter(row=>row.id===id.slice(3));
    if(request.headers().accept?.includes('vnd.pgrst.object')) return respond(data[0]||null);
    return respond(data);
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('.chat-item').first().click();
  await expect(page.locator('#messages')).toContainText('Привет');
  return {rows,shared,receipts,setReject(value){rejectInsert=value;},loseNextResponse(){loseResponse=true;},get attempts(){return insertAttempts;}};
}

test('chat renders text safely, sends a message, edits via ↑ and replies',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const mock=await fixture(page);
  await expect(page.locator('#messages img')).toHaveCount(0);
  await page.locator('#messageInput').fill('Новый текст'); await page.locator('#sendButton').click();
  await expect(page.locator('[data-status="sent"]')).toBeVisible();
  await page.locator('#messageInput').press('ArrowUp');
  const editor=page.getByRole('textbox',{name:'Редактирование сообщения'});
  await expect(editor).toBeVisible(); await editor.fill('Изменено'); await editor.press('Control+Enter');
  await expect(page.locator('#messages')).toContainText('Изменено');
  await page.getByTitle('Ответить').first().click();
  await expect(page.locator('#replyBar')).toBeVisible();
  await page.locator('#messageInput').press('Escape'); await expect(page.locator('#replyBar')).toBeHidden();
  expect(mock.rows).toHaveLength(2); expect(errors).toEqual([]);
});
test('failed send survives reload and retry reconciles an accepted INSERT without duplicates',async({page})=>{
  const mock=await fixture(page); mock.setReject(true);
  await page.locator('#messageInput').fill('Не потерять'); await page.locator('#sendButton').click();
  await expect(page.locator('[data-status="failed"]')).toBeVisible();
  await page.reload(); await page.locator('.chat-item').first().click();
  await expect(page.locator('#messages')).toContainText('Не потерять');
  mock.setReject(false); mock.loseNextResponse();
  await page.getByTitle('Повторить отправку').click();
  await expect(page.locator('[data-status="failed"]')).toBeVisible();
  await page.getByTitle('Повторить отправку').click();
  await expect(page.locator('[data-status="sent"]')).toBeVisible();
  await expect(page.locator('[data-status="failed"]')).toHaveCount(0);
  expect(mock.rows.filter(row=>row.content==='Не потерять')).toHaveLength(1);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('minichat-outbox-v1:'+ '11111111-1111-4111-8111-111111111111')))).toEqual([]);
});
test('phone: shared note and countdown can be created, no horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const mock=await fixture(page);
  await page.screenshot({path:'work/mobile-chat.png'});
  await page.locator('#sharedSpaceButton').click();
  await expect(page.locator('#sharedSpacePanel')).toBeVisible();
  await page.locator('#sharedItemType').selectOption('note');
  await page.locator('#sharedItemTitle').fill('Наш план'); await page.locator('#sharedItemBody').fill('Встретиться в 19:00');
  await page.locator('#sharedItemForm button[type=submit]').click();
  await expect(page.locator('#sharedSpaceList')).toContainText('Встретиться в 19:00');
  await page.locator('#sharedItemType').selectOption('countdown'); await page.locator('#sharedItemTitle').fill('До встречи');
  await page.locator('#sharedItemDue').fill('2027-01-01T19:00'); await page.locator('#sharedItemForm button[type=submit]').click();
  await expect(page.locator('.shared-countdown')).toContainText('дн.');
  const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  await page.screenshot({path:'work/mobile-shared-space.png'});
  expect(mock.shared).toHaveLength(2); expect(errors).toEqual([]);
});
