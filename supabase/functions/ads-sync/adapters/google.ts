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
  microsToMinor,
  numberValue,
  oauthToken,
  remoteJson,
  secret,
  text,
  utmFields,
  valueAt
} from '../shared.ts';

type GoogleCredentials = {
  accessToken: string;
  expiresAt?: string;
};

function version(connection: MarketingConnection) {
  return /^v\d+$/.test(connection.apiVersion) ? connection.apiVersion : 'v25';
}

function customerId(connection: MarketingConnection) {
  return configuration(connection, 'customerId').replace(/\D/g, '');
}

async function credentials(connection: MarketingConnection): Promise<GoogleCredentials> {
  const refreshToken = secret(connection, 'refreshToken');
  const clientId = secret(connection, 'clientId');
  const clientSecret = secret(connection, 'clientSecret');
  if (refreshToken && clientId && clientSecret) {
    const refreshed = await oauthToken('https://oauth2.googleapis.com/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    });
    return {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresIn
        ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
        : undefined
    };
  }
  const accessToken = secret(connection, 'accessToken');
  if (!accessToken) throw new Error('google_access_token_missing');
  return {accessToken};
}

function headers(connection: MarketingConnection, accessToken: string) {
  const result: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': secret(connection, 'developerToken'),
    'content-type': 'application/json'
  };
  const loginCustomerId = configuration(connection, 'loginCustomerId').replace(/\D/g, '');
  if (loginCustomerId) result['login-customer-id'] = loginCustomerId;
  return result;
}

async function* gaqlPages(
  connection: MarketingConnection,
  accessToken: string,
  query: string
): AsyncGenerator<{rows: JsonRecord[]; page: number}> {
  let pageToken = '';
  let page = 1;
  while (page <= 1000) {
    const {data} = await remoteJson(
      `https://googleads.googleapis.com/${version(connection)}/customers/${customerId(connection)}/googleAds:search`,
      {
        method: 'POST',
        headers: headers(connection, accessToken),
        body: JSON.stringify({
          query,
          ...(pageToken ? {pageToken} : {})
        })
      }
    );
    const record = asRecord(data) || {};
    const rows = asArray(record.results).map(asRecord).filter(Boolean) as JsonRecord[];
    yield {rows, page};
    pageToken = text(record.nextPageToken);
    if (!pageToken || rows.length === 0) break;
    page += 1;
  }
}

async function firstRow(
  connection: MarketingConnection,
  accessToken: string,
  query: string
) {
  for await (const page of gaqlPages(connection, accessToken, query)) {
    return page.rows[0] || null;
  }
  return null;
}

async function test(connection: MarketingConnection): Promise<AccountIdentity> {
  const auth = await credentials(connection);
  const row = await firstRow(connection, auth.accessToken, `
    SELECT
      customer.id,
      customer.descriptive_name,
      customer.currency_code,
      customer.time_zone,
      customer.manager,
      customer.test_account
    FROM customer
    LIMIT 1
  `);
  const customer = asRecord(row?.customer) || {};
  const externalAccountId = text(customer.id) || customerId(connection);
  if (!externalAccountId) throw new Error('google_account_identity_missing');
  return {
    externalAccountId,
    name: text(customer.descriptiveName) || `Google Ads ${externalAccountId}`,
    currency: text(customer.currencyCode).toUpperCase() || 'USD',
    timezone: text(customer.timeZone),
    status: 'active',
    tokenExpiresAt: auth.expiresAt,
    metadata: {
      apiVersion: version(connection),
      manager: Boolean(customer.manager),
      testAccount: Boolean(customer.testAccount)
    }
  };
}

async function* dimensions(
  connection: MarketingConnection,
  account: AccountIdentity
): AsyncGenerator<DimensionPage> {
  const auth = await credentials(connection);
  for await (const page of gaqlPages(connection, auth.accessToken, `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.start_date,
      campaign.end_date,
      campaign.tracking_url_template,
      campaign.bidding_strategy_type,
      campaign_budget.amount_micros,
      campaign_budget.period
    FROM campaign
    ORDER BY campaign.id
  `)) {
    yield {
      account,
      campaigns: page.rows.map(row => {
        const campaign = asRecord(row.campaign) || {};
        const budget = asRecord(row.campaignBudget) || {};
        return {
          externalId: text(campaign.id),
          name: text(campaign.name) || text(campaign.id),
          objective: text(campaign.advertisingChannelType),
          status: text(campaign.status).toLowerCase(),
          effectiveStatus: text(campaign.status).toLowerCase(),
          budgetType: text(budget.period).toLowerCase(),
          budgetMinor: microsToMinor(budget.amountMicros, account.currency),
          startDate: text(campaign.startDate),
          endDate: text(campaign.endDate),
          trackingTemplate: text(campaign.trackingUrlTemplate),
          raw: row
        };
      }),
      adGroups: [],
      ads: [],
      cursor: {phase: 'campaigns', page: page.page}
    };
  }

  for await (const page of gaqlPages(connection, auth.accessToken, `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.type,
      ad_group.cpc_bid_micros
    FROM ad_group
    ORDER BY campaign.id, ad_group.id
  `)) {
    yield {
      account,
      campaigns: [],
      adGroups: page.rows.map(row => {
        const campaign = asRecord(row.campaign) || {};
        const group = asRecord(row.adGroup) || {};
        return {
          externalId: text(group.id),
          externalCampaignId: text(campaign.id),
          name: text(group.name) || text(group.id),
          status: text(group.status).toLowerCase(),
          effectiveStatus: text(group.status).toLowerCase(),
          optimizationGoal: text(group.type),
          budgetMinor: microsToMinor(group.cpcBidMicros, account.currency),
          raw: row
        };
      }),
      ads: [],
      cursor: {phase: 'ad_groups', page: page.page}
    };
  }

  for await (const page of gaqlPages(connection, auth.accessToken, `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_ad.status,
      ad_group_ad.ad.id,
      ad_group_ad.ad.final_urls,
      ad_group_ad.ad.tracking_url_template
    FROM ad_group_ad
    ORDER BY campaign.id, ad_group.id, ad_group_ad.ad.id
  `)) {
    yield {
      account,
      campaigns: [],
      adGroups: [],
      ads: page.rows.map(row => {
        const campaign = asRecord(row.campaign) || {};
        const group = asRecord(row.adGroup) || {};
        const groupAd = asRecord(row.adGroupAd) || {};
        const ad = asRecord(groupAd.ad) || {};
        const finalUrl = text(asArray(ad.finalUrls)[0]);
        return {
          externalId: text(ad.id),
          externalCampaignId: text(campaign.id),
          externalAdGroupId: text(group.id),
          externalCreativeId: text(ad.id),
          name: `Ad ${text(ad.id)}`,
          status: text(groupAd.status).toLowerCase(),
          effectiveStatus: text(groupAd.status).toLowerCase(),
          ...utmFields(finalUrl),
          raw: row
        };
      }),
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
  const query = `
    SELECT
      segments.date,
      campaign.id,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.video_views
    FROM campaign
    WHERE segments.date BETWEEN '${range.dateFrom}' AND '${range.dateTo}'
    ORDER BY segments.date, campaign.id
  `;
  for await (const page of gaqlPages(connection, auth.accessToken, query)) {
    yield {
      metrics: page.rows.map(row => {
        const campaign = asRecord(row.campaign) || {};
        const metrics = asRecord(row.metrics) || {};
        const segments = asRecord(row.segments) || {};
        return {
          date: text(segments.date),
          entityLevel: 'campaign' as const,
          externalEntityId: text(campaign.id),
          externalCampaignId: text(campaign.id),
          currency: account.currency,
          impressions: numberValue(metrics.impressions) || 0,
          clicks: numberValue(metrics.clicks) || 0,
          linkClicks: numberValue(metrics.clicks) || 0,
          spendMinor: microsToMinor(metrics.costMicros, account.currency),
          platformConversions: numberValue(metrics.conversions) || 0,
          platformRevenueMinor: moneyMinor(metrics.conversionsValue, account.currency),
          videoViews: numberValue(metrics.videoViews) || 0,
          raw: row
        };
      }),
      cursor: {phase: 'metrics', page: page.page}
    };
  }
}

export const googleAdapter: MarketingAdapter = {test, dimensions, metrics};
