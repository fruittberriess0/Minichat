import { test, expect } from "@playwright/test";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const M = "20000000-0000-4000-8000-000000000001";
const profiles = [{id:USER,username:"Тестовый пользователь"},{id:OTHER,username:"Друг"}];
const chats = [{id:A,title:"Наши планы",created_at:"2026-10-25T10:00:00Z"},{id:B,title:"Друзья",is_group:true,created_at:"2026-10-24T10:00:00Z"}];
const original = {id:M,chat_id:A,sender_id:OTHER,content:"Встречаемся завтра ❤️",created_at:"2026-10-25T10:01:00Z",message_type:"text"};

async function mockAccount(page, options = {}) {
  const errors = [];
  const writes = [];
  page.on("pageerror",error => errors.push(error.message));
  await page.addInitScript(({USER}) => {
    localStorage.setItem("sb-127-auth-token",JSON.stringify({access_token:"test-access-token",refresh_token:"test-refresh-token",expires_at:Math.floor(Date.now()/1000)+3600,user:{id:USER,email:"test@example.invalid",aud:"authenticated",role:"authenticated"}}));
  },{USER});
  await page.route("http://127.0.0.1:54321/**",async route => {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.split("/").pop();
    const method = req.method();
    let data = [];
    let status = 200;
    if (method === "OPTIONS") return route.fulfill({status:204,headers:{"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"GET,POST,PATCH,DELETE,OPTIONS"}});
    if (table === "profiles") data = method === "PATCH" ? null : url.searchParams.get("id")?.startsWith("eq.") ? profiles[0] : profiles;
    else if (table === "chat_members") data = url.searchParams.has("user_id") ? chats.map(chat => ({chat_id:chat.id})) : profiles.map(profile => ({user_id:profile.id,role:profile.id === USER ? (options.role || "owner") : "member"}));
    else if (table === "chats") data = chats;
    else if (table === "get_chat_summaries") data = chats.map(chat => ({chat_id:chat.id,latest_id:M,latest_content:chat.id === A ? original.content : "Привет",latest_sender_id:OTHER,latest_created_at:original.created_at,unread_count:chat.id === B ? 3 : 0}));
    else if (table === "chat_preferences") data = {muted:false,message_expiry_seconds:0,e2ee_enabled:Boolean(options.encryptedTarget && url.searchParams.get("chat_id") === "eq."+B)};
    else if (table === "messages") {
      if (method === "PATCH") {
        writes.push({method,...req.postDataJSON()});
        data = null;
      } else if (method === "POST") {
        const row = req.postDataJSON();
        writes.push(row);
        if (options.failSend || (options.uncertainSend && writes.length === 1)) {status = 503;data = {message:"Временно недоступно"};}
        else if (options.uncertainSend) {status = 409;data = {code:"23505",message:"Already inserted"};}
        else data = {...row,created_at:new Date().toISOString()};
      } else {
        const isB = url.searchParams.get("chat_id") === "eq." + B;
        if (!isB && options.delayA) await new Promise(resolve => setTimeout(resolve,options.delayA));
        data = isB ? [{...original,id:"other-message",chat_id:B,content:"Сообщение из группы"}] : (options.history || [original]);
        if (url.searchParams.has("sender_id")) data = {...writes[0],created_at:new Date().toISOString()};
      }
    } else if (table === "find_chat_user") data = [{user_id:OTHER,username:"Друг"}];
    else if (table === "create_chat_with_members") {writes.push(req.postDataJSON());data = A;}
    else if (table === "search_chat_messages") {
      const query = req.postDataJSON().p_query;
      if (query === "старый") await new Promise(resolve => setTimeout(resolve,350));
      data = [{...original,content:query === "<img>" ? '<img src=x onerror="alert(1)">' : query}];
    }
    else if (table === "saved_messages") data = [{message_id:M,created_at:original.created_at}];
    else if (["add_chat_member","rename_chat","remove_chat_member","update_chat_member_role"].includes(table)) {writes.push({rpc:table,...req.postDataJSON()});data = null;}
    else if (table === "touch_device_session") data = true;
    else if (table === "logout") data = {};
    return route.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(data)});
  });
  await page.goto("/");
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator(".chat-item")).toHaveCount(2);
  return {errors,writes};
}
async function openChat(page, title = "Наши планы") {
  await page.getByRole("button",{name:title,exact:true}).click();
  await expect(page.locator("#sendButton")).toBeEnabled();
}
async function openTools(page) { await page.locator("#chatActions > summary").click(); }

for (const width of [320,390,768,1280]) {
  test(`all chat and composer tools fit at ${width}px`,async ({page}) => {
    await page.setViewportSize({width,height:844});
    const {errors} = await mockAccount(page);
    await openChat(page,"Друзья");
    await openTools(page);
    const ids = ["favoriteChatButton","exportChatButton","callAudioButton","callVideoButton","sharedAlbumButton","sharedSpaceButton","groupManageButton","chatStatsButton","selectMessagesButton","chatRefreshButton"];
    for (const id of ids) {
      const button = page.locator("#"+id);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.locator("#chatActions > summary").click();
    await page.locator("#composerTools > summary").click();
    for (const id of ["emojiButton","stickerButton","formatToggleButton","attachmentButton","recordButton","videoNoteButton","messageExpirySelect"]) {
      const button = page.locator("#"+id);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      const box = await button.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await page.locator("#emojiButton").click();
    await page.locator("#emojiPicker button").first().click();
    await expect(page.locator("#messageInput")).toHaveValue("❤️");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("mobile profile opens from chat list and its last controls are reachable",async ({page}) => {
  await page.setViewportSize({width:320,height:568});
  await mockAccount(page);
  await page.locator("#profileButton").click();
  await expect(page.locator("#profilePanel")).toBeVisible();
  await page.locator("#signOutAllButton").scrollIntoViewIfNeeded();
  await expect(page.locator("#signOutAllButton")).toBeInViewport();
  await page.locator("#profileCancelButton").click();
  await expect(page.locator("#chatItems")).toBeVisible();
});

test("drafts survive navigation and favorites filter persists after reload",async ({page}) => {
  await mockAccount(page);
  await openChat(page);
  await page.locator("#messageInput").fill("Не потеряй этот черновик");
  await openChat(page,"Друзья");
  await page.locator("#messageInput").fill("Другой черновик");
  await openChat(page);
  await expect(page.locator("#messageInput")).toHaveValue("Не потеряй этот черновик");
  await openTools(page);
  await page.locator("#favoriteChatButton").click();
  await page.getByRole("button",{name:"Избранные",exact:true}).click();
  await expect(page.locator(".chat-item")).toHaveCount(1);
  await page.reload();
  await page.getByRole("button",{name:"Избранные",exact:true}).click();
  await expect(page.locator(".chat-item")).toHaveCount(1);
  await openChat(page);
  await expect(page.locator("#messageInput")).toHaveValue("Не потеряй этот черновик");
});

test("switching chats ignores an earlier slow history response",async ({page}) => {
  const {errors} = await mockAccount(page,{delayA:400});
  const staleResponse = page.waitForResponse(response => response.url().includes("/messages?") && new URL(response.url()).searchParams.get("chat_id") === "eq."+A);
  await page.getByRole("button",{name:"Наши планы",exact:true}).click();
  await page.getByRole("button",{name:"Друзья",exact:true}).click();
  await expect(page.locator("#messages")).toContainText("Сообщение из группы");
  await expect(page.locator("#sendButton")).toBeEnabled();
  await (await staleResponse).finished();
  await expect(page.locator("#messages")).toContainText("Сообщение из группы");
  await expect(page.locator("#messages")).not.toContainText(original.content);
  await expect(page.locator("#headerTitle")).toHaveText("Друзья");
  expect(errors).toEqual([]);
});

test("new group form resolves users and sends the existing RPC contract",async ({page}) => {
  const {writes} = await mockAccount(page);
  await page.locator("#newChatButton").click();
  await expect(page.getByRole("dialog",{name:"Новая переписка"})).toBeVisible();
  await page.locator("#createChatType").selectOption("group");
  await page.locator("#createChatName").fill("Команда");
  await page.locator("#createChatMembers").fill("friend@example.invalid");
  await page.locator("#createChatSubmit").click();
  await expect(page.locator("#createChatDialog")).not.toBeVisible();
  expect(writes).toContainEqual({p_title:"Команда",p_is_group:true,p_member_ids:[OTHER]});
});

test("search and saved messages use real dialogs, safe text and message navigation",async ({page}) => {
  const {errors} = await mockAccount(page);
  await page.locator("#globalSearchButton").click();
  await page.locator("#messageLibraryQuery").fill("<img>");
  await page.locator("#messageLibraryForm").getByRole("button",{name:"Найти",exact:true}).click();
  await expect(page.locator(".library-result")).toContainText('<img src=x onerror="alert(1)">');
  await expect(page.locator(".library-result img")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#globalSearchButton")).toBeFocused();
  await page.locator("#savedMessagesButton").click();
  await expect(page.locator(".library-result")).toContainText(original.content);
  await page.locator(".library-result").click();
  await expect(page.locator("#messages .message-highlight")).toContainText(original.content);
  expect(errors).toEqual([]);
});

test("offline send retains the draft and makes no message write",async ({page,context}) => {
  const {writes} = await mockAccount(page);
  await openChat(page);
  await page.locator("#messageInput").fill("Отправлю позже");
  await context.setOffline(true);
  await expect(page.locator("#connectionBanner")).toBeVisible();
  await page.locator("#sendButton").click();
  await expect(page.locator("#messageInput")).toHaveValue("Отправлю позже");
  expect(writes).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.locator("#connectionBanner")).not.toBeVisible();
});

test("failed sends remain available after opening another chat",async ({page}) => {
  await mockAccount(page,{failSend:true});
  await openChat(page);
  await page.locator("#messageInput").fill("Сохрани неотправленное");
  await page.locator("#sendButton").click();
  await expect(page.locator("#messages")).toContainText("Не отправлено");
  await openChat(page,"Друзья");
  await openChat(page);
  await expect(page.locator("#messages")).toContainText("Сохрани неотправленное");
  await expect(page.getByRole("button",{name:"Повторить отправку",exact:true})).toBeVisible();
});

test("a retry reuses its message UUID after an uncertain server response",async ({page}) => {
  const {writes} = await mockAccount(page,{uncertainSend:true});
  await openChat(page);
  await page.locator("#messageInput").fill("Только один экземпляр");
  await page.locator("#sendButton").click();
  await expect(page.locator("#messages")).toContainText("Не отправлено");
  await page.getByRole("button",{name:"Повторить отправку",exact:true}).click();
  await expect(page.locator("#messages")).not.toContainText("Не отправлено");
  await expect(page.locator(".message-text").filter({hasText:"Только один экземпляр"})).toHaveCount(1);
  expect(writes).toHaveLength(2);
  expect(writes[0].id).toBe(writes[1].id);
});

test("forwarding chooses a destination without broken encryption helpers",async ({page}) => {
  const {writes,errors} = await mockAccount(page);
  await openChat(page);
  await page.getByRole("button",{name:"Переслать",exact:true}).click();
  await page.getByRole("radio",{name:"Друзья",exact:true}).check();
  await page.locator("#forwardSubmit").click();
  await expect(page.locator("#notice")).toContainText("переслано");
  expect(writes[0]).toMatchObject({chat_id:B,sender_id:USER,content:original.content});
  expect(errors).toEqual([]);
});

test("forwarding never downgrades an encrypted destination when keys are unavailable",async ({page}) => {
  const {writes} = await mockAccount(page,{encryptedTarget:true});
  await openChat(page);
  await page.getByRole("button",{name:"Переслать",exact:true}).click();
  await page.getByRole("radio",{name:"Друзья",exact:true}).check();
  await page.locator("#forwardSubmit").click();
  await expect(page.locator("#notice")).toContainText("Не удалось переслать");
  expect(writes).toHaveLength(0);
});

test("mobile group management shows roles and uses administrator RPCs",async ({page}) => {
  await page.setViewportSize({width:320,height:568});
  const {writes,errors} = await mockAccount(page);
  await openChat(page,"Друзья");
  await openTools(page);
  await page.locator("#groupManageButton").click();
  await expect(page.locator("#groupMembers")).toContainText("Владелец");
  await page.locator("#groupName").fill("Семья");
  await page.locator("#groupRenameForm").getByRole("button",{name:"Сохранить"}).click();
  await expect(page.locator("#groupStatus")).toContainText("участников");
  expect(writes).toContainEqual({rpc:"rename_chat",p_chat_id:B,p_title:"Семья"});
  await page.locator("#groupNewMember").fill("friend@example.invalid");
  await page.locator("#groupAddForm").getByRole("button",{name:"Добавить"}).click();
  await expect(page.locator("#groupStatus")).toContainText("участников");
  expect(writes).toContainEqual({rpc:"add_chat_member",p_chat_id:B,p_user_id:OTHER});
  await page.getByRole("button",{name:"Сделать админом",exact:true}).click();
  await expect(page.locator("#groupStatus")).toContainText("участников");
  expect(writes).toContainEqual({rpc:"update_chat_member_role",p_chat_id:B,p_user_id:OTHER,p_role:"admin"});
  await page.getByRole("button",{name:"Удалить",exact:true}).click();
  expect(writes.filter(write => write.rpc === "remove_chat_member")).toHaveLength(0);
  await page.getByRole("button",{name:"Подтвердить удаление",exact:true}).click();
  await expect(page.locator("#groupStatus")).toContainText("участников");
  expect(writes).toContainEqual({rpc:"remove_chat_member",p_chat_id:B,p_user_id:OTHER});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("ordinary members see group participants without administrator controls",async ({page}) => {
  await mockAccount(page,{role:"member"});
  await openChat(page,"Друзья");
  await openTools(page);
  await page.locator("#groupManageButton").click();
  await expect(page.locator("#groupStatus")).toContainText("управление доступно администраторам");
  await expect(page.locator("#groupAdminControls")).not.toBeVisible();
  await expect(page.locator(".group-member-actions")).toHaveCount(0);
});

test("sticker and formatting tools update the composer and preserve the draft",async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await mockAccount(page);
  await openChat(page);
  await page.locator("#composerTools > summary").click();
  await page.locator("#stickerButton").click();
  await page.locator("#stickerPicker button").first().click();
  await expect(page.locator("#messageInput")).toHaveValue("🥰");
  await page.locator("#composerTools > summary").click();
  await page.locator("#formatToggleButton").click();
  await page.locator("#boldTextButton").click();
  await expect(page.locator("#messageInput")).toHaveValue(/\*\*/);
  await page.screenshot({path:"test-results/minichat-mobile.png",fullPage:true});
});

test("logout hides chat data and account preferences from the next session",async ({page}) => {
  await mockAccount(page);
  await openChat(page);
  await page.locator("#messageInput").fill("Приватный черновик");
  await page.locator("#logoutButton").click();
  await expect(page.locator("#loginScreen")).toBeVisible();
  await expect(page.locator("#messages")).toBeEmpty();
  await expect(page.locator("#messageInput")).toHaveValue("");
  await expect(page.locator("#app")).not.toBeVisible();
});

test("late search responses do not replace a newer query",async ({page}) => {
  await mockAccount(page);
  await page.locator("#globalSearchButton").click();
  const oldResponse = page.waitForResponse(response => response.url().endsWith("/search_chat_messages") && response.request().postDataJSON().p_query === "старый");
  await page.locator("#messageLibraryQuery").fill("старый");
  await page.locator("#messageLibraryForm").getByRole("button",{name:"Найти",exact:true}).click();
  await page.locator("#messageLibraryQuery").fill("новый");
  await page.locator("#messageLibraryForm").getByRole("button",{name:"Найти",exact:true}).click();
  await expect(page.locator(".library-result")).toContainText("новый");
  await (await oldResponse).finished();
  await expect(page.locator(".library-result")).toContainText("новый");
  await expect(page.locator(".library-result")).not.toContainText("старый");
});

test("recording can be stopped on a phone after closing the tools panel",async ({page}) => {
  await page.setViewportSize({width:320,height:568});
  await page.addInitScript(() => {
    // Test recording controls without capturing real microphones or uploading audio.
    Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async () => ({getTracks:() => [{stop() {}}]})});
    window.MediaRecorder = class extends EventTarget {
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() { this.state = "inactive";queueMicrotask(() => this.dispatchEvent(new Event("stop"))); }
    };
  });
  const {writes,errors} = await mockAccount(page);
  await openChat(page);
  await page.locator("#composerTools > summary").click();
  await page.locator("#recordButton").click();
  await expect(page.locator("#composerTools")).not.toHaveAttribute("open");
  await expect(page.locator("#stopRecordingButton")).toBeInViewport();
  await page.locator("#stopRecordingButton").click();
  await expect(page.locator("#stopRecordingButton")).not.toBeVisible();
  expect(writes).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("a history containing replies renders without a missing encryption helper",async ({page}) => {
  const reply = {...original,id:"20000000-0000-4000-8000-000000000002",sender_id:USER,content:"Да, буду!",reply_to_id:M};
  const {errors} = await mockAccount(page,{history:[reply,original]});
  await openChat(page);
  await expect(page.locator("#messages")).toContainText("Да, буду!");
  await expect(page.locator("#messages")).toContainText("↪ " + original.content);
  await expect(page.locator("#messages")).not.toContainText("Не удалось загрузить сообщения");
  expect(errors).toEqual([]);
});

test("a plain message opens its editor and saves without missing encryption helpers",async ({page}) => {
  const {errors,writes} = await mockAccount(page,{history:[{...original,sender_id:USER}]});
  await openChat(page);
  await page.getByRole("button",{name:"Редактировать",exact:true}).click();
  await page.getByRole("textbox",{name:"Редактирование сообщения",exact:true}).fill("Исправленный текст");
  await page.locator("#messages").getByRole("button",{name:"Сохранить",exact:true}).click();
  await expect(page.locator("#messages")).toContainText("Исправленный текст");
  await expect(page.getByRole("textbox",{name:"Редактирование сообщения",exact:true})).toHaveCount(0);
  expect(writes).toContainEqual(expect.objectContaining({method:"PATCH",content:"Исправленный текст"}));
  expect(errors).toEqual([]);
});
