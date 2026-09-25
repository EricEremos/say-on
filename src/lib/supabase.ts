import { createClient } from "@supabase/supabase-js";

const url = import.meta.env["VITE_SUPABASE_URL"];
const anonKey = import.meta.env["VITE_SUPABASE_ANON_KEY"];

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
export const connectionMode = supabase === null ? "rehearsal" : "supabase-configured";

export const ensureAnonymousIdentity = async (): Promise<{ problem: string | null }> => {
  const client = supabase;
  if (client === null) return { problem: null };

  const current = await client.auth.getSession();
  if (current.error !== null) return { problem: current.error.message };
  if (current.data.session !== null) return { problem: null };

  const created = await client.auth.signInAnonymously();
  return { problem: created.error?.message ?? null };
};
