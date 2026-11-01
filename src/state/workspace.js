// Local preferences are scoped to the signed-in account on this device.
function readRecord(key, storage) {
  try {
    const value = JSON.parse((storage || globalThis.localStorage).getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function createWorkspaceStore(userId, storage) {
  const key = "minichat-workspace-v1:" + encodeURIComponent(userId);
  function read() { return readRecord(key, storage); }
  function write(value) {
    try { (storage || globalThis.localStorage).setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  }
  return {
    draft(chatId) {
      const value = read().drafts?.[chatId];
      return typeof value === "string" ? value : "";
    },
    saveDraft(chatId, text) {
      const value = read();
      const drafts = value.drafts && typeof value.drafts === "object" && !Array.isArray(value.drafts) ? value.drafts : {};
      value.drafts = {...drafts, [chatId]:String(text)};
      if (!text) delete value.drafts[chatId];
      return write(value);
    },
    favorites() {
      const ids = read().favorites;
      return Array.isArray(ids) ? ids.filter(id => typeof id === "string") : [];
    },
    toggleFavorite(chatId) {
      const value = read();
      const ids = new Set(this.favorites());
      if (ids.has(chatId)) ids.delete(chatId); else ids.add(chatId);
      value.favorites = [...ids];
      return write(value);
    }
  };
}

export function filterChats(chats, summaries, favorites, filter, query = "") {
  const term = query.trim().toLocaleLowerCase("ru");
  return chats.filter(chat => {
    const title = chat.title || (chat.is_group ? "Групповой чат" : "Личный чат ❤️");
    return title.toLocaleLowerCase("ru").includes(term)
      && (filter !== "unread" || summaries[chat.id]?.unread > 0)
      && (filter !== "favorites" || favorites.includes(chat.id));
  }).sort((a,b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)));
}
