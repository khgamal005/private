import {NextResponse} from 'next/server';
import {accessToken} from '../../../lib/server-auth';
import {SUPABASE_KEY, SUPABASE_URL} from '../../../lib/config';
import {diplomaError} from '../../../lib/diploma-contracts.mjs';

export const dynamic = 'force-dynamic';
const json = (body, status = 200) => NextResponse.json(body, {status, headers: {'Cache-Control': 'private, no-store'}});

export async function POST(request) {
  try {
    const token = await accessToken();
    if (!token) return json({error: diplomaError('authentication_required')}, 401);
    const body = await request.json();
    if (!body.tenantSlug || !body.courseId || !body.commandId || !['short_course', 'diploma'].includes(body.kind)) return json({error: 'راجع نوع البرنامج.'}, 400);
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/v1_tenant_classify_program`, {
      method: 'POST', headers: {apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({p_slug: body.tenantSlug, p_course_id: body.courseId, p_kind: body.kind, p_expected_kind: body.expectedKind || null, p_command_id: body.commandId}),
      cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) return json({error: diplomaError(String(data?.message || '').split('\n')[0])}, [401, 403].includes(response.status) ? response.status : 409);
    return json(data);
  } catch { return json({error: 'تعذر الاتصال. حاول مرة أخرى.'}, 503); }
}
