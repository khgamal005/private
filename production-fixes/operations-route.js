import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://gswpbwdactcstkasddta.supabase.co';
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_bbfZERLAC2GzJxauAG_-Ng_c2dtZWzE';

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
function decodeBase64(value) {
  try { return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; }
}
function tokenFromValue(input) {
  if (!input) return null;
  let value = input;
  try { value = decodeURIComponent(value); } catch {}
  if (value.startsWith('base64-')) value = decodeBase64(value.slice(7));
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0];
    if (parsed && typeof parsed === 'object') return parsed.access_token || parsed.accessToken || parsed.currentSession?.access_token || null;
  } catch {}
  const match = value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}
function requestTokens(request) {
  const direct = request.cookies.get('mt_access')?.value;
  const candidates = direct ? [direct] : [];
  const groups = new Map();
  for (const cookie of request.cookies.getAll()) {
    const base = cookie.name.replace(/\.\d+$/, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(cookie);
    const token = tokenFromValue(cookie.value);
    if (token) candidates.push(token);
  }
  for (const cookies of groups.values()) {
    const joined = cookies.sort((a, b) => Number(a.name.split('.').pop()) - Number(b.name.split('.').pop())).map(item => item.value).join('');
    const token = tokenFromValue(joined);
    if (token) candidates.push(token);
  }
  return [...new Set(candidates)];
}
async function authContext(request) {
  for (const token of requestTokens(request)) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (response.ok) {
      const user = await response.json();
      if (user?.id) return { token, user };
    }
  }
  return null;
}
async function rpc(token, name, args) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || payload?.error || `RPC ${name} failed`);
  return payload;
}
function tenantSlug(request, body) {
  return body?.tenantSlug || new URL(request.url).searchParams.get('tenantSlug') || null;
}
function userArgs(user, slug) {
  return { p_user_id: user.id, p_email: user.email || null, p_name: user.user_metadata?.name || user.user_metadata?.full_name || null, p_tenant_slug: slug };
}
function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, ' ');
}
function pick(row, aliases) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const found = entries.find(([key]) => normalizeHeader(key) === normalizeHeader(alias));
    if (found) return found[1];
  }
  return '';
}
function normalizeRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }).map(row => ({
    name: String(pick(row, ['الاسم', 'اسم العميل', 'اسم المتدرب', 'name', 'customer name']) || '').trim(),
    phone: String(pick(row, ['رقم الهاتف', 'رقم الجوال', 'الجوال', 'الهاتف', 'phone', 'mobile']) || '').trim(),
    program: String(pick(row, ['البرنامج او الدوره', 'البرنامج أو الدورة', 'البرنامج', 'الدوره', 'الدورة', 'program', 'course']) || '').trim(),
    ad_name: String(pick(row, ['اسم الاعلان', 'اسم الإعلان', 'الاعلان', 'الإعلان', 'ad name', 'campaign']) || '').trim(),
  })).filter(row => row.name || row.phone || row.program || row.ad_name);
}
export async function GET(request, { params }) {
  try {
    const { action } = await params;
    const auth = await authContext(request);
    if (!auth) return json({ error: 'غير مصرح. أعد تسجيل الدخول.' }, 401);
    const url = new URL(request.url);
    const slug = url.searchParams.get('tenantSlug') || null;
    if (action === 'bootstrap') return json(await rpc(auth.token, 'operations_api_bootstrap', userArgs(auth.user, slug)));
    if (action === 'calendar') return json(await rpc(auth.token, 'operations_api_calendar', {
      p_user_id: auth.user.id, p_tenant_slug: slug, p_from: url.searchParams.get('from'), p_to: url.searchParams.get('to'), p_scope: url.searchParams.get('scope') || 'mine',
    }));
    if (action === 'template') {
      const sheet = XLSX.utils.aoa_to_sheet([
        ['الاسم', 'رقم الهاتف', 'البرنامج أو الدورة', 'اسم الإعلان'],
        ['اسم العميل', '05xxxxxxxx', 'اسم البرنامج أو الدورة', 'اسم الحملة أو الإعلان'],
      ]);
      sheet['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 30 }, { wch: 28 }];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, 'نموذج العملاء');
      const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
      return new NextResponse(buffer, { status: 200, headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="marktone-customers-template.xlsx"', 'cache-control': 'no-store',
      } });
    }
    return json({ error: 'الإجراء غير موجود' }, 404);
  } catch (error) { return json({ error: error.message || 'حدث خطأ' }, 500); }
}
export async function POST(request, { params }) {
  try {
    const { action } = await params;
    const auth = await authContext(request);
    if (!auth) return json({ error: 'غير مصرح. أعد تسجيل الدخول.' }, 401);
    if (action === 'upload') {
      const form = await request.formData();
      const file = form.get('file');
      const slug = String(form.get('tenantSlug') || '') || null;
      if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'اختر ملف Excel أو CSV' }, 400);
      const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer', cellDates: true });
      const rows = normalizeRows(workbook.Sheets[workbook.SheetNames[0]]);
      if (!rows.length) return json({ error: 'لم يتم العثور على بيانات مطابقة للنموذج' }, 400);
      if (rows.length > 10000) return json({ error: 'الحد الأقصى 10,000 عميل في الملف الواحد' }, 400);
      return json(await rpc(auth.token, 'operations_api_import_batch', {
        p_user_id: auth.user.id, p_tenant_slug: slug, p_file_name: file.name || 'customers.xlsx', p_rows: rows,
      }));
    }
    const body = await request.json().catch(() => ({}));
    const slug = tenantSlug(request, body);
    if (action === 'heartbeat') return json(await rpc(auth.token, 'operations_api_heartbeat', userArgs(auth.user, slug)));
    if (action === 'team') return json(await rpc(auth.token, 'operations_api_upsert_team', {
      p_user_id: auth.user.id, p_tenant_slug: slug, p_team_id: body.teamId || null, p_name: body.name, p_manager_user_id: body.managerUserId || null, p_member_ids: body.memberIds || [],
    }));
    if (action === 'distribute') return json(await rpc(auth.token, 'operations_api_distribute', {
      p_user_id: auth.user.id, p_batch_id: body.batchId, p_team_id: body.teamId, p_method: body.method, p_due_at: body.dueAt,
    }));
    if (action === 'task') return json(await rpc(auth.token, 'operations_api_create_task', {
      p_user_id: auth.user.id, p_tenant_slug: slug, p_title: body.title, p_description: body.description || null,
      p_assigned_to: body.assignedTo || null, p_starts_at: body.startsAt || null, p_due_at: body.dueAt,
      p_recurrence_type: body.recurrenceType || 'none', p_recurrence_interval: Number(body.recurrenceInterval || 1), p_recurrence_end_at: body.recurrenceEndAt || null,
    }));
    if (action === 'complete') return json(await rpc(auth.token, 'operations_api_complete_task', { p_user_id: auth.user.id, p_task_id: body.taskId }));
    return json({ error: 'الإجراء غير موجود' }, 404);
  } catch (error) { return json({ error: error.message || 'حدث خطأ' }, 500); }
}
