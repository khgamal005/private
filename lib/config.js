const DEFAULT_SUPABASE_URL='https://gswpbwdactcstkasddta.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY='sb_publishable_bbfZERLAC2GzJxauAG_-Ng_c2dtZWzE';

export const SUPABASE_URL=process.env.NEXT_PUBLIC_SUPABASE_URL||process.env.SUPABASE_URL||DEFAULT_SUPABASE_URL;
export const SUPABASE_KEY=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||process.env.SUPABASE_ANON_KEY||DEFAULT_SUPABASE_PUBLISHABLE_KEY;
export const ACCESS_COOKIE='mt_access';
export const REFRESH_COOKIE='mt_refresh';
