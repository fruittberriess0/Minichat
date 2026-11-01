import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import webpush from "npm:web-push@3.6.7";

const headers={"Access-Control-Allow-Origin":"null","Access-Control-Allow-Headers":"authorization, content-type","Content-Type":"application/json"};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
const supabaseUrl=Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const sb=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
let cachedConfig:Record<string,string>={};
let configLoadedAt=0;
async function configuration() {
  if(Date.now()-configLoadedAt<60000) return cachedConfig;
  const {data,error}=await sb.rpc("get_minichat_push_configuration");
  if(error) throw new Error("Push configuration unavailable");
  cachedConfig=data || {}; configLoadedAt=Date.now(); return cachedConfig;
}
function supportedEndpoint(value:unknown) {
  try {
    const url=new URL(String(value));
    return url.protocol==="https:" && !url.username && !url.password &&
      ["fcm.googleapis.com","push.services.mozilla.com","web.push.apple.com","notify.windows.com"]
        .some(host=>url.hostname===host || url.hostname.endsWith("."+host));
  } catch {return false;}
}

Deno.serve(async request=>{
  if(request.method==="OPTIONS") return new Response("ok",{headers});
  if(request.method!=="POST") return json({error:"POST required"},405);
  let config:Record<string,string>;
  try {config=await configuration();} catch {return json({error:"Push is not configured"},503);}
  const webhook=Deno.env.get("PUSH_WEBHOOK_SECRET") || config.minichat_push_webhook;
  if(!webhook || request.headers.get("authorization")!=="Bearer "+webhook) return json({error:"Unauthorized"},401);
  const vapidPublic=Deno.env.get("VAPID_PUBLIC_KEY") || config.minichat_vapid_public;
  const vapidPrivate=Deno.env.get("VAPID_PRIVATE_KEY") || config.minichat_vapid_private;
  const vapidSubject=Deno.env.get("VAPID_SUBJECT") || config.minichat_vapid_subject;
  if(!vapidPublic || !vapidPrivate || !vapidSubject) return json({error:"VAPID is not configured"},503);

  let payload;
  try {payload=await request.json();} catch {return json({error:"Invalid JSON"},400);}
  if(payload?.type!=="INSERT" || payload?.table!=="messages" || payload?.schema!=="public") return json({ignored:true});
  const messageId=payload?.record?.id;
  if(typeof messageId!=="string" || !/^[0-9a-f-]{36}$/i.test(messageId)) return json({error:"Invalid message"},400);
  const {data:message,error:messageError}=await sb.from("messages")
    .select("id,chat_id,sender_id,expires_at,deleted_at").eq("id",messageId).maybeSingle();
  if(messageError) return json({error:"Message lookup failed"},500);
  if(!message || message.deleted_at || (message.expires_at && new Date(message.expires_at).getTime()<=Date.now())) return json({ignored:true});
  const {data:members,error:membersError}=await sb.from("chat_members").select("user_id").eq("chat_id",message.chat_id);
  if(membersError) return json({error:"Recipient lookup failed"},500);
  const recipients=[...new Set((members || []).map(row=>row.user_id).filter(id=>id!==message.sender_id))];
  if(!recipients.length) return json({sent:0});
  const {data:muted,error:muteError}=await sb.from("chat_preferences").select("user_id")
    .eq("chat_id",message.chat_id).in("user_id",recipients).eq("muted",true);
  if(muteError) return json({error:"Notification preferences unavailable"},500);
  const excluded=new Set((muted || []).map(row=>row.user_id));
  const allowed=recipients.filter(id=>!excluded.has(id));
  if(!allowed.length) return json({sent:0,muted:recipients.length});
  const {data:subscriptions,error:subscriptionError}=await sb.from("push_subscriptions")
    .select("id,subscription").in("user_id",allowed);
  if(subscriptionError) return json({error:"Subscriptions unavailable"},500);
  webpush.setVapidDetails(vapidSubject,vapidPublic,vapidPrivate);
  // Only static generic text is encrypted for the recipient browser. Chat IDs,
  // user IDs, message IDs and message content never enter the push payload.
  const notification=JSON.stringify({title:"MiniChat ❤️",body:"У тебя новое сообщение",
    url:"/",tag:"minichat-message"});
  let sent=0,failed=0;
  const stale:string[]=[];
  await Promise.all((subscriptions || []).map(async row=>{
    if(!supportedEndpoint(row.subscription?.endpoint)) {failed++;return;}
    try {await webpush.sendNotification(row.subscription,notification);sent++;}
    catch(error) {
      const status=Number((error as {statusCode?:number}).statusCode);
      if(status===404 || status===410) stale.push(row.id); else failed++;
    }
  }));
  if(stale.length) await sb.from("push_subscriptions").delete().in("id",stale);
  return json({sent,failed,expired:stale.length});
});
