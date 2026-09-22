type JobChannel = 'whatsapp' | 'email' | 'zoom';
type JobType = string;

type AutomationJob = {
  queue?: 'training' | 'automation';
  id: string;
  tenantId: string;
  courseRunId?: string;
  sessionId?: string;
  enrollmentId?: string;
  type: JobType;
  channel: JobChannel;
  recipient?: string;
  subject?: string;
  messageText?: string;
  attempts: number;
  metadata: Record<string, unknown>;
  timezone?: string;
  session?: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    deliveryMode: string;
    instructorName?: string;
  };
  courseRun?: {
    id: string;
    title: string;
    courseName: string;
    runCode: string;
  };
};

type DeliveryResult = {
  state: 'sent' | 'ready' | 'simulated';
  externalId: string;
  externalUrl?: string;
  providerConnectionId?: string;
  providerKey?: string;
};

type TenantProvider = {
  connectionId: string;
  tenantId: string;
  channel: 'whatsapp' | 'email' | 'api';
  providerKey:
    | 'meta_whatsapp'
    | 'webhook_whatsapp'
    | 'resend'
    | 'amazon_ses'
    | 'webhook_email'
    | 'custom_webhook'
    | 'marktone_sandbox_whatsapp'
    | 'marktone_sandbox_email';
  displayName: string;
  publicConfig: Record<string, unknown>;
  secrets: Record<string, unknown>;
  templates: Record<string, {name?: string; locale?: string}>;
};

type TestAuthorization = {
  tenantId: string;
  connectionId: string;
  providerKey: TenantProvider['providerKey'];
  channel: TenantProvider['channel'];
};

type UsageReservation = {
  reservationId: string;
  status: 'reserved' | 'consumed';
  duplicate: boolean;
};

class ProviderConfigurationError extends Error {}

const jsonHeaders = {'content-type': 'application/json; charset=utf-8'};
const encoder = new TextEncoder();

function env(name: string) {
  return Deno.env.get(name)?.trim() || '';
}

function configured(values: string[]) {
  return values.every(Boolean);
}

function textValue(
  values: Record<string, unknown>,
  key: string,
  fallback = ''
) {
  const value = values[key];
  return value == null ? fallback : String(value).trim();
}

function legacyProviderConfiguration() {
  const whatsapp = {
    token: env('META_WHATSAPP_TOKEN'),
    phoneNumberId: env('META_WHATSAPP_PHONE_NUMBER_ID'),
    apiVersion: env('META_WHATSAPP_API_VERSION') || 'v25.0',
    joiningTemplate: env('META_WHATSAPP_JOINING_TEMPLATE'),
    reminderTemplate: env('META_WHATSAPP_REMINDER_TEMPLATE'),
    languageCode: env('META_WHATSAPP_LANGUAGE_CODE') || 'ar'
  };
  const email = {
    apiKey: env('RESEND_API_KEY'),
    from: env('RESEND_FROM')
  };
  const zoom = {
    accountId: env('ZOOM_ACCOUNT_ID'),
    clientId: env('ZOOM_CLIENT_ID'),
    clientSecret: env('ZOOM_CLIENT_SECRET'),
    userId: env('ZOOM_USER_ID') || 'me'
  };

  return {
    whatsapp: {
      ...whatsapp,
      ready: configured([
        whatsapp.token,
        whatsapp.phoneNumberId,
        whatsapp.joiningTemplate,
        whatsapp.reminderTemplate
      ])
    },
    email: {
      ...email,
      ready: configured([email.apiKey, email.from])
    },
    zoom: {
      ...zoom,
      ready: configured([
        zoom.accountId,
        zoom.clientId,
        zoom.clientSecret
      ])
    }
  };
}

async function rpc<T>(
  supabaseUrl: string,
  serviceRoleKey: string,
  name: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`automation_rpc_${name}_${response.status}`);
  }
  return await response.json() as T;
}

async function rpcAsUser<T>(
  supabaseUrl: string,
  serviceRoleKey: string,
  accessToken: string,
  name: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.text();
  if (!response.ok) {
    let code = 'integration_test_not_authorized';
    try {
      code = JSON.parse(payload)?.message || code;
    } catch {
      // Keep the sanitized fallback.
    }
    throw new ProviderConfigurationError(code);
  }
  return JSON.parse(payload) as T;
}

function usageSpec(job: AutomationJob) {
  if (job.channel === 'whatsapp') {
    return {
      featureKey: 'addon.integration.whatsapp',
      metricKey: 'whatsapp_messages'
    };
  }
  if (job.channel === 'email') {
    return {
      featureKey: 'addon.integration.email',
      metricKey: 'email_messages'
    };
  }
  if (job.channel === 'zoom') {
    return {
      featureKey: 'addon.integration.zoom',
      metricKey: 'zoom_meetings'
    };
  }
  return null;
}

async function reserveUsage(
  job: AutomationJob,
  automationSecret: string,
  supabaseUrl: string,
  serviceRoleKey: string
) {
  const spec = usageSpec(job);
  if (!spec) return null;
  return await rpc<UsageReservation>(
    supabaseUrl,
    serviceRoleKey,
    'v2_addon_usage_reserve',
    {
      p_secret: automationSecret,
      p_tenant_id: job.tenantId,
      p_feature_key: spec.featureKey,
      p_metric_key: spec.metricKey,
      p_idempotency_key: `dispatch:${job.queue || 'training'}:${job.id}`,
      p_source_type: job.queue || 'training',
      p_source_id: job.id,
      p_quantity: 1
    }
  );
}

function templateValues(job: AutomationJob) {
  const metadata = job.metadata || {};
  const value = (key: string, fallback = '—') =>
    String(metadata[key] || fallback).slice(0, 900);
  const configuredValues =
    metadata.templateValues
    && typeof metadata.templateValues === 'object'
    && !Array.isArray(metadata.templateValues)
      ? metadata.templateValues as Record<string, unknown>
      : null;

  if (configuredValues) {
    const orderedKeys = [
      'name',
      'course',
      'batch',
      'session',
      'date',
      'time',
      'link',
      'amount',
      'certificate_number',
      'certificate_link',
      'center'
    ];
    return orderedKeys
      .filter(key => configuredValues[key] != null)
      .map(key => String(configuredValues[key]).slice(0, 900));
  }

  if (job.type === 'joining_instructions') {
    return [
      value('studentName'),
      value('courseName', job.courseRun?.courseName),
      value('runName', job.courseRun?.title),
      value('startDate'),
      value('venueOrLink')
    ];
  }
  return [
    value('studentName'),
    value('courseName', job.courseRun?.courseName),
    value('sessionTitle', job.session?.title),
    value('startDate'),
    value('venueOrLink')
  ];
}

function tenantTemplate(
  provider: TenantProvider,
  job: AutomationJob
) {
  const template = provider.templates?.[job.type] || {};
  const publicConfig = provider.publicConfig || {};
  const fallbackName = job.type.startsWith('zoom_') ? '' : job.type === 'joining_instructions'
    ? textValue(publicConfig, 'joiningTemplate')
    : textValue(publicConfig, 'reminderTemplate');
  return {
    name: textValue(template, 'name', fallbackName),
    locale: textValue(
      template,
      'locale',
      textValue(publicConfig, 'languageCode', 'ar')
    )
  };
}

async function sendMetaWhatsApp(
  job: AutomationJob,
  provider: TenantProvider
): Promise<DeliveryResult> {
  const config = provider.publicConfig || {};
  const secrets = provider.secrets || {};
  const token = textValue(secrets, 'accessToken');
  const phoneNumberId = textValue(config, 'phoneNumberId');
  const apiVersion = textValue(config, 'apiVersion', 'v25.0');
  const template = tenantTemplate(provider, job);
  if (!configured([token, phoneNumberId, template.name])) {
    throw new ProviderConfigurationError(
      'whatsapp_credentials_or_template_missing'
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(apiVersion)}/`
      + `${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: job.recipient,
        type: 'template',
        template: {
          name: template.name,
          language: {code: template.locale},
          components: [{
            type: 'body',
            parameters: templateValues(job).map(text => ({
              type: 'text',
              text
            }))
          }]
        }
      })
    }
  );
  if (!response.ok) {
    throw new Error(`whatsapp_request_failed_${response.status}`);
  }
  const payload = await response.json() as {
    messages?: Array<{id?: string}>;
  };
  const externalId = payload.messages?.[0]?.id;
  if (!externalId) throw new Error('whatsapp_response_missing_message_id');
  return {state: 'sent', externalId};
}

async function sendLegacyWhatsApp(
  job: AutomationJob,
  config: ReturnType<
    typeof legacyProviderConfiguration
  >['whatsapp']
): Promise<DeliveryResult> {
  if (!config.ready) {
    throw new ProviderConfigurationError('whatsapp_not_configured');
  }
  const templateName = job.type === 'joining_instructions'
    ? config.joiningTemplate
    : config.reminderTemplate;
  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/`
      + `${encodeURIComponent(config.phoneNumberId)}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: job.recipient,
        type: 'template',
        template: {
          name: templateName,
          language: {code: config.languageCode},
          components: [{
            type: 'body',
            parameters: templateValues(job).map(text => ({
              type: 'text',
              text
            }))
          }]
        }
      })
    }
  );
  if (!response.ok) {
    throw new Error(`whatsapp_request_failed_${response.status}`);
  }
  const payload = await response.json() as {
    messages?: Array<{id?: string}>;
  };
  const externalId = payload.messages?.[0]?.id;
  if (!externalId) throw new Error('whatsapp_response_missing_message_id');
  return {state: 'sent', externalId};
}

function emailSender(config: Record<string, unknown>) {
  const fromEmail = textValue(config, 'fromEmail');
  const fromName = textValue(config, 'fromName');
  return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
}

async function sendResend(
  job: AutomationJob,
  provider: TenantProvider
): Promise<DeliveryResult> {
  const config = provider.publicConfig || {};
  const apiKey = textValue(provider.secrets || {}, 'apiKey');
  const from = emailSender(config);
  if (!configured([apiKey, from])) {
    throw new ProviderConfigurationError('resend_not_configured');
  }
  const body: Record<string, unknown> = {
    from,
    to: [job.recipient],
    subject: job.subject || 'تنبيه البرنامج التدريبي',
    text: job.messageText || ''
  };
  const replyTo = textValue(config, 'replyTo');
  if (replyTo) body.reply_to = replyTo;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'Idempotency-Key': `odeir-training-${job.tenantId}-${job.id}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`resend_request_failed_${response.status}`);
  }
  const payload = await response.json() as {id?: string};
  if (!payload.id) throw new Error('resend_response_missing_email_id');
  return {state: 'sent', externalId: payload.id};
}

async function sendLegacyEmail(
  job: AutomationJob,
  config: ReturnType<typeof legacyProviderConfiguration>['email']
): Promise<DeliveryResult> {
  if (!config.ready) {
    throw new ProviderConfigurationError('email_not_configured');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: config.from,
      to: [job.recipient],
      subject: job.subject || 'تنبيه البرنامج التدريبي',
      text: job.messageText || ''
    })
  });
  if (!response.ok) {
    throw new Error(`resend_request_failed_${response.status}`);
  }
  const payload = await response.json() as {id?: string};
  if (!payload.id) throw new Error('resend_response_missing_email_id');
  return {state: 'sent', externalId: payload.id};
}

function hex(bytes: Uint8Array) {
  return [...bytes]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return hex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array | string, value: string) {
  const rawKey = typeof key === 'string' ? encoder.encode(key) : key;
  const keyBuffer = Uint8Array.from(rawKey).buffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(value)
  );
  return new Uint8Array(signature);
}

async function signedSesRequest(
  provider: TenantProvider,
  method: 'GET' | 'POST',
  path: string,
  payload?: Record<string, unknown>
) {
  const config = provider.publicConfig || {};
  const secrets = provider.secrets || {};
  const region = textValue(config, 'region', 'eu-west-1');
  const accessKeyId = textValue(secrets, 'accessKeyId');
  const secretAccessKey = textValue(secrets, 'secretAccessKey');
  const sessionToken = textValue(secrets, 'sessionToken');
  if (!configured([region, accessKeyId, secretAccessKey])) {
    throw new ProviderConfigurationError('amazon_ses_not_configured');
  }

  const host = `email.${region}.amazonaws.com`;
  const body = payload ? JSON.stringify(payload) : '';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host,
    'x-amz-date': amzDate
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map(key => `${key}:${headers[key].trim()}`)
    .join('\n') + '\n';
  const signedHeaders = signedHeaderNames.join(';');
  const payloadHash = await sha256(body);
  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  const scope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256(canonicalRequest)
  ].join('\n');
  const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, 'ses');
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = hex(await hmac(signingKey, stringToSign));
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-amz-date': amzDate,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
  if (sessionToken) {
    requestHeaders['x-amz-security-token'] = sessionToken;
  }

  return await fetch(`https://${host}${path}`, {
    method,
    headers: requestHeaders,
    body: method === 'POST' ? body : undefined
  });
}

async function sendAmazonSes(
  job: AutomationJob,
  provider: TenantProvider
): Promise<DeliveryResult> {
  const config = provider.publicConfig || {};
  const fromEmail = textValue(config, 'fromEmail');
  if (!fromEmail) {
    throw new ProviderConfigurationError('amazon_ses_sender_missing');
  }
  const request: Record<string, unknown> = {
    FromEmailAddress: fromEmail,
    Destination: {ToAddresses: [job.recipient]},
    Content: {
      Simple: {
        Subject: {
          Data: job.subject || 'تنبيه البرنامج التدريبي',
          Charset: 'UTF-8'
        },
        Body: {
          Text: {
            Data: job.messageText || '',
            Charset: 'UTF-8'
          }
        }
      }
    }
  };
  const replyTo = textValue(config, 'replyTo');
  const configurationSet = textValue(config, 'configurationSet');
  if (replyTo) request.ReplyToAddresses = [replyTo];
  if (configurationSet) request.ConfigurationSetName = configurationSet;

  const response = await signedSesRequest(
    provider,
    'POST',
    '/v2/email/outbound-emails',
    request
  );
  if (!response.ok) {
    throw new Error(`amazon_ses_request_failed_${response.status}`);
  }
  const payload = await response.json() as {MessageId?: string};
  if (!payload.MessageId) {
    throw new Error('amazon_ses_response_missing_message_id');
  }
  return {state: 'sent', externalId: payload.MessageId};
}

function safeWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderConfigurationError('webhook_url_invalid');
  }
  const host = url.hostname.toLowerCase();
  const privateIpv4 =
    /^(10|127|0)\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
  if (
    url.protocol !== 'https:'
    || !host.includes('.')
    || privateIpv4
    || host === 'localhost'
    || host === '::1'
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) {
    throw new ProviderConfigurationError('webhook_https_public_url_required');
  }
  return url;
}

async function webhookHeaders(
  provider: TenantProvider,
  body: string
) {
  const config = provider.publicConfig || {};
  const secrets = provider.secrets || {};
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-marktone-event': textValue(
      config,
      'eventName',
      'marktone.message'
    )
  };
  const token = textValue(secrets, 'authToken');
  if (token) {
    const header = textValue(config, 'authHeader', 'Authorization');
    const scheme = textValue(config, 'authScheme', 'Bearer');
    headers[header] = scheme === 'Raw' ? token : `Bearer ${token}`;
  }
  const signatureSecret = textValue(secrets, 'signatureSecret');
  if (signatureSecret) {
    headers['x-marktone-signature'] =
      `sha256=${hex(await hmac(signatureSecret, body))}`;
  }
  return headers;
}

async function sendWebhook(
  job: AutomationJob,
  provider: TenantProvider
): Promise<DeliveryResult> {
  const endpoint = safeWebhookUrl(
    textValue(provider.publicConfig || {}, 'endpoint')
  );
  const body = JSON.stringify({
    event: textValue(
      provider.publicConfig || {},
      'eventName',
      `marktone.${job.type}`
    ),
    provider: provider.providerKey,
    tenantId: job.tenantId,
    jobId: job.id,
    channel: job.channel,
    recipient: job.recipient,
    subject: job.subject,
    message: job.messageText,
    variables: job.metadata,
    courseRun: job.courseRun,
    session: job.session || null,
    sentAt: new Date().toISOString()
  });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: await webhookHeaders(provider, body),
    body
  });
  if (!response.ok) {
    throw new Error(`webhook_request_failed_${response.status}`);
  }
  const externalId =
    response.headers.get('x-request-id')
    || response.headers.get('x-message-id')
    || crypto.randomUUID();
  return {state: 'sent', externalId};
}

async function sendSandbox(
  job: AutomationJob,
  provider: TenantProvider,
  supabaseUrl: string
): Promise<DeliveryResult> {
  const token = textValue(provider.secrets || {}, 'sandboxToken');
  if (!token) {
    throw new ProviderConfigurationError('sandbox_token_missing');
  }
  const externalId = `sandbox-${crypto.randomUUID()}`;
  const response = await fetch(
    `${supabaseUrl}/functions/v1/training-automation-dispatch`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-marktone-sandbox-token': token
      },
      body: JSON.stringify({
        action: 'sandbox_receive',
        connectionId: provider.connectionId,
        payload: {
          event: `marktone.${job.type}`,
          queue: job.queue || 'training',
          externalId,
          jobId: job.id,
          jobType: job.type,
          recipient: job.recipient,
          subject: job.subject,
          message: job.messageText
        }
      })
    }
  );
  if (!response.ok) {
    throw new Error(`sandbox_gateway_failed_${response.status}`);
  }
  const payload = await response.json() as {externalId?: string};
  return {
    state: 'simulated',
    externalId: payload.externalId || externalId,
    providerConnectionId: provider.connectionId,
    providerKey: provider.providerKey
  };
}

let zoomToken: string | null = null;

async function zoomAccessToken(
  config: ReturnType<typeof legacyProviderConfiguration>['zoom']
) {
  if (!config.ready) {
    throw new ProviderConfigurationError('zoom_not_configured');
  }
  if (zoomToken) return zoomToken;
  const basic = btoa(`${config.clientId}:${config.clientSecret}`);
  const tokenUrl = new URL('https://zoom.us/oauth/token');
  tokenUrl.searchParams.set('grant_type', 'account_credentials');
  tokenUrl.searchParams.set('account_id', config.accountId);
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {authorization: `Basic ${basic}`}
  });
  if (!response.ok) {
    throw new Error(`zoom_oauth_failed_${response.status}`);
  }
  const payload = await response.json() as {access_token?: string};
  if (!payload.access_token) {
    throw new Error('zoom_oauth_response_missing_token');
  }
  zoomToken = payload.access_token;
  return zoomToken;
}

async function createZoomMeeting(
  job: AutomationJob,
  config: ReturnType<typeof legacyProviderConfiguration>['zoom']
): Promise<DeliveryResult> {
  if (!job.session || !job.courseRun) {
    throw new Error('zoom_job_missing_session');
  }
  const token = await zoomAccessToken(config);
  const startsAt = new Date(job.session.startsAt);
  const endsAt = new Date(job.session.endsAt);
  const duration = Math.max(
    1,
    Math.ceil((endsAt.getTime() - startsAt.getTime()) / 60000)
  );
  const response = await fetch(
    `https://api.zoom.us/v2/users/${encodeURIComponent(config.userId)}/meetings`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        topic: `${job.courseRun.title} — ${job.session.title}`,
        agenda: `${job.courseRun.courseName} · ${job.courseRun.runCode}`,
        type: 2,
        start_time: startsAt.toISOString(),
        duration,
        timezone: job.timezone || 'UTC',
        settings: {
          host_video: false,
          participant_video: false,
          join_before_host: false,
          mute_upon_entry: true,
          waiting_room: true,
          auto_recording: 'none'
        }
      })
    }
  );
  if (!response.ok) {
    throw new Error(`zoom_meeting_request_failed_${response.status}`);
  }
  const payload = await response.json() as {
    id?: number | string;
    join_url?: string;
  };
  if (!payload.id || !payload.join_url) {
    throw new Error('zoom_response_missing_meeting_details');
  }
  return {
    state: 'ready',
    externalId: String(payload.id),
    externalUrl: payload.join_url
  };
}

async function tenantProvider(
  supabaseUrl: string,
  serviceRoleKey: string,
  tenantId: string,
  channel: 'whatsapp' | 'email'
) {
  try {
    return await rpc<TenantProvider | null>(
      supabaseUrl,
      serviceRoleKey,
      'v2_integration_provider_configuration',
      {
        p_tenant_id: tenantId,
        p_channel: channel,
        p_connection_id: null,
        p_include_draft: false
      }
    );
  } catch {
    // Backward-compatible fallback while beta.14 is being rolled out.
    return null;
  }
}

async function deliver(
  job: AutomationJob,
  supabaseUrl: string,
  serviceRoleKey: string,
  legacy: ReturnType<typeof legacyProviderConfiguration>
) {
  let managedZoom = false;
  if (job.queue !== 'automation' && job.sessionId) {
    const check = await rpc(supabaseUrl, serviceRoleKey, 'v1_zoom_message_check', {p_job_id: job.id}) as {managed?: boolean; allowed?: boolean; reason?: string; job?: Partial<AutomationJob>};
    managedZoom = check.managed === true;
    if (managedZoom && !check.allowed) throw new ProviderConfigurationError(check.reason || 'zoom_message_not_eligible');
    if (managedZoom && check.job) job = {...job, ...check.job};
  }
  if (job.channel === 'zoom') {
    return await createZoomMeeting(job, legacy.zoom);
  }

  const provider = await tenantProvider(
    supabaseUrl,
    serviceRoleKey,
    job.tenantId,
    job.channel
  );
  if (!provider) {
    if (managedZoom) throw new ProviderConfigurationError('tenant_provider_required');
    return job.channel === 'whatsapp'
      ? await sendLegacyWhatsApp(job, legacy.whatsapp)
      : await sendLegacyEmail(job, legacy.email);
  }

  if (provider.providerKey === 'meta_whatsapp') {
    return {
      ...await sendMetaWhatsApp(job, provider),
      providerConnectionId: provider.connectionId,
      providerKey: provider.providerKey
    };
  }
  if (provider.providerKey === 'resend') {
    return {
      ...await sendResend(job, provider),
      providerConnectionId: provider.connectionId,
      providerKey: provider.providerKey
    };
  }
  if (provider.providerKey === 'amazon_ses') {
    return {
      ...await sendAmazonSes(job, provider),
      providerConnectionId: provider.connectionId,
      providerKey: provider.providerKey
    };
  }
  if (
    provider.providerKey === 'webhook_whatsapp'
    || provider.providerKey === 'webhook_email'
  ) {
    return {
      ...await sendWebhook(job, provider),
      providerConnectionId: provider.connectionId,
      providerKey: provider.providerKey
    };
  }
  if (
    provider.providerKey === 'marktone_sandbox_whatsapp'
    || provider.providerKey === 'marktone_sandbox_email'
  ) {
    return await sendSandbox(job, provider, supabaseUrl);
  }
  throw new ProviderConfigurationError('provider_not_supported_for_channel');
}

async function testProvider(
  provider: TenantProvider,
  supabaseUrl: string
) {
  if (provider.providerKey === 'meta_whatsapp') {
    const config = provider.publicConfig || {};
    const token = textValue(provider.secrets || {}, 'accessToken');
    const phoneNumberId = textValue(config, 'phoneNumberId');
    const version = textValue(config, 'apiVersion', 'v25.0');
    if (!configured([token, phoneNumberId])) {
      throw new ProviderConfigurationError(
        'whatsapp_credentials_missing'
      );
    }
    const url = new URL(
      `https://graph.facebook.com/${encodeURIComponent(version)}/`
        + encodeURIComponent(phoneNumberId)
    );
    url.searchParams.set('fields', 'display_phone_number,verified_name');
    const response = await fetch(url, {
      headers: {authorization: `Bearer ${token}`}
    });
    if (!response.ok) {
      throw new Error(`whatsapp_connection_test_failed_${response.status}`);
    }
    const payload = await response.json() as {
      display_phone_number?: string;
      verified_name?: string;
    };
    return payload.verified_name
      || payload.display_phone_number
      || 'whatsapp_connection_ready';
  }

  if (provider.providerKey === 'resend') {
    const apiKey = textValue(provider.secrets || {}, 'apiKey');
    const from = textValue(provider.publicConfig || {}, 'fromEmail');
    if (!configured([apiKey, from])) {
      throw new ProviderConfigurationError('resend_configuration_missing');
    }
    const response = await fetch('https://api.resend.com/domains', {
      headers: {authorization: `Bearer ${apiKey}`}
    });
    if (!response.ok) {
      throw new Error(`resend_connection_test_failed_${response.status}`);
    }
    return 'resend_connection_ready';
  }

  if (provider.providerKey === 'amazon_ses') {
    const from = textValue(provider.publicConfig || {}, 'fromEmail');
    if (!from) {
      throw new ProviderConfigurationError('amazon_ses_sender_missing');
    }
    const response = await signedSesRequest(
      provider,
      'GET',
      '/v2/email/account'
    );
    if (!response.ok) {
      throw new Error(`amazon_ses_connection_test_failed_${response.status}`);
    }
    return 'amazon_ses_connection_ready';
  }

  if (
    provider.providerKey === 'webhook_whatsapp'
    || provider.providerKey === 'webhook_email'
    || provider.providerKey === 'custom_webhook'
  ) {
    const endpoint = safeWebhookUrl(
      textValue(provider.publicConfig || {}, 'endpoint')
    );
    const body = JSON.stringify({
      event: 'marktone.integration.test',
      connectionId: provider.connectionId,
      channel: provider.channel,
      testedAt: new Date().toISOString()
    });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: await webhookHeaders(provider, body),
      body
    });
    if (!response.ok) {
      throw new Error(`webhook_connection_test_failed_${response.status}`);
    }
    return 'webhook_connection_ready';
  }

  if (
    provider.providerKey === 'marktone_sandbox_whatsapp'
    || provider.providerKey === 'marktone_sandbox_email'
  ) {
    const token = textValue(provider.secrets || {}, 'sandboxToken');
    if (!token) {
      throw new ProviderConfigurationError('sandbox_token_missing');
    }
    const response = await fetch(
      `${supabaseUrl}/functions/v1/training-automation-dispatch`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-marktone-sandbox-token': token
        },
        body: JSON.stringify({
          action: 'sandbox_receive',
          connectionId: provider.connectionId,
          payload: {
            event: 'marktone.integration.test',
            externalId: `sandbox-test-${crypto.randomUUID()}`
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(`sandbox_connection_test_failed_${response.status}`);
    }
    return 'sandbox_gateway_ready_no_customer_delivery';
  }

  throw new ProviderConfigurationError('integration_provider_not_supported');
}

async function handleConnectionTest(
  request: Request,
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceRoleKey: string
) {
  const authorization = request.headers.get('authorization') || '';
  const accessToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';
  const tenantSlug = textValue(body, 'tenantSlug');
  const connectionId = textValue(body, 'connectionId');
  if (!accessToken || !tenantSlug || !connectionId) {
    return new Response(
      JSON.stringify({error: 'integration_test_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }

  let authorized: TestAuthorization;
  try {
    authorized = await rpcAsUser<TestAuthorization>(
      supabaseUrl,
      serviceRoleKey,
      accessToken,
      'v2_tenant_integration_test_authorize',
      {
        p_tenant_slug: tenantSlug,
        p_connection_id: connectionId
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error
          ? error.message
          : 'integration_test_not_authorized'
      }),
      {status: 403, headers: jsonHeaders}
    );
  }

  const provider = await rpc<TenantProvider | null>(
    supabaseUrl,
    serviceRoleKey,
    'v2_integration_provider_configuration',
    {
      p_tenant_id: authorized.tenantId,
      p_channel: authorized.channel,
      p_connection_id: authorized.connectionId,
      p_include_draft: true
    }
  );
  if (!provider) {
    await rpc(
      supabaseUrl,
      serviceRoleKey,
      'v2_integration_test_complete',
      {
        p_connection_id: authorized.connectionId,
        p_state: 'error',
        p_detail: 'integration_configuration_missing'
      }
    );
    return new Response(
      JSON.stringify({error: 'integration_configuration_missing'}),
      {status: 422, headers: jsonHeaders}
    );
  }

  try {
    const detail = await testProvider(provider, supabaseUrl);
    await rpc(
      supabaseUrl,
      serviceRoleKey,
      'v2_integration_test_complete',
      {
        p_connection_id: provider.connectionId,
        p_state: 'ready',
        p_detail: String(detail).slice(0, 240)
      }
    );
    return new Response(
      JSON.stringify({
        success: true,
        state: 'ready',
        detail
      }),
      {status: 200, headers: jsonHeaders}
    );
  } catch (error) {
    const detail = error instanceof Error
      ? error.message.slice(0, 240)
      : 'connection_test_failed';
    await rpc(
      supabaseUrl,
      serviceRoleKey,
      'v2_integration_test_complete',
      {
        p_connection_id: provider.connectionId,
        p_state: 'error',
        p_detail: detail
      }
    );
    return new Response(
      JSON.stringify({error: detail, state: 'error'}),
      {status: 422, headers: jsonHeaders}
    );
  }
}

async function handleSandboxReceive(
  request: Request,
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceRoleKey: string
) {
  const token =
    request.headers.get('x-marktone-sandbox-token')?.trim() || '';
  const connectionId = textValue(body, 'connectionId');
  const payload = body.payload;
  if (
    !token
    || !connectionId
    || !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
  ) {
    return new Response(
      JSON.stringify({error: 'sandbox_gateway_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }
  try {
    const result = await rpc<{
      receiptId: string;
      externalId: string;
      state: string;
    }>(
      supabaseUrl,
      serviceRoleKey,
      'v2_sandbox_delivery_receive',
      {
        p_connection_id: connectionId,
        p_token: token,
        p_payload: payload as Record<string, unknown>
      }
    );
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: jsonHeaders
    });
  } catch {
    return new Response(
      JSON.stringify({error: 'sandbox_gateway_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }
}

async function handleSandboxSelfTest(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceRoleKey: string
) {
  const connectionId = textValue(body, 'connectionId');
  if (!connectionId) {
    return new Response(
      JSON.stringify({error: 'integration_connection_not_found'}),
      {status: 422, headers: jsonHeaders}
    );
  }
  const provider = await rpc<TenantProvider | null>(
    supabaseUrl,
    serviceRoleKey,
    'v2_integration_provider_configuration',
    {
      p_tenant_id: body.tenantId,
      p_channel: body.channel,
      p_connection_id: connectionId,
      p_include_draft: true
    }
  );
  if (
    !provider
    || ![
      'marktone_sandbox_whatsapp',
      'marktone_sandbox_email'
    ].includes(provider.providerKey)
  ) {
    return new Response(
      JSON.stringify({error: 'integration_configuration_missing'}),
      {status: 422, headers: jsonHeaders}
    );
  }
  try {
    const detail = await testProvider(provider, supabaseUrl);
    await rpc(
      supabaseUrl,
      serviceRoleKey,
      'v2_integration_test_complete',
      {
        p_connection_id: provider.connectionId,
        p_state: 'ready',
        p_detail: detail
      }
    );
    return new Response(JSON.stringify({
      success: true,
      state: 'ready',
      detail
    }), {status: 200, headers: jsonHeaders});
  } catch (error) {
    const detail = error instanceof Error
      ? error.message.slice(0, 240)
      : 'connection_test_failed';
    await rpc(
      supabaseUrl,
      serviceRoleKey,
      'v2_integration_test_complete',
      {
        p_connection_id: provider.connectionId,
        p_state: 'error',
        p_detail: detail
      }
    );
    return new Response(
      JSON.stringify({error: detail, state: 'error'}),
      {status: 422, headers: jsonHeaders}
    );
  }
}

async function handleDeliveryWebhook(
  request: Request,
  body: Record<string, unknown>,
  rawBody: string,
  supabaseUrl: string,
  serviceRoleKey: string
) {
  const webhookId = textValue(body, 'webhookId');
  const timestamp =
    request.headers.get('x-marktone-timestamp')?.trim() || '';
  const signature =
    request.headers.get('x-marktone-signature')?.trim() || '';
  if (!webhookId || !timestamp || !signature || !rawBody) {
    return new Response(
      JSON.stringify({error: 'delivery_webhook_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }
  try {
    const result = await rpc<{
      eventId: string;
      state: string;
      duplicate: boolean;
      matched: boolean;
    }>(
      supabaseUrl,
      serviceRoleKey,
      'v2_delivery_webhook_receive',
      {
        p_webhook_id: webhookId,
        p_timestamp: timestamp,
        p_signature: signature,
        p_raw_body: rawBody
      }
    );
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: jsonHeaders
    });
  } catch {
    return new Response(
      JSON.stringify({error: 'delivery_webhook_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }
}

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({error: 'method_not_allowed'}),
      {status: 405, headers: jsonHeaders}
    );
  }

  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({error: 'dispatcher_not_configured'}),
      {status: 503, headers: jsonHeaders}
    );
  }

  let rawBody = '';
  let body: Record<string, unknown> = {};
  try {
    rawBody = await request.text();
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    // Cron calls may provide no useful payload.
  }

  if (body.action === 'test_connection') {
    return await handleConnectionTest(
      request,
      body,
      supabaseUrl,
      serviceRoleKey
    );
  }

  if (body.action === 'sandbox_receive') {
    return await handleSandboxReceive(
      request,
      body,
      supabaseUrl,
      serviceRoleKey
    );
  }

  if (body.action === 'delivery_webhook') {
    return await handleDeliveryWebhook(
      request,
      body,
      rawBody,
      supabaseUrl,
      serviceRoleKey
    );
  }

  const automationSecret =
    request.headers.get('x-marktone-automation-secret')?.trim() || '';
  if (!automationSecret) {
    return new Response(
      JSON.stringify({error: 'dispatcher_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }

  if (body.action === 'sandbox_self_test') {
    return await handleSandboxSelfTest(
      body,
      supabaseUrl,
      serviceRoleKey
    );
  }

  let jobs: AutomationJob[];
  try {
    const [trainingJobs, automationJobs] = await Promise.all([
      rpc<AutomationJob[]>(
        supabaseUrl,
        serviceRoleKey,
        'v2_training_automation_claim_jobs',
        {p_secret: automationSecret, p_limit: 20}
      ),
      rpc<AutomationJob[]>(
        supabaseUrl,
        serviceRoleKey,
        'v2_automation_claim_messages',
        {p_secret: automationSecret, p_limit: 20}
      )
    ]);
    jobs = [
      ...trainingJobs.map(job => ({...job, queue: 'training' as const})),
      ...automationJobs.map(job => ({...job, queue: 'automation' as const}))
    ];
  } catch {
    return new Response(
      JSON.stringify({error: 'dispatcher_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }

  const legacy = legacyProviderConfiguration();
  const result = {
    claimed: jobs.length,
    sent: 0,
    simulated: 0,
    ready: 0,
    waitingConfiguration: 0,
    failed: 0
  };

  for (const job of jobs) {
    const completionRpc = job.queue === 'automation'
      ? 'v2_automation_complete_message_v2'
      : 'v2_training_automation_complete_job_v3';
    let usageReservationId: string | null = null;
    try {
      const usage = await reserveUsage(
        job,
        automationSecret,
        supabaseUrl,
        serviceRoleKey
      );
      usageReservationId = usage?.reservationId || null;
      const delivered = await deliver(
        job,
        supabaseUrl,
        serviceRoleKey,
        legacy
      );
      await rpc(
        supabaseUrl,
        serviceRoleKey,
        completionRpc,
        {
          p_secret: automationSecret,
          p_job_id: job.id,
          p_result_state: delivered.state,
          p_external_id: delivered.externalId,
          p_external_url: delivered.externalUrl || null,
          p_error: null,
          p_provider_connection_id:
            delivered.providerConnectionId || null,
          p_provider_key: delivered.providerKey || null,
          p_usage_reservation_id: usageReservationId
        }
      );
      if (delivered.state === 'ready') result.ready += 1;
      else if (delivered.state === 'simulated') result.simulated += 1;
      else result.sent += 1;
    } catch (error) {
      const configurationMissing =
        error instanceof ProviderConfigurationError;
      await rpc(
        supabaseUrl,
        serviceRoleKey,
        completionRpc,
        {
          p_secret: automationSecret,
          p_job_id: job.id,
          p_result_state: configurationMissing
            ? 'missing_configuration'
            : 'failed',
          p_external_id: null,
          p_external_url: null,
          p_error: error instanceof Error
            ? error.message.slice(0, 240)
            : 'provider_request_failed',
          p_provider_connection_id: null,
          p_provider_key: null,
          p_usage_reservation_id: usageReservationId
        }
      );
      if (configurationMissing) result.waitingConfiguration += 1;
      else result.failed += 1;
    }
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: jsonHeaders
  });
});
