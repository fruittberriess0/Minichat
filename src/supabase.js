import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://gjqpucsbfuoqoncmdfbj.supabase.co";
export const SUPABASE_KEY = "sb_publishable_S1M6veMpHEUzwpA0HeYwlw_IkQYqIzr";
export const MEDIA_BUCKET = "chat-media";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
});
