import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE, SUPABASE_KEY, SUPABASE_URL} from '../../../../lib/config';
import {trainingJson, trainingRpc} from '../../../../lib/training-server';
import {readTrainingBody, validTrainingId, trainingProblem, TRAINING_PILOT_SLUG} from '../../../../lib/training-request.mjs';
import {ACADEMY_MEDIA_BUCKET, academyMediaPayload, academyMediaError} from '../../../../lib/academy-media.mjs';

export const dynamic = 'force-dynamic';
const objectPath = value => value.split('/').map(encodeURIComponent).join('/');
async function storageRequest(path, token, body) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
      method:'POST', headers:{apikey:SUPABASE_KEY, Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
      body:JSON.stringify(body), cache:'no-store', redirect:'error', signal:AbortSignal.timeout(15000),
    });
  } catch { throw trainingProblem('network_unavailable', 503); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw trainingProblem('academy_media_not_ready', 502);
  return data;
}
async function session() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) throw trainingProblem('unauthenticated', 401);
  return token;
}
const failure = error => trainingJson({error:academyMediaError(error?.code), code:error?.code || 'request_failed'}, error?.status || 400);

export async function POST(request, {params}) {
  try {
    const {action} = await params;
    if (!['create_upload','complete_upload','set_download','cancel_upload'].includes(action)) throw trainingProblem('not_found', 404);
    const body = await readTrainingBody(request, {maxBytes:8192});
    if (body.tenantSlug !== TRAINING_PILOT_SLUG || !validTrainingId(body.commandId)) throw trainingProblem('invalid_request');
    const token = await session();
    const ticket = await trainingRpc('v1_academy_media_action', {p_slug:body.tenantSlug, p_action:action, p_command_id:body.commandId, p_payload:academyMediaPayload(action, body.payload)}, {token});
    if (action !== 'create_upload' || ticket.state !== 'pending') return trainingJson(ticket);
    if (ticket.bucket !== ACADEMY_MEDIA_BUCKET || !ticket.objectPath || !validTrainingId(ticket.assetId)) throw trainingProblem('request_failed', 502);
    const signed = await storageRequest(`object/upload/sign/${ACADEMY_MEDIA_BUCKET}/${objectPath(ticket.objectPath)}`, token, {});
    const url = new URL(signed.url, `${SUPABASE_URL}/storage/v1/`);
    const signature = url.searchParams.get('token');
    if (!signature || !url.pathname.includes('/object/upload/sign/')) throw trainingProblem('request_failed', 502);
    const endpoint = new URL('/storage/v1/upload/resumable', SUPABASE_URL);
    if (endpoint.hostname.endsWith('.supabase.co')) endpoint.hostname = endpoint.hostname.replace(/\.supabase\.co$/, '.storage.supabase.co');
    return trainingJson({...ticket, endpoint:endpoint.toString(), token:signature});
  } catch (error) { return failure(error); }
}

export async function GET(request, {params}) {
  try {
    const {action:assetId} = await params;
    const query = new URL(request.url).searchParams;
    if (!validTrainingId(assetId) || query.get('tenantSlug') !== TRAINING_PILOT_SLUG) throw trainingProblem('not_found', 404);
    const token = await session(), download = query.get('download') === '1';
    const asset = await trainingRpc('v1_academy_media_access', {p_slug:TRAINING_PILOT_SLUG, p_asset_id:assetId, p_download:download}, {token});
    if (query.get('info') === '1') return trainingJson({fileName:asset.fileName, allowDownload:asset.allowDownload});
    if (asset.bucket !== ACADEMY_MEDIA_BUCKET || !asset.objectPath) throw trainingProblem('request_failed', 502);
    const signed = await storageRequest(`object/sign/${ACADEMY_MEDIA_BUCKET}/${objectPath(asset.objectPath)}`, token, {expiresIn:300});
    const url = new URL(signed.signedURL, `${SUPABASE_URL}/storage/v1/`);
    // Storage returns /object/sign/... relative to /storage/v1, not the host root.
    if (url.pathname.startsWith('/object/sign/')) url.pathname = `/storage/v1${url.pathname}`;
    if (url.origin !== new URL(SUPABASE_URL).origin || !url.pathname.startsWith(`/storage/v1/object/sign/${ACADEMY_MEDIA_BUCKET}/`)) throw trainingProblem('request_failed', 502);
    if (download) url.searchParams.set('download', asset.fileName);
    return new NextResponse(null, {status:307, headers:{Location:url.toString(), 'Cache-Control':'private, no-store', 'CDN-Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff'}});
  } catch (error) { return failure(error); }
}
