import type {
  AccountIdentity,
  DailyMetric,
  DimensionPage,
  JsonRecord,
  MarketingAdapter,
  MarketingConnection,
  MetricPage,
  SyncRange
} from '../types.ts';
import {
  AdsSyncError,
  asArray,
  asRecord,
  batches,
  configuration,
  microsToMinor,
  numberValue,
  oauthToken,
  queryUrl,
  remoteJson,
  secret,
  text,
  valueAt
} from '../shared.ts';

type SnapCredentials = {accessToken: string; expiresAt?: string};

function adAccountId(connection: MarketingConnection) {
  return configuration(connection, 'adAccountId');
}

async function credentials(connection: MarketingConnection): Promise<SnapCredentials> {
  const refreshToken = secret(connection, 'refreshToken');
  const clientId = secret(connection, 'clientId');
  const clientSecret = secret(connection, 'clientSecret');
  if (refreshToken && clientId && clientSecret) {
    const refreshed = await oauthToken(
      'https://accounts.snapchat.com/login/oauth2/access_token',
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      }
    );
    return {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresIn
        ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
        : undefined
    };
  }
  const accessToken = secret(connection, 'accessToken');
  if (!accessToken) throw new Error('snapchat_access_token_missing');
  return {accessToken};
}

async function request(
  accessToken: string,
  url: string | URL
) {
  const {data} = await remoteJson(url, {
    headers: {authorization: `Bearer ${accessToken}`}
  });
  const record = asRecord(data) || {};
  const requestStatus = text(record.request_status).toLowerCase();
  if (requestStatus && requestStatus !== 'success') {
    throw new AdsSyncError(
      requestStatus.includes('auth') ? 'remote_http_401' : 'snapchat_api_error',
      requestStatus.includes('auth') ? 400 : 502,
      text(valueAt(record, 'debug_message', 'message')).slice(0, 320)
    );
  }
  return record;
}

function unwrapItems(record: JsonRecord, plural: string, singular: string) {
  return asArray(record[plural]).map(entry => {
    const wrapper = asRecord(entry) || {};
    return asRecord(wrapper[singular]) || wrapper;
  }).filter(item => text(item.id));
}

async function* entityPages(
  accessToken: string,
  path: string,
  plural: string,
  singular: string
): AsyncGenerator<{items: JsonRecord[]; page: number}> {
  let nextUrl = `https://adsapi.snapchat.com/v1${path}`;
  let page = 1;
  while (nextUrl && page <= 500) {
    const record = await request(accessToken, nextUrl);
    const items = unwrapItems(record, plural, singular);
    yield {items, page};
    const candidate = text(valueAt(record, 'paging.next_link'));
    if (!candidate || items.length === 0) break;
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'adsapi.snapchat.com') {
      throw new AdsSyncError('snapchat_pagination_url_invalid', 502);
    }
    nextUrl = parsed.toString();
    page += 1;
  }
}

function nextDay(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value;
}

function isoDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

function reportWindows(range: SyncRange) {
  const result: {start: string; end: string}[] = [];
  let start = new Date(`${range.dateFrom}T00:00:00.000Z`);
  const final = nextDay(range.dateTo);
  while (start < final) {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 30);
    if (end > final) end.setTime(final.getTime());
    result.push({
      start: `${isoDay(start)}T00:00:00.000Z`,
      end: `${isoDay(end)}T00:00:00.000Z`
    });
    start = end;
  }
  return result;
}

async function test(connection: MarketingConnection): Promise<AccountIdentity> {
  const auth = await credentials(connection);
  const record = await request(
    auth.accessToken,
    `https://adsapi.snapchat.com/v1/adaccounts/${encodeURIComponent(adAccountId(connection))}`
  );
  const account = unwrapItems(record, 'adaccounts', 'adaccount')[0] || {};
  const externalAccountId = text(account.id) || adAccountId(connection);
  if (!externalAccountId) throw new Error('snapchat_account_identity_missing');
  const status = text(account.status).toUpperCase();
  return {
    externalAccountId,
    name: text(account.name) || `Snapchat ${externalAccountId}`,
    currency: text(account.currency).toUpperCase() || 'USD',
    timezone: text(account.timezone),
    status: status === 'ACTIVE' ? 'active' : status ? 'inactive' : 'unknown',
    tokenExpiresAt: auth.expiresAt,
    remoteUpdatedAt: text(account.updated_at),
    metadata: {
      apiVersion: 'v1',
      organizationId: text(account.organization_id),
      advertiser: text(account.advertiser)
    }
  };
}

async function* dimensions(
  connection: MarketingConnection,
  account: AccountIdentity
): AsyncGenerator<DimensionPage> {
  const auth = await credentials(connection);
  const accountPath = `/adaccounts/${encodeURIComponent(adAccountId(connection))}`;
  for await (const page of entityPages(
    auth.accessToken,
    `${accountPath}/campaigns`,
    'campaigns',
    'campaign'
  )) {
    yield {
      account,
      campaigns: page.items.map(item => ({
        externalId: text(item.id),
        name: text(item.name) || text(item.id),
        objective: text(item.objective),
        status: text(item.status).toLowerCase(),
        effectiveStatus: text(item.delivery_status).toLowerCase(),
        budgetType: text(item.lifetime_spend_cap_micro) ? 'lifetime' : 'daily',
        budgetMinor: microsToMinor(
          item.lifetime_spend_cap_micro ?? item.daily_budget_micro,
          account.currency
        ),
        startDate: text(item.start_time),
        endDate: text(item.end_time),
        remoteUpdatedAt: text(item.updated_at),
        raw: item
      })),
      adGroups: [],
      ads: [],
      cursor: {phase: 'campaigns', page: page.page}
    };
  }

  for await (const page of entityPages(
    auth.accessToken,
    `${accountPath}/adsquads`,
    'adsquads',
    'adsquad'
  )) {
    yield {
      account,
      campaigns: [],
      adGroups: page.items.map(item => ({
        externalId: text(item.id),
        externalCampaignId: text(item.campaign_id),
        name: text(item.name) || text(item.id),
        status: text(item.status).toLowerCase(),
        effectiveStatus: text(item.delivery_status).toLowerCase(),
        optimizationGoal: text(item.optimization_goal),
        bidStrategy: text(item.bid_strategy),
        budgetMinor: microsToMinor(
          item.lifetime_budget_micro ?? item.daily_budget_micro,
          account.currency
        ),
        remoteUpdatedAt: text(item.updated_at),
        raw: item
      })),
      ads: [],
      cursor: {phase: 'ad_groups', page: page.page}
    };
  }

  for await (const page of entityPages(
    auth.accessToken,
    `${accountPath}/ads`,
    'ads',
    'ad'
  )) {
    yield {
      account,
      campaigns: [],
      adGroups: [],
      ads: page.items.map(item => ({
        externalId: text(item.id),
        externalCampaignId: text(item.campaign_id),
        externalAdGroupId: text(item.ad_squad_id),
        externalCreativeId: text(item.creative_id),
        name: text(item.name) || text(item.id),
        status: text(item.status).toLowerCase(),
        effectiveStatus: text(item.delivery_status).toLowerCase(),
        remoteUpdatedAt: text(item.updated_at),
        raw: item
      })),
      cursor: {phase: 'ads', page: page.page}
    };
  }
}

async function* metrics(
  connection: MarketingConnection,
  account: AccountIdentity,
  range: SyncRange
): AsyncGenerator<MetricPage> {
  const auth = await credentials(connection);
  let reportPage = 0;
  for (const window of reportWindows(range)) {
    reportPage += 1;
    const record = await request(auth.accessToken, queryUrl(
      `https://adsapi.snapchat.com/v1/adaccounts/${encodeURIComponent(adAccountId(connection))}/stats`,
      {
        granularity: 'DAY',
        breakdown: 'campaign',
        fields: [
          'impressions',
          'uniques',
          'swipes',
          'spend',
          'native_leads',
          'conversion_purchases',
          'conversion_purchases_value',
          'video_views'
        ].join(','),
        start_time: window.start,
        end_time: window.end,
        swipe_up_attribution_window: '28_DAY',
        view_attribution_window: '1_DAY',
        omit_empty: true
      }
    ));
    const collected: DailyMetric[] = [];
    for (const wrapperValue of asArray(record.timeseries_stats)) {
      const wrapper = asRecord(wrapperValue) || {};
      const root = asRecord(wrapper.timeseries_stat) || {};
      const campaignRows = asArray(valueAt(root, 'breakdown_stats.campaign'));
      for (const campaignValue of campaignRows) {
        const campaign = asRecord(campaignValue) || {};
        const campaignId = text(campaign.id);
        for (const seriesValue of asArray(campaign.timeseries)) {
          const series = asRecord(seriesValue) || {};
          const stats = asRecord(series.stats) || {};
          collected.push({
            date: text(series.start_time).slice(0, 10),
            entityLevel: 'campaign',
            externalEntityId: campaignId,
            externalCampaignId: campaignId,
            currency: account.currency,
            impressions: numberValue(stats.impressions) || 0,
            reach: numberValue(stats.uniques) || 0,
            clicks: numberValue(stats.swipes) || 0,
            linkClicks: numberValue(stats.swipes) || 0,
            spendMinor: microsToMinor(stats.spend, account.currency),
            platformLeads: numberValue(stats.native_leads) || 0,
            platformConversions: numberValue(stats.conversion_purchases) || 0,
            platformRevenueMinor: microsToMinor(
              stats.conversion_purchases_value,
              account.currency
            ),
            videoViews: numberValue(stats.video_views) || 0,
            raw: {series, campaignId}
          });
        }
      }
    }
    let batchNumber = 0;
    for (const batch of batches(collected)) {
      batchNumber += 1;
      yield {
        metrics: batch,
        cursor: {phase: 'metrics', reportPage, batch: batchNumber}
      };
    }
  }
}

export const snapchatAdapter: MarketingAdapter = {test, dimensions, metrics};
