import type {
  AccountIdentity,
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
  configuration,
  moneyMinor,
  numberValue,
  queryUrl,
  remoteJson,
  secret,
  text,
  utmFields,
  valueAt
} from '../shared.ts';

function version(connection: MarketingConnection) {
  return /^v\d+\.\d+$/.test(connection.apiVersion) ? connection.apiVersion : 'v1.3';
}

function base(connection: MarketingConnection) {
  return `https://business-api.tiktok.com/open_api/${version(connection)}`;
}

function advertiserId(connection: MarketingConnection) {
  return configuration(connection, 'advertiserId');
}

async function apiGet(
  connection: MarketingConnection,
  path: string,
  values: Record<string, string | number | null>
) {
  const {data} = await remoteJson(queryUrl(`${base(connection)}${path}`, values), {
    headers: {'Access-Token': secret(connection, 'accessToken')}
  });
  const record = asRecord(data) || {};
  const code = numberValue(record.code) || 0;
  if (code !== 0) {
    const message = text(record.message).slice(0, 320);
    throw new AdsSyncError(
      code === 40001 || code === 40100 ? 'remote_http_401' : `tiktok_api_${code}`,
      code === 40001 || code === 40100 ? 400 : 502,
      message
    );
  }
  return asRecord(record.data) || {};
}

async function* endpointPages(
  connection: MarketingConnection,
  path: string,
  extra: Record<string, string | number | null> = {}
): AsyncGenerator<{items: JsonRecord[]; page: number}> {
  let page = 1;
  while (page <= 500) {
    const data = await apiGet(connection, path, {
      advertiser_id: advertiserId(connection),
      page,
      page_size: 500,
      ...extra
    });
    const items = asArray(data.list).map(asRecord).filter(Boolean) as JsonRecord[];
    yield {items, page};
    const totalPages = numberValue(valueAt(data, 'page_info.total_page'));
    if (items.length === 0 || (totalPages != null ? page >= totalPages : items.length < 500)) {
      break;
    }
    page += 1;
  }
}

async function test(connection: MarketingConnection): Promise<AccountIdentity> {
  const data = await apiGet(connection, '/advertiser/info/', {
    advertiser_ids: JSON.stringify([advertiserId(connection)]),
    fields: JSON.stringify([
      'advertiser_id',
      'advertiser_name',
      'currency',
      'timezone',
      'status'
    ])
  });
  const account = asRecord(asArray(data.list)[0]) || {};
  const externalAccountId = text(account.advertiser_id) || advertiserId(connection);
  if (!externalAccountId) throw new Error('tiktok_account_identity_missing');
  const status = text(account.status).toUpperCase();
  return {
    externalAccountId,
    name: text(account.advertiser_name) || `TikTok ${externalAccountId}`,
    currency: text(account.currency).toUpperCase() || 'USD',
    timezone: text(account.timezone),
    status: status.includes('ENABLE') || status.includes('ACTIVE') ? 'active' : 'inactive',
    metadata: {apiVersion: version(connection), advertiserStatus: status}
  };
}

async function* dimensions(
  connection: MarketingConnection,
  account: AccountIdentity
): AsyncGenerator<DimensionPage> {
  for await (const page of endpointPages(connection, '/campaign/get/')) {
    yield {
      account,
      campaigns: page.items.map(item => ({
        externalId: text(item.campaign_id),
        name: text(item.campaign_name) || text(item.campaign_id),
        objective: text(item.objective_type),
        status: text(item.operation_status).toLowerCase(),
        effectiveStatus: text(item.secondary_status).toLowerCase(),
        budgetType: text(item.budget_mode).toLowerCase(),
        budgetMinor: moneyMinor(item.budget, account.currency),
        raw: item
      })),
      adGroups: [],
      ads: [],
      cursor: {phase: 'campaigns', page: page.page}
    };
  }

  for await (const page of endpointPages(connection, '/adgroup/get/')) {
    yield {
      account,
      campaigns: [],
      adGroups: page.items.map(item => ({
        externalId: text(item.adgroup_id),
        externalCampaignId: text(item.campaign_id),
        name: text(item.adgroup_name) || text(item.adgroup_id),
        status: text(item.operation_status).toLowerCase(),
        effectiveStatus: text(item.secondary_status).toLowerCase(),
        optimizationGoal: text(item.optimization_goal),
        bidStrategy: text(item.bid_type),
        budgetMinor: moneyMinor(item.budget, account.currency),
        remoteUpdatedAt: text(item.modify_time),
        raw: item
      })),
      ads: [],
      cursor: {phase: 'ad_groups', page: page.page}
    };
  }

  for await (const page of endpointPages(connection, '/ad/get/')) {
    yield {
      account,
      campaigns: [],
      adGroups: [],
      ads: page.items.map(item => ({
        externalId: text(item.ad_id),
        externalCampaignId: text(item.campaign_id),
        externalAdGroupId: text(item.adgroup_id),
        externalCreativeId: text(item.creative_id),
        name: text(item.ad_name) || text(item.ad_id),
        status: text(item.operation_status).toLowerCase(),
        effectiveStatus: text(item.secondary_status).toLowerCase(),
        ...utmFields(valueAt(item, 'landing_page_url', 'landing_page_urls.0')),
        remoteUpdatedAt: text(item.modify_time),
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
  for await (const page of endpointPages(connection, '/report/integrated/get/', {
    report_type: 'BASIC',
    service_type: 'AUCTION',
    data_level: 'AUCTION_CAMPAIGN',
    dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
    metrics: JSON.stringify([
      'spend',
      'impressions',
      'clicks',
      'reach',
      'conversion',
      'video_play_actions'
    ]),
    start_date: range.dateFrom,
    end_date: range.dateTo
  })) {
    yield {
      metrics: page.items.map(item => {
        const dimensions = asRecord(item.dimensions) || {};
        const metrics = asRecord(item.metrics) || {};
        const campaignId = text(dimensions.campaign_id);
        return {
          date: text(dimensions.stat_time_day).slice(0, 10),
          entityLevel: 'campaign' as const,
          externalEntityId: campaignId,
          externalCampaignId: campaignId,
          currency: account.currency,
          impressions: numberValue(metrics.impressions) || 0,
          reach: numberValue(metrics.reach) || 0,
          clicks: numberValue(metrics.clicks) || 0,
          linkClicks: numberValue(metrics.clicks) || 0,
          spendMinor: moneyMinor(metrics.spend, account.currency),
          platformConversions: numberValue(metrics.conversion) || 0,
          videoViews: numberValue(metrics.videoPlayActions ?? metrics.video_play_actions) || 0,
          raw: item
        };
      }),
      cursor: {phase: 'metrics', page: page.page}
    };
  }
}

export const tiktokAdapter: MarketingAdapter = {test, dimensions, metrics};
