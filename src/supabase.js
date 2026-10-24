import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const SUPABASE_URL = "https://gjqpucsbfuoqoncmdfbj.supabase.co";
export const SUPABASE_KEY = "sb_publishable_S1M6veMpHEUzwpA0HeYwlw_IkQYqIzr";
export const MEDIA_BUCKET = "chat-media";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
});
