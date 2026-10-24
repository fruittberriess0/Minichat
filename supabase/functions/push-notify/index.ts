import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "null",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json"
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {status, headers:corsHeaders});
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", {headers:corsHeaders});
  if (request.method !== "POST") return json({error:"POST required"}, 405);

  const webhookSecret = Deno.env.get("PUSH_WEBHOOK_SECRET");
  const authorization = request.headers.get("authorization") || "";
  if (!webhookSecret || authorization !== "Bearer " + webhookSecret) {
    return json({error:"Unauthorized"}, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!supabaseUrl || !serviceRoleKey || !vapidPublic || !vapidPrivate || !vapidSubject) {
    return json({error:"Server push secrets are not configured"}, 500);
  }

  let payload: any;
  try { payload = await request.json(); }
  catch { return json({error:"Invalid JSON"}, 400); }
  if (payload?.type !== "INSERT" || payload?.table !== "messages" || payload?.schema !== "public") {
    return json({ignored:true});
  }

  const message = payload.record;
  if (!message?.chat_id || !message?.sender_id || !message?.id) {
    return json({error:"Invalid message record"}, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth:{persistSession:false,autoRefreshToken:false}
  });
  const {data:members,error:membersError} = await supabase
    .from("chat_members").select("user_id").eq("chat_id", message.chat_id);
  if (membersError) return json({error:"Could not find chat recipients"}, 500);

  const recipientIds = [...new Set((members || [])
    .map((row: {user_id:string}) => row.user_id)
    .filter((id: string) => id !== message.sender_id))];
  if (!recipientIds.length) return json({sent:0});

  const {data:mutedRows,error:muteError} = await supabase
    .from("chat_preferences").select("user_id").eq("chat_id",message.chat_id)
    .in("user_id",recipientIds).eq("muted",true);
  if (muteError) return json({error:"Could not read notification preferences"},500);
  const mutedIds = new Set((mutedRows || []).map((row: {user_id:string}) => row.user_id));
  const allowedIds = recipientIds.filter((id:string) => !mutedIds.has(id));
  if (!allowedIds.length) return json({sent:0,muted:recipientIds.length});

  const {data:subscriptions,error:subscriptionsError} = await supabase
    .from("push_subscriptions").select("id,user_id,subscription").in("user_id", allowedIds);
  if (subscriptionsError) return json({error:"Could not read subscriptions"}, 500);

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  let sent = 0;
  const staleIds: string[] = [];
  const notification = JSON.stringify({
    title:"MiniChat ❤️",
    body:"У тебя новое сообщение",
    url:"/",
    tag:"minichat-chat-" + String(message.chat_id).slice(0,24)
  });

  await Promise.all((subscriptions || []).map(async (row: {id:string;subscription:unknown}) => {
    try {
      await webpush.sendNotification(row.subscription as any, notification);
      sent++;
    } catch (error: any) {
      const status = Number(error?.statusCode || error?.status);
      if (status === 404 || status === 410) staleIds.push(row.id);
      else console.error("Push delivery failed", status || "unknown");
    }
  }));

  if (staleIds.length) {
    await supabase.from("push_subscriptions").delete().in("id", staleIds);
  }
  return json({sent,expired:staleIds.length});
});
