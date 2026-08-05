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
  asArray,
  asRecord,
  configuration,
  moneyMinor,
  numberValue,
  queryUrl,
  remoteJson,
  secret,
  sumAction,
  text,
  valueAt
} from '../shared.ts';

function version(connection: MarketingConnection) {
  return /^v\d+\.\d+$/.test(connection.apiVersion) ? connection.apiVersion : 'v26.0';
}

function accountId(connection: MarketingConnection) {
  return configuration(connection, 'accountId').replace(/^act_/, '');
}

function base(connection: MarketingConnection) {
  return `https://graph.facebook.com/${version(connection)}`;
}

function headers(connection: MarketingConnection) {
  return {authorization: `Bearer ${secret(connection, 'accessToken')}`};
}

async function* graphPages(
  connection: MarketingConnection,
  path: string,
  parameters: Record<string, string | number>
): AsyncGenerator<{items: JsonRecord[]; page: number}> {
  let after = '';
  let page = 1;
  while (page <= 500) {
    const {data} = await remoteJson(queryUrl(`${base(connection)}${path}`, {
      ...parameters,
      limit: 500,
      after: after || null
    }), {headers: headers(connection)});
    const record = asRecord(data) || {};
    const items = asArray(record.data).map(asRecord).filter(Boolean) as JsonRecord[];
    yield {items, page};
    const nextAfter = text(valueAt(record, 'paging.cursors.after'));
    if (!nextAfter || items.length === 0) break;
    after = nextAfter;
    page += 1;
  }
}

async function test(connection: MarketingConnection): Promise<AccountIdentity> {
  const {data} = await remoteJson(queryUrl(
    `${base(connection)}/act_${accountId(connection)}`,
    {fields: 'id,name,currency,timezone_name,account_status'}
  ), {headers: headers(connection)});
  const account = asRecord(data) || {};
  const externalAccountId = text(account.id).replace(/^act_/, '');
  if (!externalAccountId) throw new Error('meta_account_identity_missing');
  const accountStatus = numberValue(account.account_status);
  return {
    externalAccountId,
    name: text(account.name) || `Meta ${externalAccountId}`,
    currency: text(account.currency).toUpperCase() || 'USD',
    timezone: text(account.timezone_name),
    status: accountStatus === 1 ? 'active' : accountStatus == null ? 'unknown' : 'inactive',
    metadata: {
      apiVersion: version(connection),
      businessId: configuration(connection, 'businessId'),
      accountStatus
    }
  };
}

async function* dimensions(
  connection: MarketingConnection,
  account: AccountIdentity
): AsyncGenerator<DimensionPage> {
  for await (const page of graphPages(
    connection,
    `/act_${accountId(connection)}/campaigns`,
    {fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,updated_time'}
  )) {
    yield {
      account,
      campaigns: page.items.map(item => ({
        externalId: text(item.id),
        name: text(item.name) || text(item.id),
        objective: text(item.objective),
        status: text(item.status).toLowerCase(),
        effectiveStatus: text(item.effective_status).toLowerCase(),
        budgetType: text(item.lifetime_budget) ? 'lifetime' : 'daily',
        budgetMinor: numberValue(item.lifetime_budget ?? item.daily_budget),
        startDate: text(item.start_time),
        endDate: text(item.stop_time),
        remoteUpdatedAt: text(item.updated_time),
        raw: item
      })),
      adGroups: [],
      ads: [],
      cursor: {phase: 'campaigns', page: page.page}
    };
  }

  for await (const page of graphPages(
    connection,
    `/act_${accountId(connection)}/adsets`,
    {fields: 'id,name,campaign_id,status,effective_status,optimization_goal,bid_strategy,daily_budget,lifetime_budget,updated_time'}
  )) {
    yield {
      account,
      campaigns: [],
      adGroups: page.items.map(item => ({
        externalId: text(item.id),
        externalCampaignId: text(item.campaign_id),
        name: text(item.name) || text(item.id),
        status: text(item.status).toLowerCase(),
        effectiveStatus: text(item.effective_status).toLowerCase(),
        optimizationGoal: text(item.optimization_goal),
        bidStrategy: text(item.bid_strategy),
        budgetMinor: numberValue(item.lifetime_budget ?? item.daily_budget),
        remoteUpdatedAt: text(item.updated_time),
        raw: item
      })),
      ads: [],
      cursor: {phase: 'ad_groups', page: page.page}
    };
  }

  for await (const page of graphPages(
    connection,
    `/act_${accountId(connection)}/ads`,
    {fields: 'id,name,campaign_id,adset_id,status,effective_status,creative{id},tracking_specs,updated_time'}
  )) {
    yield {
      account,
      campaigns: [],
      adGroups: [],
      ads: page.items.map(item => ({
        externalId: text(item.id),
        externalCampaignId: text(item.campaign_id),
        externalAdGroupId: text(item.adset_id),
        externalCreativeId: text(valueAt(item, 'creative.id')),
        name: text(item.name) || text(item.id),
        status: text(item.status).toLowerCase(),
        effectiveStatus: text(item.effective_status).toLowerCase(),
        remoteUpdatedAt: text(item.updated_time),
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
  const fields = [
    'date_start',
    'account_currency',
    'campaign_id',
    'campaign_name',
    'impressions',
    'reach',
    'clicks',
    'inline_link_clicks',
    'spend',
    'actions',
    'action_values',
    'video_play_actions'
  ].join(',');
  for await (const page of graphPages(
    connection,
    `/act_${accountId(connection)}/insights`,
    {
      fields,
      level: 'campaign',
      time_increment: 1,
      time_range: JSON.stringify({since: range.dateFrom, until: range.dateTo})
    }
  )) {
    yield {
      metrics: page.items.map(item => {
        const currency = text(item.account_currency).toUpperCase() || account.currency;
        const leads = sumAction(item.actions, [
          'lead',
          'onsite_conversion.lead_grouped',
          'offsite_conversion.fb_pixel_lead'
        ], ['lead']);
        const purchases = sumAction(item.actions, [
          'purchase',
          'offsite_conversion.fb_pixel_purchase',
          'omni_purchase'
        ], ['purchase']);
        const purchaseValue = sumAction(item.action_values, [
          'purchase',
          'offsite_conversion.fb_pixel_purchase',
          'omni_purchase'
        ], ['purchase']);
        return {
          date: text(item.date_start),
          entityLevel: 'campaign' as const,
          externalEntityId: text(item.campaign_id),
          externalCampaignId: text(item.campaign_id),
          currency,
          impressions: numberValue(item.impressions) || 0,
          reach: numberValue(item.reach) || 0,
          clicks: numberValue(item.clicks) || 0,
          linkClicks: numberValue(item.inline_link_clicks) || 0,
          spendMinor: moneyMinor(item.spend, currency),
          platformLeads: leads,
          platformConversions: purchases,
          platformRevenueMinor: moneyMinor(purchaseValue, currency),
          videoViews: sumAction(item.video_play_actions, [], ['video_view']),
          raw: item
        };
      }),
      cursor: {phase: 'metrics', page: page.page}
    };
  }
}

export const metaAdapter: MarketingAdapter = {test, dimensions, metrics};
