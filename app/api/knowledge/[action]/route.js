import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function tokenFromValue(input) {
  if (!input) return null;
  let value = input;
  try { value = decodeURIComponent(value); } catch {}
  try {
    const parsed = JSON.parse(value);
    const token = Array.isArray(parsed) ? parsed[0] : parsed?.access_token || parsed?.currentSession?.access_token;
    if (typeof token === 'string') return token;
  } catch {}
  return value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] || null;
}

function accessToken(request) {
  const direct = request.cookies.get('mt_access')?.value;
  if (direct) return direct;
  for (const cookie of request.cookies.getAll()) {
    const token = tokenFromValue(cookie.value);
    if (token) return token;
  }
  return null;
}

async function requirePlatformAccess(request){
  const token=accessToken(request);
  if(!token){
    const error=new Error('غير مصرح');
    error.status=401;
    throw error;
  }
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/current_user_context`,{
    method:'POST',
    headers:{apikey:PUBLISHABLE_KEY,authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:'{}',
    cache:'no-store'
  });
  const context=await response.json().catch(()=>null);
  if(!response.ok||!context?.platformAccess){
    const error=new Error('هذه العملية متاحة لمدير المنصة فقط');
    error.status=403;
    throw error;
  }
  return context;
}

async function rest(request, table, { method = 'GET', query = '', body, prefer = 'return=representation', requireAuth = false } = {}) {
  const token = accessToken(request);
  if (requireAuth && !token) {
    const error = new Error('غير مصرح');
    error.status = 401;
    throw error;
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method,
    headers: {
      apikey: PUBLISHABLE_KEY,
      authorization: `Bearer ${token || PUBLISHABLE_KEY}`,
      'content-type': 'application/json',
      prefer,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || 'تعذر تنفيذ الطلب');
    error.status = response.status;
    throw error;
  }
  return data;
}

const slugify = value => String(value || '')
  .trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/[^\u0600-\u06ffa-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 90) || `post-${Date.now()}`;

export async function GET(request, { params }) {
  try {
    const { action } = await params;
    const query = new URL(request.url).searchParams;
    if (action === 'feed') {
      const tenant = query.get('tenant') || '';
      const category = query.get('category') || '';
      const search = query.get('search') || '';
      let filter = 'select=*,knowledge_categories(id,name,slug)&status=eq.published&order=is_featured.desc,published_at.desc.nullslast,created_at.desc&limit=100';
      if (category) filter += `&category_id=eq.${encodeURIComponent(category)}`;
      if (search) filter += `&or=(title.ilike.*${encodeURIComponent(search)}*,excerpt.ilike.*${encodeURIComponent(search)}*)`;
      return json({ posts: await rest(request, 'knowledge_posts', { query: filter }) || [], tenant });
    }
    if (action === 'categories') {
      return json(await rest(request, 'knowledge_categories', { query: 'select=*&order=sort_order.asc,name.asc' }));
    }
    if (action === 'admin') {
      await requirePlatformAccess(request);
      const [posts, categories, sources] = await Promise.all([
        rest(request, 'knowledge_posts', { query: 'select=*,knowledge_categories(id,name,slug)&order=created_at.desc&limit=250', requireAuth: true }),
        rest(request, 'knowledge_categories', { query: 'select=*&order=sort_order.asc', requireAuth: true }),
        rest(request, 'knowledge_sources', { query: 'select=*&order=name.asc', requireAuth: true }),
      ]);
      return json({ posts, categories, sources });
    }
    return json({ error: 'الإجراء غير موجود' }, 404);
  } catch (error) {
    return json({ error: error.message || 'حدث خطأ' }, error.status || 500);
  }
}

export async function POST(request, { params }) {
  try {
    const { action } = await params;
    const body = await request.json().catch(() => ({}));
    if(['save','delete','category'].includes(action))await requirePlatformAccess(request);
    if (action === 'save') {
      const now = new Date().toISOString();
      const payload = {
        title: body.title,
        slug: body.slug || slugify(body.title),
        excerpt: body.excerpt || null,
        content: body.content || null,
        cover_image_url: body.coverImageUrl || null,
        category_id: body.categoryId || null,
        content_type: body.contentType || 'news',
        status: body.status || 'draft',
        source_name: body.sourceName || null,
        source_url: body.sourceUrl || null,
        is_featured: !!body.isFeatured,
        is_breaking: !!body.isBreaking,
        published_at: (body.status === 'published' ? (body.publishedAt || now) : body.publishedAt) || null,
        expires_at: body.expiresAt || null,
        tender_authority: body.tenderAuthority || null,
        tender_number: body.tenderNumber || null,
        tender_deadline: body.tenderDeadline || null,
        tender_region: body.tenderRegion || null,
        tender_value: body.tenderValue || null,
        tender_status: body.tenderStatus || null,
        tags: Array.isArray(body.tags) ? body.tags : [],
        target_roles: Array.isArray(body.targetRoles) ? body.targetRoles : [],
        target_tenants: Array.isArray(body.targetTenants) ? body.targetTenants : [],
        updated_at: now,
      };
      const rows = body.id
        ? await rest(request, 'knowledge_posts', { method: 'PATCH', query: `id=eq.${encodeURIComponent(body.id)}`, body: payload, requireAuth: true })
        : await rest(request, 'knowledge_posts', { method: 'POST', body: payload, requireAuth: true });
      return json({ post: Array.isArray(rows) ? rows[0] : rows });
    }
    if (action === 'delete') {
      await rest(request, 'knowledge_posts', { method: 'DELETE', query: `id=eq.${encodeURIComponent(body.id)}`, prefer: 'return=minimal', requireAuth: true });
      return json({ ok: true });
    }
    if (action === 'category') {
      const rows = await rest(request, 'knowledge_categories', {
        method: 'POST',
        body: { name: body.name, slug: body.slug || slugify(body.name), sort_order: Number(body.sortOrder || 0), is_active: true },
        requireAuth: true,
      });
      return json({ category: rows?.[0] });
    }
    return json({ error: 'الإجراء غير موجود' }, 404);
  } catch (error) {
    return json({ error: error.message || 'حدث خطأ' }, error.status || 500);
  }
}
