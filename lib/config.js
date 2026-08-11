const GOALS_PREVIEW_BRANCH='agent/goals-incentives-v2';
const ADDON_PREVIEW_BRANCH='agent/addon-platform-v3';
const GIT_BRANCH=process.env.VERCEL_GIT_COMMIT_REF;
const IS_GOALS_PREVIEW=GIT_BRANCH===GOALS_PREVIEW_BRANCH;
const IS_ADDON_PREVIEW=GIT_BRANCH===ADDON_PREVIEW_BRANCH;

const DEFAULT_SUPABASE_URL=IS_ADDON_PREVIEW
  ?'https://pzflscqwfkixclmjyran.supabase.co'
  :IS_GOALS_PREVIEW
    ?'https://gyyvxlqtkmkyozxsfcts.supabase.co'
    :'https://gswpbwdactcstkasddta.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY=IS_ADDON_PREVIEW
  ?'sb_publishable_wtNzoOK8BpT4WdHseeSqOA_O6RxE-Gs'
  :IS_GOALS_PREVIEW
    ?'sb_publishable_uksfr2AqmK9b78Lk5LMrXQ_aTMDQveO'
    :'sb_publishable_bbfZERLAC2GzJxauAG_-Ng_c2dtZWzE';

export const SUPABASE_URL=process.env.NEXT_PUBLIC_SUPABASE_URL
  ||process.env.SUPABASE_URL
  ||DEFAULT_SUPABASE_URL;
export const SUPABASE_KEY=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ||process.env.SUPABASE_PUBLISHABLE_KEY
  ||process.env.SUPABASE_ANON_KEY
  ||DEFAULT_SUPABASE_PUBLISHABLE_KEY;
export const ACCESS_COOKIE='mt_access';
export const REFRESH_COOKIE='mt_refresh';

