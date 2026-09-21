import {NextResponse} from 'next/server';
import {accessToken} from '../../../lib/server-auth';
import {SUPABASE_KEY, SUPABASE_URL} from '../../../lib/config';
import {DIPLOMA_ACTIONS, diplomaError} from '../../../lib/diploma-contracts.mjs';

export const dynamic = 'force-dynamic';
const json = (body, status = 200) => NextResponse.json(body, {status, headers: {'Cache-Control': 'private, no-store'}});

async function rpc(name, args) {
  const token = await accessToken();
  if (!token) return json({error: diplomaError('authentication_required')}, 401);
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: {apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(args), cache: 'no-store', signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) return json({error: diplomaError(String(data?.message || '').split('\n')[0])}, [401, 403].includes(response.status) ? response.status : 409);
  return json(data);
}

export async function GET(request) {
  try {
    const query = new URL(request.url).searchParams;
    const slug = query.get('tenantSlug');
    if (!slug) return json({error: 'المنشأة مطلوبة.'}, 400);
    return await rpc('v1_tenant_diploma_snapshot', {p_slug: slug, p_contract_id: query.get('contractId') || null});
  } catch { return json({error: 'تعذر الاتصال. حاول مرة أخرى.'}, 503); }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body.tenantSlug || !DIPLOMA_ACTIONS.includes(body.action) || !body.commandId || !body.payload || Array.isArray(body.payload)) return json({error: 'بيانات العملية غير صالحة.'}, 400);
    return await rpc('v1_tenant_diploma_action', {p_slug: body.tenantSlug, p_action: body.action, p_command_id: body.commandId, p_payload: body.payload});
  } catch { return json({error: 'تعذر الاتصال. حاول مرة أخرى.'}, 503); }
}
