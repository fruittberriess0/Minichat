export async function readChatHistory(sb,chatId,snapshot=new Date().toISOString()) {
  const rows=[];
  let cursor=null;
  for (;;) {
    let query=sb.from("messages").select("*").eq("chat_id",chatId).is("deleted_at",null)
      .lte("created_at",snapshot).order("created_at",{ascending:true}).order("id",{ascending:true}).limit(500);
    if (cursor) query=query.or(`created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`);
    const {data,error}=await query;
    if(error) throw error;
    const page=data || [];
    rows.push(...page.filter(row=>!row.expires_at || row.expires_at>snapshot));
    if(page.length<500) return rows;
    const last=page.at(-1);
    if(cursor?.id===last.id) throw new Error("Сервер вернул повторную страницу истории");
    cursor=last;
  }
}
