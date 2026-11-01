export function initGroupUI({$,sb,getUser,onChanged}) {
  const dialog = $("groupDialog");
  let chat = null;
  let version = 0;
  let busy = false;
  let canManage = false;
  const roles = {owner:"Владелец",admin:"Администратор",member:"Участник"};

  function status(text) { $("groupStatus").textContent = text; }
  async function load() {
    const run = ++version;
    const user = getUser();
    const target = chat;
    if (!user || !target) return;
    status("Загружаем участников…");
    $("groupMembers").replaceChildren();
    canManage = false;
    $("groupAdminControls").classList.add("hidden");
    try {
      const {data:members,error} = await sb.from("chat_members").select("user_id,role").eq("chat_id",target.id);
      if (error) throw error;
      const ids = (members || []).map(member => member.user_id);
      const {data:profiles,error:profileError} = ids.length
        ? await sb.from("profiles").select("id,username").in("id",ids) : {data:[],error:null};
      if (profileError) throw profileError;
      if (run !== version || getUser()?.id !== user.id || !dialog.open) return;
      canManage = ["owner","admin"].includes(members.find(member => member.user_id === user.id)?.role);
      $("groupAdminControls").classList.toggle("hidden",!canManage);
      for (const member of members) {
        const row = document.createElement("div");
        row.className = "group-member";
        const copy = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = profiles.find(profile => profile.id === member.user_id)?.username || "Участник";
        const role = document.createElement("span");
        role.textContent = (roles[member.role] || roles.member) + (member.user_id === user.id ? " · это ты" : "");
        copy.append(name,role);
        row.append(copy);
        if (canManage && member.role !== "owner" && member.user_id !== user.id) {
          const actions = document.createElement("div");
          actions.className = "group-member-actions";
          const promote = document.createElement("button");
          promote.type = "button";
          promote.className = "btn secondary small-btn";
          promote.textContent = member.role === "admin" ? "Снять права" : "Сделать админом";
          promote.addEventListener("click",() => mutate("update_chat_member_role",{p_user_id:member.user_id,p_role:member.role === "admin" ? "member" : "admin"}));
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "btn secondary small-btn";
          remove.textContent = "Удалить";
          let confirming = false;
          remove.addEventListener("click",() => {
            if (!confirming) {
              confirming = true;
              remove.textContent = "Подтвердить удаление";
              return;
            }
            mutate("remove_chat_member",{p_user_id:member.user_id});
          });
          actions.append(promote,remove);
          row.append(actions);
        }
        $("groupMembers").append(row);
      }
      status(members.length + " участников" + (canManage ? "" : " · управление доступно администраторам"));
    } catch (error) {
      if (run === version) status("Не удалось загрузить группу: " + (error?.message || "проверь соединение"));
    }
  }

  async function mutate(rpc,args) {
    if (busy || !canManage || !chat || !getUser()) return;
    const target = chat;
    const userId = getUser().id;
    busy = true;
    dialog.querySelectorAll("form button,.group-member-actions button").forEach(button => button.disabled = true);
    status("Сохраняем…");
    try {
      const {error} = await sb.rpc(rpc,{p_chat_id:target.id,...args});
      if (error) throw error;
      if (getUser()?.id !== userId) return;
      if (rpc === "rename_chat") target.title = args.p_title;
      await onChanged(target);
      if (dialog.open && chat.id === target.id) await load();
    } catch (error) { status("Не удалось сохранить: " + (error?.message || "проверь права и соединение")); }
    finally {
      busy = false;
      dialog.querySelectorAll("form button,.group-member-actions button").forEach(button => button.disabled = false);
    }
  }
  $("groupRenameForm").addEventListener("submit",event => {
    event.preventDefault();
    const title = $("groupName").value.trim();
    if (title) mutate("rename_chat",{p_title:title});
  });
  $("groupAddForm").addEventListener("submit",async event => {
    event.preventDefault();
    if (busy || !canManage) return;
    const query = $("groupNewMember").value.trim();
    if (!query) return;
    const targetId = chat?.id;
    const run = version;
    status("Ищем пользователя…");
    try {
      const {data,error} = await sb.rpc("find_chat_user",{p_query:query});
      if (error) throw error;
      if (run !== version || !dialog.open || chat?.id !== targetId) return;
      if (!data?.[0]?.user_id) throw new Error("Пользователь не найден");
      await mutate("add_chat_member",{p_user_id:data[0].user_id});
      $("groupNewMember").value = "";
    } catch (error) { status(error?.message || "Не удалось найти пользователя."); }
  });
  dialog.addEventListener("close",() => { version++; });
  return {
    async open(target) {
      if (!target?.is_group || !getUser()) return;
      chat = target;
      $("groupName").value = target.title || "";
      $("groupNewMember").value = "";
      document.querySelectorAll("details[open]").forEach(menu => menu.open = false);
      dialog.showModal();
      await load();
    }
  };
}
