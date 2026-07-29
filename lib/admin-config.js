import 'server-only';

export const SUPABASE_SECRET_KEY=
  process.env.SUPABASE_SECRET_KEY
  ||process.env.SUPABASE_SERVICE_ROLE_KEY
  ||'';
