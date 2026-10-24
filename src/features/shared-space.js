export function initSharedSpace({sb,$,getCurrentUser,getActiveChat,showNotice,safeError,onAlbum}) {
  const panel = $("sharedSpacePanel");
  const list = $("sharedSpaceList");
  const form = $("sharedItemForm");
  if (!panel || !list || !form) return;

  let currentItems = [];
  let currentVotes = [];

  function setStatus(value, isError = false) {
    $("sharedSpaceStatus").textContent = value || "";
    $("sharedSpaceStatus").style.color = isError ? "var(--danger)" : "var(--muted)";
  }

  function dateLabel(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(currentLanguageSafe(), {day:"numeric",month:"short",year:"numeric"});
  }
  function currentLanguageSafe() {
    try { return localStorage.getItem("minichat-language") === "en" ? "en-GB" : "ru-RU"; }
    catch { return "ru-RU"; }
  }
  function itemTypeLabel(type) {
    return ({
      task:"☑ Задача",
      event:"🗓 Событие",
      anniversary:"❤️ Наша дата",
      poll:"📊 Опрос",
      location:"📍 Местоположение"
    })[type] || "Элемент";
  }
  function makeButton(label, callback, className = "btn secondary small-btn") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", callback);
    return button;
  }
  function votesFor(itemId) {
    return currentVotes.filter(vote => vote.item_id === itemId);
  }

  async function loadItems() {
    const user = getCurrentUser();
    const chat = getActiveChat();
    if (!user || !chat) {
      setStatus("Сначала открой переписку.");
      list.replaceChildren();
      currentItems = [];
      currentVotes = [];
      return;
    }
    setStatus("Загружаем общее пространство…");
    try {
      const {data,error} = await sb.from("shared_items").select("*")
        .eq("chat_id",chat.id).order("created_at",{ascending:false}).limit(200);
      if (error) throw error;
      currentItems = data || [];
      const pollIds = currentItems.filter(item => item.item_type === "poll").map(item => item.id);
      if (pollIds.length) {
        const {data:votes,error:votesError} = await sb.from("shared_item_votes")
          .select("id,item_id,user_id,option_index").in("item_id",pollIds);
        if (votesError) throw votesError;
        currentVotes = votes || [];
      } else currentVotes = [];
      renderItems();
      setStatus(currentItems.length ? currentItems.length + " элементов в этом чате" : "Пока пусто. Добавь вашу первую задачу, дату или опрос.");
    } catch (error) {
      setStatus("Нужна миграция 202610240004_shared_space.sql или доступ к таблице: " + (error?.message || "ошибка"),true);
      list.replaceChildren();
    }
  }

  function renderItems() {
    const user = getCurrentUser();
    list.replaceChildren();
    if (!currentItems.length) return;
    currentItems.forEach(item => {
      const card = document.createElement("article");
      card.className = "shared-item-card";
      const top = document.createElement("div");
      top.className = "shared-item-top";
      const titleGroup = document.createElement("div");
      const type = document.createElement("div");
      type.className = "shared-item-meta";
      type.textContent = itemTypeLabel(item.item_type);
      const title = document.createElement("h3");
      title.className = "shared-item-title";
      title.textContent = item.title;
      titleGroup.append(type,title);
      top.appendChild(titleGroup);
      if (item.item_type === "task") {
        top.appendChild(makeButton(item.is_done ? "✓ Выполнено" : "Отметить", () => toggleTask(item), "btn secondary small-btn"));
      } else if (item.created_by === user?.id) {
        top.appendChild(makeButton("Удалить", () => removeItem(item), "btn secondary small-btn"));
      }
      card.appendChild(top);

      if (item.item_type === "poll") {
        const options = Array.isArray(item.payload?.options) ? item.payload.options : [];
        const votes = votesFor(item.id);
        const mine = votes.find(vote => vote.user_id === user?.id);
        options.forEach((option,index) => {
          const count = votes.filter(vote => vote.option_index === index).length;
          const button = makeButton("", () => castVote(item,index), "shared-poll-option" + (mine?.option_index === index ? " selected" : ""));
          const optionText = document.createElement("span");
          optionText.textContent = option;
          const countText = document.createElement("span");
          countText.className = "shared-poll-count";
          countText.textContent = String(count);
          button.append(optionText,countText);
          card.appendChild(button);
        });
        if (item.body) {
          const body = document.createElement("div");
          body.className = "shared-item-body";
          body.textContent = item.body;
          card.appendChild(body);
        }
      } else if (item.item_type === "location" && Number.isFinite(Number(item.payload?.latitude)) && Number.isFinite(Number(item.payload?.longitude))) {
        const coords = document.createElement("div");
        coords.className = "shared-item-body";
        coords.textContent = "Координаты: " + Number(item.payload.latitude).toFixed(5) + ", " + Number(item.payload.longitude).toFixed(5);
        const link = document.createElement("a");
        link.className = "message-link";
        link.href = "https://www.google.com/maps?q=" + encodeURIComponent(item.payload.latitude + "," + item.payload.longitude);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Открыть на карте";
        card.append(coords,link);
      } else if (item.body) {
        const body = document.createElement("div");
        body.className = "shared-item-body";
        body.textContent = item.body;
        card.appendChild(body);
      }
      const meta = document.createElement("div");
      meta.className = "shared-item-meta";
      const parts = [];
      if (item.due_at) parts.push((item.item_type === "anniversary" ? "Дата: " : "Срок: ") + dateLabel(item.due_at));
      parts.push("Добавлено: " + dateLabel(item.created_at));
      meta.textContent = parts.join(" · ");
      card.appendChild(meta);
      list.appendChild(card);
    });
  }

  async function toggleTask(item) {
    try {
      const {error} = await sb.rpc("set_shared_item_done",{p_item_id:item.id,p_is_done:!item.is_done});
      if (error) throw error;
      item.is_done = !item.is_done;
      await loadItems();
    } catch (error) { setStatus("Не удалось обновить задачу: " + (error?.message || "ошибка"),true); }
  }

  async function castVote(item,index) {
    const user = getCurrentUser();
    try {
      const current = votesFor(item.id).find(vote => vote.user_id === user.id);
      if (current?.option_index === index) {
        const {error} = await sb.from("shared_item_votes").delete().eq("id",current.id).eq("user_id",user.id);
        if (error) throw error;
      } else {
        const {error} = await sb.from("shared_item_votes").upsert({
          item_id:item.id,user_id:user.id,option_index:index
        },{onConflict:"item_id,user_id"});
        if (error) throw error;
      }
      await loadItems();
    } catch (error) { setStatus("Не удалось записать голос: " + (error?.message || "ошибка"),true); }
  }

  async function removeItem(item) {
    if (!confirm("Удалить этот элемент общего пространства?")) return;
    try {
      const {error} = await sb.from("shared_items").delete().eq("id",item.id);
      if (error) throw error;
      await loadItems();
    } catch (error) { setStatus("Не удалось удалить: " + (error?.message || "ошибка"),true); }
  }

  form.addEventListener("submit",async event => {
    event.preventDefault();
    const user = getCurrentUser();
    const chat = getActiveChat();
    if (!user || !chat) { setStatus("Сначала открой чат.",true); return; }
    const type = $("sharedItemType").value;
    const title = $("sharedItemTitle").value.trim();
    const body = $("sharedItemBody").value.trim();
    const dateValue = $("sharedItemDue").value;
    if (!title) return;
    let payload = {};
    if (type === "poll") {
      const options = [...new Set(body.split(",").map(value => value.trim()).filter(Boolean))];
      if (options.length < 2 || options.length > 10) {
        setStatus("Для опроса укажи от 2 до 10 вариантов через запятую.",true);
        return;
      }
      payload = {options};
    }
    let dueAt = null;
    if (dateValue) {
      const date = new Date(dateValue + "T12:00:00");
      if (!Number.isNaN(date.getTime())) dueAt = date.toISOString();
    }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const {error} = await sb.from("shared_items").insert({
        chat_id:chat.id,created_by:user.id,item_type:type,title,body,payload,due_at:dueAt
      });
      if (error) throw error;
      $("sharedItemTitle").value = "";
      $("sharedItemBody").value = "";
      $("sharedItemDue").value = "";
      setStatus("Добавлено ❤️");
      await loadItems();
    } catch (error) {
      setStatus("Не удалось добавить. Проверь, применена ли миграция shared space: " + (error?.message || "ошибка"),true);
    } finally { submit.disabled = false; }
  });

  $("sharedSpaceButton").addEventListener("click",async () => {
    if (!getActiveChat()) { showNotice("Сначала открой чат."); return; }
    $("sharedSpaceTitle").textContent = (getActiveChat().title || "Наше пространство") + " ❤️";
    panel.classList.remove("hidden");
    await loadItems();
  });
  $("sharedSpaceClose").addEventListener("click",() => panel.classList.add("hidden"));
  panel.addEventListener("click",event => { if (event.target === panel) panel.classList.add("hidden"); });
  $("shareLocationButton").addEventListener("click",() => {
    const user = getCurrentUser();
    const chat = getActiveChat();
    if (!user || !chat) { setStatus("Сначала открой чат.",true); return; }
    if (!navigator.geolocation) { setStatus("Этот браузер не поддерживает геолокацию.",true); return; }
    setStatus("Запрашиваем разрешение на местоположение…");
    navigator.geolocation.getCurrentPosition(async position => {
      try {
        const latitude = position.coords.latitude;
        const longitude = position.coords.longitude;
        const {error} = await sb.from("shared_items").insert({
          chat_id:chat.id,created_by:user.id,item_type:"location",title:"Моё местоположение",
          body:"Местоположение отправлено по твоему запросу.",
          payload:{latitude,longitude,accuracy:Math.round(position.coords.accuracy)}
        });
        if (error) throw error;
        await loadItems();
      } catch (error) { setStatus("Не удалось поделиться местоположением: " + (error?.message || "ошибка"),true); }
    },error => setStatus("Не удалось получить местоположение: " + error.message,true),{enableHighAccuracy:false,timeout:12000,maximumAge:60000});
  });

  $("sharedAlbumButton").addEventListener("click",async () => {
    const chat = getActiveChat();
    if (!chat) { showNotice("Сначала открой чат."); return; }
    if (onAlbum) await onAlbum(chat);
  });
}
