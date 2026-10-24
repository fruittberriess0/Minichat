import { createClient } from "@supabase/supabase-js";

const fallbackUrl = "https://gjqpucsbfuoqoncmdfbj.supabase.co";
const fallbackPublishableKey = "sb_publishable_S1M6veMpHEUzwpA0HeYwlw_IkQYqIzr";

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || fallbackUrl;
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || fallbackPublishableKey;
export const MEDIA_BUCKET = import.meta.env.VITE_SUPABASE_MEDIA_BUCKET || "chat-media";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
});
