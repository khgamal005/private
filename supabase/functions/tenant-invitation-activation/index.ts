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

function serviceHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json'
  };
}

function publicHeaders(publishableKey: string, accessToken?: string) {
  return {
    apikey: publishableKey,
    ...(accessToken ? {authorization: `Bearer ${accessToken}`} : {}),
    'content-type': 'application/json'
  };
}

function textValue(value: unknown) {
  return value == null ? '' : String(value).trim();
}

async function findUserByEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string
) {
  for (let page = 1; page <= 100; page += 1) {
    const listed = await requestJson(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=100`,
      {headers: serviceHeaders(serviceRoleKey)}
    );
    if (!listed.ok) throw new Error(`list_users_${listed.status}`);
    const users = Array.isArray(listed.data.users)
      ? listed.data.users as JsonRecord[]
      : [];
    const matched = users.find(
      user => textValue(user.email).toLowerCase() === email
    );
    if (matched) return matched;
    if (users.length < 100) return null;
  }
  throw new Error('user_lookup_limit');
}

async function activateAuthUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  invitation: JsonRecord,
  password: string
) {
  const email = textValue(invitation.email).toLowerCase();
  const existing = await findUserByEmail(
    supabaseUrl,
    serviceRoleKey,
    email
  );

  if (existing) {
    if (existing.email_confirmed_at || existing.confirmed_at) {
      return {ok: false, status: 409, code: 'account_already_exists'};
    }
    const updated = await requestJson(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(
        textValue(existing.id)
      )}`,
      {
        method: 'PUT',
        headers: serviceHeaders(serviceRoleKey),
        body: JSON.stringify({password, email_confirm: true})
      }
    );
    if (!updated.ok) {
      throw new Error(`update_invited_user_${updated.status}`);
    }
    return {ok: true, status: 200, code: 'confirmed_existing'};
  }

  const created = await requestJson(
    `${supabaseUrl}/auth/v1/admin/users`,
    {
      method: 'POST',
      headers: serviceHeaders(serviceRoleKey),
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: textValue(invitation.fullName)
        }
      })
    }
  );
  if (!created.ok) throw new Error(`create_invited_user_${created.status}`);
  return {ok: true, status: 201, code: 'created_confirmed'};
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
    if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
      return json({error: 'server_not_configured'}, 503);
    }

    const body = await request.json() as JsonRecord;
    const token = textValue(body.token);
    const password = textValue(body.password);
    if (token.length < 32) return json({error: 'invalid_invitation'}, 400);
    if (password.length < 10) {
      return json({error: 'weak_password'}, 400);
    }

    const preview = await requestJson(
      `${supabaseUrl}/rest/v1/rpc/v2_invitation_preview`,
      {
        method: 'POST',
        headers: publicHeaders(publishableKey),
        body: JSON.stringify({p_token: token})
      }
    );
    if (!preview.ok) {
      return json({
        error: textValue(
          preview.data.message || preview.data.detail
        ) || 'invalid_invitation'
      }, 400);
    }

    const authResult = await activateAuthUser(
      supabaseUrl,
      serviceRoleKey,
      preview.data,
      password
    );
    if (!authResult.ok) {
      return json({error: authResult.code}, authResult.status);
    }

    const signedIn = await requestJson(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: publicHeaders(publishableKey),
        body: JSON.stringify({
          email: textValue(preview.data.email).toLowerCase(),
          password
        })
      }
    );
    if (!signedIn.ok) throw new Error(`sign_in_${signedIn.status}`);

    const accessToken = textValue(signedIn.data.access_token);
    const accepted = await requestJson(
      `${supabaseUrl}/rest/v1/rpc/v2_accept_tenant_invitation`,
      {
        method: 'POST',
        headers: publicHeaders(publishableKey, accessToken),
        body: JSON.stringify({p_token: token})
      }
    );
    if (!accepted.ok) {
      return json({
        error: textValue(
          accepted.data.message || accepted.data.detail
        ) || 'invitation_accept_failed'
      }, 400);
    }

    return json({
      success: true,
      activation: authResult.code,
      invitation: accepted.data,
      session: {
        access_token: signedIn.data.access_token,
        refresh_token: signedIn.data.refresh_token,
        expires_in: signedIn.data.expires_in
      }
    });
  } catch (error) {
    return json({
      error: 'activation_failed',
      detail: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});
