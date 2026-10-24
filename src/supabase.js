export const SUPABASE_URL = "https://gjqpucsbfuoqoncmdfbj.supabase.co";
export const SUPABASE_KEY = "sb_publishable_S1M6veMpHEUzwpA0HeYwlw_IkQYqIzr";
export const MEDIA_BUCKET = "chat-media";

if (!window.supabase?.createClient) {
  throw new Error("Supabase JS не загрузился. Проверь подключение к CDN.");
}
export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
});
