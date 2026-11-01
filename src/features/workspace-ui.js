export function initWorkspaceUI({$, sb, getUser, getChats, chatTitle, openMessage, onCreated}) {
  const createDialog = $("createChatDialog");
  const library = $("messageLibraryDialog");
  let libraryMode = "search";
  let requestId = 0;
  const returnFocus = new WeakMap();
  let forwardResolve = null;
  let forwardSourceId = null;
  let forwardTargetId = null;

  function openDialog(dialog) {
    document.querySelectorAll("details.tools-menu[open]").forEach(menu => menu.open = false);
    returnFocus.set(dialog,document.activeElement);
    if (!dialog.open) dialog.showModal();
  }
  document.querySelectorAll("dialog.workspace-dialog").forEach(dialog => {
    dialog.querySelector("[data-close-dialog]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
    dialog.addEventListener("close", () => {
      requestId++;
      returnFocus.get(dialog)?.focus();
    });
  });

  const menus = [...document.querySelectorAll("details.tools-menu")];
  menus.forEach(menu => {
    menu.addEventListener("toggle", () => {
      menu.querySelector("summary").setAttribute("aria-expanded", String(menu.open));
      if (menu.open) menus.filter(other => other !== menu).forEach(other => other.open = false);
    });
    menu.addEventListener("click", event => {
      if (event.target.closest("button")) menu.open = false;
    });
  });
  document.addEventListener("click", event => menus.filter(menu => !menu.contains(event.target)).forEach(menu => menu.open = false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") menus.filter(menu => menu.open).forEach(menu => {
      menu.open = false;
      menu.querySelector("summary").focus();
    });
  });
  document.querySelectorAll("button[title]:not([aria-label])").forEach(button => button.setAttribute("aria-label", button.title));

  $("passwordVisibilityButton").addEventListener("click", event => {
    const showing = $("password").type === "password";
    $("password").type = showing ? "text" : "password";
    event.currentTarget.setAttribute("aria-pressed", String(showing));
    event.currentTarget.setAttribute("aria-label", showing ? "Скрыть пароль" : "Показать пароль");
  });
  $("createChatType").addEventListener("change", () => {
    const group = $("createChatType").value === "group";
    $("createChatTitleWrap").classList.toggle("hidden", !group);
    $("createChatHint").textContent = group ? "Имена пользователей или email через запятую. Участники должны быть зарегистрированы." : "Укажи одного зарегистрированного пользователя.";
  });
  $("createChatForm").addEventListener("submit", async event => {
    event.preventDefault();
    const user = getUser();
    if (!user || $("createChatSubmit").disabled) return;
    const group = $("createChatType").value === "group";
    const queries = [...new Set($("createChatMembers").value.split(",").map(value => value.trim()).filter(Boolean))];
    const status = $("createChatStatus");
    if (!queries.length || queries.length > 30 || (!group && queries.length !== 1)) {
      status.textContent = group ? "Укажи от 1 до 30 участников." : "Для личного чата укажи одного пользователя.";
      return;
    }
    $("createChatSubmit").disabled = true;
    status.textContent = "Ищем участников…";
    try {
      const members = [];
      const names = [];
      for (const query of queries) {
        const {data,error} = await sb.rpc("find_chat_user", {p_query:query});
        if (error) throw error;
        const member = data?.[0];
        if (!member?.user_id) throw new Error("Не найден пользователь: " + query);
        members.push(member.user_id);
        names.push(member.username || query);
      }
      if (getUser()?.id !== user.id) return;
      const {data,error} = await sb.rpc("create_chat_with_members", {
        p_title:group ? ($("createChatName").value.trim() || names.join(", ")).slice(0,80) : "",
        p_is_group:group, p_member_ids:[...new Set(members)]
      });
      if (error) throw error;
      if (getUser()?.id !== user.id) return;
      createDialog.close();
      await onCreated(data);
    } catch (error) { status.textContent = "Не удалось создать чат: " + (error?.message || "проверь соединение"); }
    finally { $("createChatSubmit").disabled = false; }
  });

  function renderResults(rows) {
    const list = $("messageLibraryResults");
    list.replaceChildren();
    rows.forEach(row => {
      const chat = getChats().find(chat => chat.id === row.chat_id);
      if (!chat) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "library-result";
      const heading = document.createElement("strong");
      heading.textContent = chatTitle(chat);
      const body = document.createElement("span");
      body.textContent = row.encrypted_payload ? "🔒 Зашифрованное сообщение" : row.content || row.file_name || "Вложение";
      const date = document.createElement("time");
      const timestamp = new Date(row.created_at);
      date.textContent = Number.isNaN(timestamp.getTime()) ? "" : timestamp.toLocaleString("ru-RU", {dateStyle:"medium",timeStyle:"short"});
      button.append(heading,body,date);
      button.addEventListener("click", async () => {
        library.close();
        await openMessage(row);
      });
      list.append(button);
    });
    const count = list.childElementCount;
    $("messageLibraryStatus").textContent = count ? "Сообщений: " + count + (count >= 100 ? " · показаны первые 100" : "") : "Ничего не найдено.";
  }

  async function searchLibrary() {
    const user = getUser();
    if (!user) return;
    const run = ++requestId;
    const query = $("messageLibraryQuery").value.trim();
    if (libraryMode === "search" && query.length < 2) { $("messageLibraryStatus").textContent = "Для поиска введи хотя бы 2 символа."; return; }
    $("messageLibraryResults").replaceChildren();
    $("messageLibraryStatus").textContent = "Загружаем…";
    try {
      let rows;
      if (libraryMode === "saved") {
        const {data,error} = await sb.from("saved_messages").select("message_id,created_at")
          .eq("user_id",user.id).order("created_at",{ascending:false}).limit(100);
        if (error) throw error;
        const ids = (data || []).map(item => item.message_id);
        rows = [];
        if (ids.length) {
          const {data:messages,error} = await sb.from("messages").select("*").in("id",ids).is("deleted_at",null);
          if (error) throw error;
          const byId = new Map((messages || []).map(row => [row.id,row]));
          rows = ids.map(id => byId.get(id)).filter(Boolean);
        }
        rows = rows.filter(row => !query || (!row.encrypted_payload && [row.content,row.file_name,chatTitle(getChats().find(chat => chat.id === row.chat_id) || {})].join(" ").toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru"))));
      } else {
        const {data,error} = await sb.rpc("search_chat_messages", {p_query:query});
        if (error) throw error;
        rows = (data || []).slice(0,100);
      }
      if (run !== requestId || getUser()?.id !== user.id || !library.open) return;
      renderResults(rows.filter(row => !row.expires_at || new Date(row.expires_at).getTime() > Date.now()));
    } catch (error) {
      if (run === requestId && library.open) $("messageLibraryStatus").textContent = "Не удалось загрузить сообщения: " + (error?.message || "проверь соединение");
    }
  }
  $("messageLibraryForm").addEventListener("submit", event => { event.preventDefault(); searchLibrary(); });
  $("messageLibraryQuery").addEventListener("input", () => {
    requestId++;
    if (!$("messageLibraryQuery").value.trim() && libraryMode === "saved") searchLibrary();
  });

  function renderForwardTargets() {
    const term = $("forwardQuery").value.trim().toLocaleLowerCase("ru");
    const list = $("forwardTargets");
    list.replaceChildren();
    getChats().filter(chat => chat.id !== forwardSourceId && chatTitle(chat).toLocaleLowerCase("ru").includes(term)).forEach(chat => {
      const label = document.createElement("label");
      label.className = "forward-target";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "forwardTarget";
      radio.value = chat.id;
      radio.checked = chat.id === forwardTargetId;
      radio.addEventListener("change",() => {
        forwardTargetId = chat.id;
        $("forwardSubmit").disabled = false;
      });
      label.append(radio,document.createTextNode(chatTitle(chat)));
      list.append(label);
    });
    if (!list.childElementCount) list.textContent = "Других подходящих чатов нет.";
  }
  $("forwardQuery").addEventListener("input",renderForwardTargets);
  $("forwardForm").addEventListener("submit",event => {
    event.preventDefault();
    const chat = getChats().find(chat => chat.id === forwardTargetId);
    if (!chat) return;
    const resolve = forwardResolve;
    forwardResolve = null;
    $("forwardDialog").close();
    resolve?.(chat);
  });
  $("forwardDialog").addEventListener("close",() => {
    forwardResolve?.(null);
    forwardResolve = null;
  });
  return {
    forwardTarget(sourceChatId) {
      forwardSourceId = sourceChatId;
      forwardTargetId = null;
      $("forwardSubmit").disabled = true;
      $("forwardQuery").value = "";
      renderForwardTargets();
      openDialog($("forwardDialog"));
      return new Promise(resolve => { forwardResolve = resolve; });
    },
    createChat() {
      if (!getUser()) return;
      $("createChatStatus").textContent = "";
      openDialog(createDialog);
      $("createChatMembers").focus();
    },
    library(mode) {
      if (!getUser()) return;
      libraryMode = mode;
      $("messageLibraryTitle").textContent = mode === "saved" ? "Сохранённые сообщения" : "Поиск по всем чатам";
      $("messageLibraryQuery").value = "";
      $("messageLibraryResults").replaceChildren();
      $("messageLibraryStatus").textContent = mode === "saved" ? "Загружаем…" : "Введи текст сообщения и нажми «Найти». Поиск не раскрывает содержимое E2EE.";
      openDialog(library);
      $("messageLibraryQuery").focus();
      if (mode === "saved") searchLibrary();
    }
  };
}
