export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type JsonRecord = {[key: string]: Json};

export type MarketingProvider =
  | 'meta'
  | 'google_ads'
  | 'tiktok_ads'
  | 'snapchat_ads';

export type MarketingConnection = {
  tenantId: string;
  connectionId: string;
  providerKey: MarketingProvider;
  status: string;
  frequency: string;
  syncLookbackDays: number;
  apiVersion: string;
  configuration: JsonRecord;
  secrets: JsonRecord;
  lastSyncedAt?: string | null;
  remoteMetadata?: JsonRecord;
};

export type AccountIdentity = {
  externalAccountId: string;
  name: string;
  currency: string;
  timezone?: string;
  status?: 'active' | 'inactive' | 'closed' | 'unknown';
  externalUserId?: string;
  tokenExpiresAt?: string;
  remoteUpdatedAt?: string;
  metadata?: JsonRecord;
};

export type CampaignDimension = {
  externalId: string;
  name: string;
  objective?: string;
  status?: string;
  effectiveStatus?: string;
  budgetType?: string;
  budgetMinor?: number | null;
  startDate?: string;
  endDate?: string;
  destinationUrl?: string;
  trackingTemplate?: string;
  remoteUpdatedAt?: string;
  raw?: JsonRecord;
};

export type AdGroupDimension = {
  externalId: string;
  externalCampaignId: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
  optimizationGoal?: string;
  bidStrategy?: string;
  budgetMinor?: number | null;
  remoteUpdatedAt?: string;
  raw?: JsonRecord;
};

export type AdDimension = {
  externalId: string;
  externalCampaignId: string;
  externalAdGroupId?: string;
  externalCreativeId?: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
  destinationUrl?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  remoteUpdatedAt?: string;
  raw?: JsonRecord;
};

export type DimensionPage = {
  account: AccountIdentity;
  campaigns: CampaignDimension[];
  adGroups: AdGroupDimension[];
  ads: AdDimension[];
  cursor?: JsonRecord;
};

export type DailyMetric = {
  date: string;
  entityLevel: 'account' | 'campaign' | 'ad_group' | 'ad';
  externalEntityId: string;
  externalCampaignId?: string;
  externalAdGroupId?: string;
  externalAdId?: string;
  breakdownKey?: string;
  currency: string;
  impressions?: number;
  reach?: number;
  clicks?: number;
  linkClicks?: number;
  spendMinor?: number;
  platformLeads?: number;
  platformConversions?: number;
  platformRevenueMinor?: number;
  videoViews?: number;
  raw?: JsonRecord;
};

export type MetricPage = {
  metrics: DailyMetric[];
  cursor?: JsonRecord;
};

export type SyncRange = {dateFrom: string; dateTo: string};

export type MarketingAdapter = {
  test(connection: MarketingConnection): Promise<AccountIdentity>;
  dimensions(
    connection: MarketingConnection,
    account: AccountIdentity
  ): AsyncGenerator<DimensionPage>;
  metrics(
    connection: MarketingConnection,
    account: AccountIdentity,
    range: SyncRange
  ): AsyncGenerator<MetricPage>;
};
