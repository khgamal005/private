type JsonRecord = Record<string, unknown>;
const json = (body: JsonRecord, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}
});
const env = (key: string) => Deno.env.get(key)?.trim() || '';

Deno.serve(async request => {
  if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405);
  try {
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key || !serviceKey) return json({error: 'server_not_configured'}, 503);
    const authorization = request.headers.get('authorization') || '';
    if (!/^Bearer\s+\S+$/i.test(authorization)) return json({error: 'session_expired'}, 401);
    const body = await request.json();
    const password = body.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return json({error: 'weak_password'}, 400);
    }
    const args = {p_tenant_slug: body.p_tenant_slug, p_staff_id: body.p_staff_id};
    if (typeof args.p_tenant_slug !== 'string' || typeof args.p_staff_id !== 'string') {
      return json({error: 'incomplete_staff_data'}, 400);
    }
    const rpc = async (name: string, payload: JsonRecord) => {
      const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: {apikey: key, authorization, 'content-type': 'application/json'},
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
      });
      const data = await response.json().catch(() => ({}));
      return {ok: response.ok, status: response.status, data};
    };
    // User-scoped RPC verifies the JWT, exact tenant, staff record, hierarchy,
    // permissions, existing email and capacity before any service-role call.
    const prepared = await rpc('v1_tenant_prepare_staff_account', args);
    if (!prepared.ok) return json({error: prepared.data.message || 'forbidden'}, prepared.status);
    if (prepared.data.completed) return json({success: true, data: {...prepared.data, passwordUnchanged: true}});
    let passwordUnchanged = Boolean(prepared.data.authUserExists);
    if (!prepared.data.authUserExists) {
      const created = await fetch(`${url}/auth/v1/admin/users`, {
        method: 'POST', headers: {apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json'},
        body: JSON.stringify({
          email: prepared.data.email, password, email_confirm: true,
          user_metadata: {full_name: prepared.data.fullName},
          app_metadata: {staff_activation_id: prepared.data.operationId}
        }), signal: AbortSignal.timeout(15000)
      });
      if (!created.ok) {
        // Resolve a lost response/concurrent creation using the same durable
        // operation. Never PUT/reset an account found under the same email.
        const checked = await rpc('v1_tenant_prepare_staff_account', args);
        if (!checked.ok || !checked.data.authUserExists) {
          const details = await created.json().catch(() => ({}));
          return json({error: details.code === 'weak_password' ? 'weak_password' : 'account_creation_failed'}, 409);
        }
        passwordUnchanged = true;
      }
    }
    const completed = await rpc('v1_tenant_complete_staff_account', {
      ...args, p_operation_id: prepared.data.operationId
    });
    if (!completed.ok) return json({error: completed.data.message || 'activation_incomplete'}, completed.status);
    // No password or Auth session is returned to or stored in the manager UI.
    return json({success: true, data: {...completed.data, passwordUnchanged}});
  } catch {
    // A timed-out creation is resumed on the next explicit attempt, not reset.
    return json({error: 'activation_incomplete'}, 503);
  }
});
