import {createHandler} from './handler.mjs';
function values(name: string): string[] {
  try { return Object.values(JSON.parse(Deno.env.get(name) || '{}')).filter((v): v is string => typeof v === 'string'); }
  catch { return []; }
}
const secret = values('SUPABASE_SECRET_KEYS')[0] || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
Deno.serve(createHandler({defer:(promise: Promise<unknown>)=>EdgeRuntime.waitUntil(promise),url:Deno.env.get('SUPABASE_URL') || '',secret,publicKeys:[...values('SUPABASE_PUBLISHABLE_KEYS'),Deno.env.get('SUPABASE_ANON_KEY') || '']}));
