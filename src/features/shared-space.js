import { youtubeId, countdownLabel } from "./together-utils.js";

export function initSharedSpace({sb,$,getCurrentUser,getActiveChat,showNotice,safeError,onAlbum}) {
  const panel = $("sharedSpacePanel");
  const list = $("sharedSpaceList");
  const form = $("sharedItemForm");
  if (!panel || !list || !form) return {close(){}};
  let currentItems = [], currentVotes = [];
  let openChatId = null, channel = null, pollTimer = null, tickTimer = null;
  let revision = 0, busy = false, refreshPending = false, returnFocus = null;
  let watchingId = null, playerReady = false, playerPosition = 0, lastWatchState = "";
  const playerOrigin = "https://www.youtube.com";
  const types = {task:"☑ Задача",note:"📝 Заметка",event:"🗓 Событие",anniversary:"❤️ Наша дата",
    poll:"📊 Опрос",location:"📍 Местоположение",countdown:"⏳ Обратный отсчёт",youtube:"▶ Совместный просмотр",
    tictactoe:"🎮 Крестики-нолики",hangman:"🔤 Виселица"};
  function setStatus(value,error=false) {
    $("sharedSpaceStatus").textContent=value || "";
    $("sharedSpaceStatus").style.color=error ? "var(--danger)" : "var(--muted)";
  }
  function makeButton(label,callback,className="btn secondary small-btn") {
    const button=document.createElement("button");
    button.type="button"; button.className=className; button.textContent=label;
    button.addEventListener("click",callback); return button;
  }
  function text(tag,value,className="") {
    const node=document.createElement(tag); node.textContent=value; node.className=className; return node;
  }
  function dateLabel(value) { return value ? new Date(value).toLocaleString("ru-RU",{dateStyle:"medium",timeStyle:"short"}) : ""; }
  function votesFor(id) { return currentVotes.filter(vote=>vote.item_id===id); }
  function stillOpen(chatId) { return openChatId===chatId && getActiveChat()?.id===chatId && !panel.classList.contains("hidden"); }

  async function loadItems() {
    const chatId=openChatId, token=revision;
    if (!chatId || !stillOpen(chatId)) return;
    if (busy) { refreshPending=true; return; }
    busy=true;
    try {
      const {data,error}=await sb.from("shared_items").select("*").eq("chat_id",chatId).order("created_at",{ascending:false}).limit(200);
      if (error) throw error;
      const pollIds=(data || []).filter(item=>item.item_type==="poll").map(item=>item.id);
      let votes=[];
      if (pollIds.length) {
        const result=await sb.from("shared_item_votes").select("id,item_id,user_id,option_index").in("item_id",pollIds);
        if (result.error) throw result.error;
        votes=result.data || [];
      }
      if (revision!==token || !stillOpen(chatId)) return;
      const changed=JSON.stringify([data,votes])!==JSON.stringify([currentItems,currentVotes]);
      currentItems=data || []; currentVotes=votes;
      if (changed || !list.childElementCount) renderItems();
      syncWatch();
      setStatus(currentItems.length ? `${currentItems.length} элементов в этом чате` : "Пока пусто. Добавь что-нибудь для вас двоих.");
    } catch(error) {
      if (revision===token && stillOpen(chatId)) setStatus("Не удалось загрузить общее пространство: "+safeError(error),true);
    } finally {
      busy=false;
      if (refreshPending) { refreshPending=false; loadItems(); }
    }
  }
  async function runAction(callback) {
    try { await callback(); await loadItems(); }
    catch(error) { setStatus(safeError(error),true); }
  }
  function renderItems() {
    list.replaceChildren();
    const user=getCurrentUser();
    for (const item of currentItems) {
      const card=text("article","","shared-item-card");
      card.dataset.itemId=item.id;
      const top=text("div","","shared-item-top"), title=text("div","");
      title.append(text("div",types[item.item_type] || "Элемент","shared-item-meta"),text("h3",item.title,"shared-item-title"));
      top.appendChild(title);
      if (item.item_type==="task") top.appendChild(makeButton(item.is_done ? "✓ Выполнено" : "Отметить",()=>runAction(async()=>{
        const {error}=await sb.rpc("set_shared_item_done",{p_item_id:item.id,p_is_done:!item.is_done}); if(error) throw error;
      })));
      if (item.created_by===user?.id) top.appendChild(makeButton("Удалить",()=>{
        if(confirm("Удалить этот элемент?")) runAction(async()=>{
          const {error}=await sb.from("shared_items").delete().eq("id",item.id).eq("chat_id",openChatId); if(error) throw error;
        });
      }));
      card.appendChild(top);
      if (item.item_type==="poll") {
        const votes=votesFor(item.id), mine=votes.find(vote=>vote.user_id===user?.id);
        (item.payload?.options || []).forEach((option,index)=>{
          const count=votes.filter(vote=>vote.option_index===index).length;
          const button=makeButton("",()=>castVote(item,index),"shared-poll-option"+(mine?.option_index===index ? " selected" : ""));
          button.setAttribute("aria-pressed",String(mine?.option_index===index));
          button.append(text("span",option),text("span",String(count),"shared-poll-count")); card.appendChild(button);
        });
      } else if (item.item_type==="countdown") {
        const clock=text("div",countdownLabel(item.due_at),"shared-countdown"); clock.dataset.dueAt=item.due_at; card.appendChild(clock);
      } else if (item.item_type==="youtube") {
        if (/^[\w-]{11}$/.test(item.payload?.video_id || "")) card.appendChild(makeButton(watchingId===item.id ? "Вы смотрите это видео" : "Смотреть вместе",()=>joinWatch(item)));
      } else if (["tictactoe","hangman"].includes(item.item_type)) renderGame(item,card);
      else if (item.item_type==="location") {
        const lat=Number(item.payload?.latitude),lon=Number(item.payload?.longitude);
        if(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180) {
          const link=text("a","Открыть на карте","message-link");
          link.href="https://www.google.com/maps?q="+encodeURIComponent(lat+","+lon); link.target="_blank"; link.rel="noopener noreferrer";
          card.appendChild(link);
        }
      }
      if (item.body && !["poll","youtube","tictactoe","hangman"].includes(item.item_type)) card.appendChild(text("div",item.body,"shared-item-body"));
      if (item.item_type==="note") card.appendChild(makeButton("Редактировать",()=>editNote(item,card)));
      card.appendChild(text("div",[item.due_at ? dateLabel(item.due_at) : "", "Добавлено: "+dateLabel(item.created_at)].filter(Boolean).join(" · "),"shared-item-meta"));
      list.appendChild(card);
    }
  }
  function editNote(item,card) {
    const field=document.createElement("textarea"); field.className="field"; field.maxLength=1200; field.value=item.body; field.setAttribute("aria-label","Текст общей заметки");
    const save=makeButton("Сохранить",()=>runAction(async()=>{
      save.disabled=true;
      try { const {error}=await sb.from("shared_items").update({body:field.value}).eq("id",item.id).eq("chat_id",openChatId); if(error) throw error; }
      finally { save.disabled=false; }
    }));
    card.replaceChildren(text("h3",item.title),field,save,makeButton("Отмена",renderItems)); field.focus();
  }
  const movesInFlight=new Set();
  async function play(item,move) {
    if(movesInFlight.has(item.id)) return;
    movesInFlight.add(item.id);
    await runAction(async()=>{
      const {error}=await sb.rpc("play_shared_game",{p_item_id:item.id,p_move:String(move),p_version:item.payload.version});
      if(error) throw error;
    });
    movesInFlight.delete(item.id);
  }
  function renderGame(item,card) {
    const state=item.payload || {}, mine=state.players?.[state.turn]===getCurrentUser()?.id;
    if(item.item_type==="tictactoe") {
      const won=state.winner;
      card.appendChild(text("p",won==="draw" ? "Ничья 🤝" : won ? `Победил ${won} 🎉` : mine ? "Твой ход" : "Ход собеседника","shared-item-meta"));
      const board=text("div","","tic-board"); board.setAttribute("role","group"); board.setAttribute("aria-label","Поле крестиков-ноликов");
      (state.board || []).forEach((value,index)=>{
        const cell=makeButton(value || "·",()=>play(item,index),"tic-cell");
        cell.setAttribute("aria-label",`Клетка ${index+1}: ${value || "пусто"}`); cell.disabled=Boolean(won || value || !mine); board.appendChild(cell);
      }); card.appendChild(board);
    } else {
      card.append(text("div",state.mask || "•••••","hangman-word"),text("p",`Ошибки: ${state.mistakes || 0} / 6 · `+
        (state.status==="won" ? "Вы отгадали слово 🎉" : state.status==="lost" ? "Слово раскрыто. Начните новую партию" : mine ? "Твоя буква" : "Букву выбирает собеседник"),"shared-item-meta"));
      const keys=text("div","","hangman-keys");
      for(const letter of "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ") {
        const key=makeButton(letter,()=>play(item,letter),"btn secondary small-btn");
        key.disabled=state.status!=="playing" || !mine || (state.guesses || []).includes(letter); keys.appendChild(key);
      } card.appendChild(keys);
    }
  }
  async function castVote(item,index) {
    await runAction(async()=>{
      const user=getCurrentUser(), current=votesFor(item.id).find(vote=>vote.user_id===user.id);
      const {error}=current?.option_index===index ? await sb.from("shared_item_votes").delete().eq("id",current.id).eq("user_id",user.id) :
        await sb.from("shared_item_votes").upsert({item_id:item.id,user_id:user.id,option_index:index},{onConflict:"item_id,user_id"});
      if(error) throw error;
    });
  }
  function command(func,args=[]) { $("watchPlayer").contentWindow?.postMessage(JSON.stringify({event:"command",func,args}),playerOrigin); }
  function stopWatch() {
    watchingId=null; playerReady=false; lastWatchState="";
    $("watchPlayer").src="about:blank"; $("watchPlayerWrap").classList.add("hidden");
  }
  function joinWatch(item) {
    if (!/^[\w-]{11}$/.test(item.payload?.video_id || "")) return;
    watchingId=item.id; playerReady=false; lastWatchState=""; playerPosition=0;
    $("watchPlayerWrap").classList.remove("hidden"); $("watchTitle").textContent=item.title;
    $("watchPlayer").src=playerOrigin+"/embed/"+item.payload.video_id+"?enablejsapi=1&playsinline=1&controls=0&origin="+encodeURIComponent(location.origin);
    $("watchPlayerWrap").scrollIntoView({block:"nearest"});
  }
  function syncWatch() {
    if (!watchingId) return;
    const item=currentItems.find(row=>row.id===watchingId);
    if(!item) { stopWatch(); return; }
    if(!playerReady) return;
    const state=item.payload, key=JSON.stringify(state);
    if (key===lastWatchState) return;
    const elapsed=state.playing ? Math.max(0,(Date.now()-new Date(state.changed_at).getTime())/1000) : 0;
    playerPosition=Number(state.position || 0)+elapsed;
    command("seekTo",[playerPosition,true]); command(state.playing ? "playVideo" : "pauseVideo");
    lastWatchState=key;
    $("watchStatus").textContent=state.playing ? "Смотрим вместе · если видео не началось, нажми ▶" : "Пауза у обоих";
  }
  async function changeWatch(playing) {
    if (!watchingId) return;
    const requested=Number($("watchPosition").value);
    const position=$("watchPosition").value!=="" && Number.isFinite(requested) ? requested : playerPosition;
    await runAction(async()=>{
      const {error}=await sb.rpc("set_watch_state",{p_item_id:watchingId,p_playing:playing,p_position:Math.max(0,position)}); if(error) throw error;
      $("watchPosition").value="";
    });
    // Repeated play also counts as a user gesture when the browser blocked autoplay.
    command(playing ? "playVideo" : "pauseVideo");
  }
  $("watchPlayer").addEventListener("load",()=>{
    if (watchingId) $("watchPlayer").contentWindow?.postMessage(JSON.stringify({event:"listening",id:"minichat-watch"}),playerOrigin);
  });
  window.addEventListener("message",event=>{
    if(event.origin!==playerOrigin || event.source!==$("watchPlayer").contentWindow || !watchingId) return;
    let data; try { data=typeof event.data==="string" ? JSON.parse(event.data) : event.data; } catch { return; }
    if(data?.event==="onReady" || data?.event==="infoDelivery") { playerReady=true; syncWatch(); }
    if(Number.isFinite(data?.info?.currentTime)) playerPosition=data.info.currentTime;
  });
  $("watchPlay").addEventListener("click",()=>changeWatch(true));
  $("watchPause").addEventListener("click",()=>changeWatch(false));
  $("watchLeave").addEventListener("click",stopWatch);

  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const user=getCurrentUser(),chat=getActiveChat();
    if(!user || !chat || chat.id!==openChatId) return;
    const type=$("sharedItemType").value,title=$("sharedItemTitle").value.trim(),body=$("sharedItemBody").value.trim();
    if(!title) return;
    let payload={},dueAt=null;
    if(type==="poll") {
      const options=[...new Set(body.split(",").map(value=>value.trim()).filter(Boolean))];
      if(options.length<2 || options.length>10) { setStatus("Для опроса нужно от 2 до 10 вариантов через запятую.",true); return; }
      payload={options};
    }
    if(type==="youtube") {
      const id=youtubeId(body);
      if(!id) { setStatus("Вставь HTTPS-ссылку на видео YouTube в поле описания.",true); return; }
      payload={video_id:id};
    }
    if($("sharedItemDue").value) {
      const date=new Date($("sharedItemDue").value);
      if(!Number.isNaN(date.getTime())) dueAt=date.toISOString();
    }
    if(type==="countdown" && !dueAt) { setStatus("Укажи дату и время события.",true); return; }
    const submit=form.querySelector('button[type="submit"]'); submit.disabled=true;
    try {
      const {error}=await sb.from("shared_items").insert({chat_id:chat.id,created_by:user.id,item_type:type,title,body,payload,due_at:dueAt});
      if(error) throw error;
      $("sharedItemTitle").value=""; $("sharedItemBody").value=""; $("sharedItemDue").value="";
      await loadItems();
    } catch(error) { setStatus(safeError(error),true); }
    finally { submit.disabled=false; }
  });
  function close() {
    revision++; openChatId=null; currentItems=[]; currentVotes=[];
    clearInterval(pollTimer); clearInterval(tickTimer);
    if(channel) sb.removeChannel(channel); channel=null;
    stopWatch(); panel.classList.add("hidden");
    returnFocus?.focus(); returnFocus=null;
  }
  $("sharedSpaceButton").addEventListener("click",async()=>{
    const chat=getActiveChat(); if(!chat) { showNotice("Сначала открой чат."); return; }
    close(); returnFocus=document.activeElement; openChatId=chat.id;
    $("sharedSpaceTitle").textContent=(chat.title || "Наше пространство")+" ❤️";
    panel.classList.remove("hidden"); $("sharedSpaceClose").focus(); setStatus("Загружаем…");
    channel=sb.channel("shared-space:"+chat.id)
      .on("postgres_changes",{event:"*",schema:"public",table:"shared_items",filter:"chat_id=eq."+chat.id},loadItems)
      .on("postgres_changes",{event:"*",schema:"public",table:"shared_item_votes"},loadItems).subscribe();
    pollTimer=setInterval(loadItems,10000);
    tickTimer=setInterval(()=>list.querySelectorAll("[data-due-at]").forEach(node=>node.textContent=countdownLabel(node.dataset.dueAt)),1000);
    await loadItems();
  });
  $("sharedSpaceClose").addEventListener("click",close);
  panel.addEventListener("click",event=>{if(event.target===panel) close();});
  panel.addEventListener("keydown",event=>{
    if(event.key==="Escape") close();
    if(event.key!=="Tab") return;
    const nodes=[...panel.querySelectorAll('button:not(:disabled),input,textarea,select,iframe,a[href]')].filter(node=>node.getClientRects().length);
    if(event.shiftKey && document.activeElement===nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
    else if(!event.shiftKey && document.activeElement===nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
  });
  $("sharedAlbumButton").addEventListener("click",()=>{ const chat=getActiveChat(); if(chat) onAlbum?.(chat); else showNotice("Сначала открой чат."); });
  $("shareLocationButton").addEventListener("click",()=>{
    const user=getCurrentUser(),chat=getActiveChat();
    if(!user || !chat || !navigator.geolocation) { setStatus("Местоположение недоступно в этом браузере.",true); return; }
    navigator.geolocation.getCurrentPosition(position=>runAction(async()=>{
      const {latitude,longitude,accuracy}=position.coords;
      const {error}=await sb.from("shared_items").insert({chat_id:chat.id,created_by:user.id,item_type:"location",title:"Моё местоположение",body:"",payload:{latitude,longitude,accuracy:Math.round(accuracy)}});
      if(error) throw error;
    }),error=>setStatus(error.message,true),{enableHighAccuracy:false,timeout:12000,maximumAge:60000});
  });
  return {close};
}
