export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type JsonRecord = {[key: string]: Json};

export type CommerceEntity =
  | 'products'
  | 'categories'
  | 'collections'
  | 'coupons'
  | 'orders'
  | 'customers';

export type ConnectionConfiguration = {
  tenantId: string;
  connectionId: string;
  providerKey: string;
  status: string;
  frequency: string;
  direction: string;
  sourceOfTruth: string;
  conflictPolicy: string;
  matchBySku: boolean;
  syncScope: CommerceEntity[];
  configuration: JsonRecord;
  secrets: JsonRecord;
  lastSyncedAt?: string | null;
  remoteMetadata?: JsonRecord;
};

export type StoreIdentity = {
  externalStoreId: string;
  name: string;
  currency?: string;
  domain?: string;
  metadata?: JsonRecord;
};

export type EntityPage = {
  items: JsonRecord[];
  cursor: JsonRecord;
  hasMore: boolean;
};

export type CommerceAdapter = {
  test(connection: ConnectionConfiguration): Promise<StoreIdentity>;
  pages(
    connection: ConnectionConfiguration,
    entity: CommerceEntity
  ): AsyncGenerator<EntityPage>;
};
