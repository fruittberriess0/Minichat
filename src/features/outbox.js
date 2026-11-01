// Stable server UUIDs make retries safe even if the INSERT response was lost.
export function createOutbox(storage, userId) {
  const key = "minichat-outbox-v1:" + userId;
  function list() {
    const raw = storage.getItem(key);
    const rows = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(rows)) throw new Error("Не удалось прочитать очередь отправки");
    return rows.filter(row => row.sender_id === userId && row.__payload?.sender_id === userId);
  }
  function put(row) {
    if (row.sender_id !== userId || row.__payload?.sender_id !== userId) throw new Error("Неверный владелец сообщения");
    const rows = list();
    const index = rows.findIndex(item => item.id === row.id);
    const saved = {...row,__pending:false,__failed:true};
    if (index < 0) rows.push(saved); else rows[index] = saved;
    storage.setItem(key, JSON.stringify(rows));
  }
  function remove(id) { storage.setItem(key, JSON.stringify(list().filter(row => row.id !== id))); }
  return {list,put,remove};
}

export async function insertOnce(sb, row) {
  const result = await sb.from("messages").insert(row).select().single();
  if (!result.error) return result.data;
  if (result.error.code !== "23505") throw result.error;
  // Never silently accept a conflict with a different user's or chat's message.
  const existing = await sb.from("messages").select("*").eq("id",row.id)
    .eq("sender_id",row.sender_id).eq("chat_id",row.chat_id).single();
  if (existing.error || !existing.data) throw existing.error || result.error;
  return existing.data;
}

export function mergePending(rows, pending, chatId) {
  const known = new Set(rows.map(row => row.id));
  return [...rows,...pending.filter(row => row.chat_id === chatId && !known.has(row.__payload.id))]
    .sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
