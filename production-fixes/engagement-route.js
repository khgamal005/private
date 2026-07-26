import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://gswpbwdactcstkasddta.supabase.co';
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_bbfZERLAC2GzJxauAG_-Ng_c2dtZWzE';

function json(body, status = 200) { return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } }); }
function tokenFromValue(value) {
  if (!value) return null;
  try { value = decodeURIComponent(value); } catch {}
  try {
    const parsed = JSON.parse(value);
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed?.access_token || parsed?.currentSession?.access_token;
    if (typeof candidate === 'string') return candidate;
  } catch {}
  return value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] || null;
}
async function authContext(request) {
  const candidates = [request.cookies.get('mt_access')?.value, ...request.cookies.getAll().map(cookie => tokenFromValue(cookie.value))].filter(Boolean);
  for (const token of [...new Set(candidates)]) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (response.ok) {
      const user = await response.json();
      if (user?.id) return { token, user };
    }
  }
  return null;
}
async function rpc(token, name, args) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || payload?.error || 'تعذر تنفيذ العملية');
  return payload;
}
export async function GET(request, { params }) {
  try {
    const auth = await authContext(request);
    if (!auth) return json({ error: 'غير مصرح' }, 401);
    const { action } = await params;
    const slug = new URL(request.url).searchParams.get('tenantSlug');
    if (action === 'snapshot') return json(await rpc(auth.token, 'engagement_api_snapshot', { p_user_id: auth.user.id, p_tenant_slug: slug }));
    return json({ error: 'غير موجود' }, 404);
  } catch (error) { return json({ error: error.message || 'حدث خطأ' }, 500); }
}
export async function POST(request, { params }) {
  try {
    const auth = await authContext(request);
    if (!auth) return json({ error: 'غير مصرح' }, 401);
    const { action } = await params;
    const body = await request.json().catch(() => ({}));
    if (action === 'plan') return json(await rpc(auth.token, 'engagement_api_create_plan', {
      p_user_id: auth.user.id, p_tenant_slug: body.tenantSlug, p_title: body.title, p_period_start: body.periodStart,
      p_period_end: body.periodEnd, p_metric_type: body.metricType, p_target_value: Number(body.targetValue),
      p_incentive_type: body.incentiveType, p_incentive_value: Number(body.incentiveValue), p_tiers: body.tiers || [], p_employee_ids: body.employeeIds || [],
    }));
    if (action === 'announcement') return json(await rpc(auth.token, 'engagement_api_create_announcement', {
      p_user_id: auth.user.id, p_tenant_slug: body.tenantSlug, p_type: body.type, p_priority: body.priority,
      p_title: body.title, p_body: body.body, p_starts_at: body.startsAt || null, p_ends_at: body.endsAt || null,
      p_requires_ack: !!body.requiresAck, p_is_pinned: !!body.isPinned,
    }));
    if (action === 'read') return json(await rpc(auth.token, 'engagement_api_mark_read', {
      p_user_id: auth.user.id, p_announcement_id: body.announcementId, p_acknowledge: !!body.acknowledge,
    }));
    return json({ error: 'غير موجود' }, 404);
  } catch (error) { return json({ error: error.message || 'حدث خطأ' }, 500); }
}
