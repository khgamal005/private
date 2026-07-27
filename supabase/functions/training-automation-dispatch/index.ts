type JobChannel = 'whatsapp' | 'email' | 'zoom';
type JobType =
  | 'joining_instructions'
  | 'session_reminder_24h'
  | 'session_reminder_1h'
  | 'zoom_meeting_create';

type AutomationJob = {
  id: string;
  tenantId: string;
  courseRunId: string;
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
  courseRun: {
    id: string;
    title: string;
    courseName: string;
    runCode: string;
  };
};

type DeliveryResult = {
  state: 'sent' | 'ready';
  externalId: string;
  externalUrl?: string;
};

class ProviderConfigurationError extends Error {}

const jsonHeaders = {'content-type': 'application/json; charset=utf-8'};

function env(name: string) {
  return Deno.env.get(name)?.trim() || '';
}

function configured(values: string[]) {
  return values.every(Boolean);
}

function providerConfiguration() {
  const whatsapp = {
    token: env('META_WHATSAPP_TOKEN'),
    phoneNumberId: env('META_WHATSAPP_PHONE_NUMBER_ID'),
    apiVersion: env('META_WHATSAPP_API_VERSION') || 'v23.0',
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

function providerDetail(
  provider: 'whatsapp' | 'email' | 'zoom',
  isReady: boolean
) {
  if (isReady) return 'provider_credentials_available';
  if (provider === 'whatsapp') {
    return 'meta_credentials_or_approved_templates_missing';
  }
  if (provider === 'email') return 'resend_credentials_missing';
  return 'zoom_server_to_server_oauth_missing';
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

function templateValues(job: AutomationJob) {
  const metadata = job.metadata || {};
  const value = (key: string, fallback = '—') =>
    String(metadata[key] || fallback).slice(0, 900);

  if (job.type === 'joining_instructions') {
    return [
      value('studentName'),
      value('courseName', job.courseRun.courseName),
      value('runName', job.courseRun.title),
      value('startDate'),
      value('venueOrLink')
    ];
  }
  return [
    value('studentName'),
    value('courseName', job.courseRun.courseName),
    value('sessionTitle', job.session?.title),
    value('startDate'),
    value('venueOrLink')
  ];
}

async function sendWhatsApp(
  job: AutomationJob,
  config: ReturnType<typeof providerConfiguration>['whatsapp']
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

async function sendEmail(
  job: AutomationJob,
  config: ReturnType<typeof providerConfiguration>['email']
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

let zoomToken: string | null = null;

async function zoomAccessToken(
  config: ReturnType<typeof providerConfiguration>['zoom']
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
  config: ReturnType<typeof providerConfiguration>['zoom']
): Promise<DeliveryResult> {
  if (!job.session) throw new Error('zoom_job_missing_session');
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

async function deliver(
  job: AutomationJob,
  providers: ReturnType<typeof providerConfiguration>
) {
  if (job.channel === 'whatsapp') {
    return await sendWhatsApp(job, providers.whatsapp);
  }
  if (job.channel === 'email') {
    return await sendEmail(job, providers.email);
  }
  return await createZoomMeeting(job, providers.zoom);
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
  const automationSecret =
    request.headers.get('x-marktone-automation-secret')?.trim() || '';
  if (!supabaseUrl || !serviceRoleKey || !automationSecret) {
    return new Response(
      JSON.stringify({error: 'dispatcher_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }

  let jobs: AutomationJob[];
  try {
    jobs = await rpc<AutomationJob[]>(
      supabaseUrl,
      serviceRoleKey,
      'v2_training_automation_claim_jobs',
      {p_secret: automationSecret, p_limit: 20}
    );
  } catch {
    return new Response(
      JSON.stringify({error: 'dispatcher_not_authorized'}),
      {status: 401, headers: jsonHeaders}
    );
  }

  const providers = providerConfiguration();
  await Promise.allSettled(
    ([
      ['whatsapp', providers.whatsapp.ready],
      ['email', providers.email.ready],
      ['zoom', providers.zoom.ready]
    ] as const).map(([provider, ready]) =>
      rpc(
        supabaseUrl,
        serviceRoleKey,
        'v2_training_automation_provider_health',
        {
          p_secret: automationSecret,
          p_provider: provider,
          p_state: ready ? 'ready' : 'missing_configuration',
          p_detail: providerDetail(provider, ready)
        }
      )
    )
  );

  const result = {
    claimed: jobs.length,
    sent: 0,
    ready: 0,
    waitingConfiguration: 0,
    failed: 0
  };

  for (const job of jobs) {
    try {
      const delivered = await deliver(job, providers);
      await rpc(
        supabaseUrl,
        serviceRoleKey,
        'v2_training_automation_complete_job',
        {
          p_secret: automationSecret,
          p_job_id: job.id,
          p_result_state: delivered.state,
          p_external_id: delivered.externalId,
          p_external_url: delivered.externalUrl || null,
          p_error: null
        }
      );
      if (delivered.state === 'ready') result.ready += 1;
      else result.sent += 1;
    } catch (error) {
      const configurationMissing =
        error instanceof ProviderConfigurationError;
      await rpc(
        supabaseUrl,
        serviceRoleKey,
        'v2_training_automation_complete_job',
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
            : 'provider_request_failed'
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
