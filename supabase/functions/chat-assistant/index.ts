import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Content-Type":"application/json"
};
function json(data:unknown,status=200) {
  return new Response(JSON.stringify(data),{status,headers:corsHeaders});
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok",{headers:corsHeaders});
  if (request.method !== "POST") return json({error:"POST required"},405);
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({error:"Authentication required"},401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const model = Deno.env.get("ANTHROPIC_MODEL");
  if (!supabaseUrl || !anonKey) return json({error:"Supabase function environment is not configured"},500);
  if (!apiKey || !model) return json({error:"Assistant is not configured yet: set ANTHROPIC_API_KEY and ANTHROPIC_MODEL as Edge Function secrets"},503);

  const supabase = createClient(supabaseUrl,anonKey,{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{headers:{Authorization:authHeader}}
  });
  const {data:{user},error:userError} = await supabase.auth.getUser();
  if (userError || !user) return json({error:"Invalid session"},401);

  let input:any;
  try { input = await request.json(); }
  catch { return json({error:"Invalid JSON"},400); }
  const chatId = String(input?.chat_id || "");
  const prompt = String(input?.prompt || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chatId)) {
    return json({error:"Invalid chat id"},400);
  }
  if (prompt.length < 1 || prompt.length > 1500) return json({error:"Prompt must be 1-1500 characters"},400);

  const {data:membership,error:membershipError} = await supabase.from("chat_members")
    .select("chat_id").eq("chat_id",chatId).eq("user_id",user.id).maybeSingle();
  if (membershipError || !membership) return json({error:"You are not a member of this chat"},403);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{
        "content-type":"application/json",
        "x-api-key":apiKey,
        "anthropic-version":"2023-06-01"
      },
      body:JSON.stringify({
        model,
        max_tokens:600,
        system:"You are MiniChat Assistant. Answer helpfully and concisely in the language of the user's prompt. Only use details in the prompt. Do not claim access to chat history or private data; this request contains only the text the user explicitly submitted.",
        messages:[{role:"user",content:prompt}]
      }),
      signal:AbortSignal.timeout(20000)
    });
    if (!upstream.ok) {
      console.error("Assistant upstream returned status",upstream.status);
      return json({error:"The assistant provider could not answer this request"},502);
    }
    const body:any = await upstream.json();
    const answer = (body?.content || [])
      .filter((block:any) => block?.type === "text")
      .map((block:any) => String(block.text || ""))
      .join("\n")
      .trim()
      .slice(0,6000);
    if (!answer) return json({error:"The assistant returned an empty response"},502);
    return json({answer,model});
  } catch (error) {
    console.error("Assistant request failed",error?.name || "unknown error");
    return json({error:"Assistant request timed out or could not connect"},502);
  }
});
