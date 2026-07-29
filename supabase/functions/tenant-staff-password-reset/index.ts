type JsonRecord = Record<string, unknown>;

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0'
};

function env(name: string) {
  return Deno.env.get(name)?.trim() || '';
}

function json(body: JsonRecord, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders
  });
}

function textValue(value: unknown) {
  return value == null ? '' : String(value).trim();
}

async function requestJson(
  url: string,
  init: RequestInit
): Promise<{ok: boolean; status: number; data: JsonRecord}> {
  const response = await fetch(url, init);
  const text = await response.text();
  let data: JsonRecord = {};
  if (text) {
    try {
      data = JSON.parse(text) as JsonRecord;
    } catch {
      data = {detail: text};
    }
  }
  return {ok: response.ok, status: response.status, data};
}

function headers(apiKey: string, token: string) {
  return {
    apikey: apiKey,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
}

async function rpc(
  supabaseUrl: string,
  name: string,
  body: JsonRecord,
  apiKey: string,
  token: string
) {
  return await requestJson(
    `${supabaseUrl}/rest/v1/rpc/${name}`,
    {
      method: 'POST',
      headers: headers(apiKey, token),
      body: JSON.stringify(body)
    }
  );
}

function pick(characters: string) {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return characters[buffer[0] % characters.length];
}

function temporaryPassword() {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!@#$%*-_'
  ];
  const all = groups.join('');
  const characters = groups.map(pick);
  while (characters.length < 18) characters.push(pick(all));
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const target = random[0] % (index + 1);
    [characters[index], characters[target]] = [
      characters[target],
      characters[index]
    ];
  }
  return characters.join('');
}

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return json({error: 'method_not_allowed'}, 405);
  }

  try {
    const supabaseUrl = env('SUPABASE_URL');
    const publishableKey =
      env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
    const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
    const authorization = request.headers.get('authorization') || '';
    const accessToken = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
      return json({error: 'server_not_configured'}, 503);
    }
    if (!accessToken) return json({error: 'session_expired'}, 401);

    const body = await request.json() as JsonRecord;
    const tenantSlug = textValue(body.p_tenant_slug);
    const staffId = textValue(body.p_staff_id);
    if (!tenantSlug || !staffId) {
      return json({error: 'incomplete_staff_data'}, 400);
    }

    const prepared = await rpc(
      supabaseUrl,
      'v2_tenant_prepare_staff_password_reset',
      {p_tenant_slug: tenantSlug, p_staff_id: staffId},
      publishableKey,
      accessToken
    );
    if (!prepared.ok) {
      return json({
        error: textValue(
          prepared.data.message || prepared.data.detail
        ) || 'password_reset_forbidden'
      }, prepared.status);
    }

    const password = temporaryPassword();
    const updated = await requestJson(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(
        textValue(prepared.data.targetAuthUserId)
      )}`,
      {
        method: 'PUT',
        headers: headers(serviceRoleKey, serviceRoleKey),
        body: JSON.stringify({password})
      }
    );
    if (!updated.ok) {
      return json({
        error: 'auth_password_update_failed',
        detail: updated.data
      }, updated.status);
    }

    const completed = await rpc(
      supabaseUrl,
      'v2_tenant_complete_staff_password_reset',
      {
        p_tenant_id: prepared.data.tenantId,
        p_staff_id: prepared.data.staffId,
        p_target_auth_user_id: prepared.data.targetAuthUserId,
        p_actor_subject_id: prepared.data.actorSubjectId
      },
      serviceRoleKey,
      serviceRoleKey
    );
    if (!completed.ok) {
      return json({
        error: 'security_log_completion_failed',
        detail: completed.data
      }, 500);
    }

    return json({
      success: true,
      data: {
        ...completed.data,
        temporaryPassword: password,
        shownOnce: true
      }
    });
  } catch (error) {
    return json({
      error: 'password_reset_failed',
      detail: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});
