import type {
  CommerceAdapter,
  CommerceEntity,
  ConnectionConfiguration,
  EntityPage,
  JsonRecord,
  StoreIdentity
} from '../types.ts';
import {
  asRecord,
  attributionFields,
  compact,
  configuration,
  externalItem,
  listAt,
  moneyMinor,
  normalizedEntity,
  normalizedProduct,
  numberValue,
  remoteJson,
  secret,
  stripHtml,
  text,
  valueAt
} from '../shared.ts';

const API_VERSION = '2026-07';

function endpoint(connection: ConnectionConfiguration) {
  return `https://${configuration(connection, 'shopDomain')}/admin/api/${API_VERSION}/graphql.json`;
}

async function graphql(
  connection: ConnectionConfiguration,
  query: string,
  variables: JsonRecord = {}
) {
  const {data} = await remoteJson(endpoint(connection), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Access-Token': secret(connection, 'accessToken')
    },
    body: JSON.stringify({query, variables})
  });
  const record = asRecord(data);
  const errors = Array.isArray(record?.errors) ? record?.errors : [];
  if (errors.length) {
    const first = asRecord(errors[0]);
    throw new Error(`shopify_graphql:${text(first?.message).slice(0, 180)}`);
  }
  return asRecord(record?.data) || {};
}

const PRODUCT_QUERY = `
query Products($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: UPDATED_AT) {
    nodes {
      id title descriptionHtml handle status updatedAt productType onlineStoreUrl
      totalInventory
      featuredImage { url }
      images(first: 20) { nodes { url } }
      collections(first: 20) { nodes { id title } }
      variants(first: 100) {
        nodes { id sku price compareAtPrice inventoryQuantity }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COLLECTION_QUERY = `
query Collections($first: Int!, $after: String) {
  collections(first: $first, after: $after, sortKey: UPDATED_AT) {
    nodes { id title handle updatedAt descriptionHtml image { url } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ORDER_QUERY = `
query Orders($first: Int!, $after: String) {
  orders(first: $first, after: $after, sortKey: UPDATED_AT) {
    nodes {
      id name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus
      landingPageUrl referringSite sourceIdentifier sourceName
      customAttributes { key value }
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { id displayName email phone }
      lineItems(first: 100) { nodes { id title quantity product { id } variant { id sku } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CUSTOMER_QUERY = `
query Customers($first: Int!, $after: String) {
  customers(first: $first, after: $after, sortKey: UPDATED_AT) {
    nodes { id displayName firstName lastName email phone createdAt updatedAt tags }
    pageInfo { hasNextPage endCursor }
  }
}`;

function product(connection: ConnectionConfiguration, item: JsonRecord) {
  const variants = listAt(item, 'variants.nodes').map(asRecord).filter(Boolean) as JsonRecord[];
  const firstVariant = variants[0] || {};
  const images = listAt(item, 'images.nodes')
    .map(asRecord)
    .filter(Boolean)
    .map(image => text(valueAt(image as JsonRecord, 'url')))
    .filter(Boolean);
  const categories = listAt(item, 'collections.nodes')
    .map(asRecord)
    .filter(Boolean)
    .map(collection => text(valueAt(collection as JsonRecord, 'title')))
    .filter(Boolean);
  const inventory = numberValue(valueAt(item, 'totalInventory'));
  const status = text(valueAt(item, 'status')).toLowerCase();
  return normalizedProduct(item, {
    externalId: text(valueAt(item, 'id')),
    externalUpdatedAt: text(valueAt(item, 'updatedAt')),
    sku: text(valueAt(firstVariant, 'sku')),
    titleAr: text(valueAt(item, 'title')),
    description: stripHtml(valueAt(item, 'descriptionHtml')),
    regularPriceMinor: moneyMinor(valueAt(firstVariant, 'compareAtPrice', 'price')),
    salePriceMinor: valueAt(firstVariant, 'compareAtPrice') != null
      ? moneyMinor(valueAt(firstVariant, 'price'))
      : null,
    priceMinor: moneyMinor(valueAt(firstVariant, 'price')),
    currency: text(valueAt(connection.remoteMetadata || {}, 'currency')) || 'SAR',
    status: status === 'active' ? 'active' : status === 'archived' ? 'archived' : 'draft',
    externalUrl: text(valueAt(item, 'onlineStoreUrl')),
    primaryImageUrl: text(valueAt(item, 'featuredImage.url')),
    galleryUrls: compact(images),
    stockStatus: inventory === 0 ? 'outofstock' : 'instock',
    stockQuantity: inventory,
    productType: text(valueAt(item, 'productType')) || 'simple',
    virtual: false,
    downloadable: false,
    categoryNames: categories
  });
}

function entityItem(entity: CommerceEntity, item: JsonRecord) {
  if (entity === 'orders') {
    const customer = asRecord(item.customer) || {};
    const money = asRecord(valueAt(item, 'totalPriceSet.shopMoney')) || {};
    return normalizedEntity(item, {
      externalId: text(item.id),
      externalUpdatedAt: text(item.updatedAt),
      orderNumber: text(item.name || item.id),
      occurredAt: text(item.createdAt),
      status: text(item.displayFulfillmentStatus),
      paymentStatus: text(item.displayFinancialStatus),
      amountMinor: moneyMinor(money.amount),
      currency: text(money.currencyCode) || 'SAR',
      customerId: text(customer.id),
      customerEmail: text(customer.email),
      customerPhone: text(customer.phone),
      ...attributionFields(item)
    });
  }
  if (entity === 'customers') {
    return normalizedEntity(item, {
      externalId: text(item.id),
      externalUpdatedAt: text(item.updatedAt),
      customerEmail: text(item.email),
      customerPhone: text(item.phone)
    });
  }
  return externalItem(item, valueAt(item, 'id'));
}

function connectionFor(entity: CommerceEntity, data: JsonRecord) {
  return asRecord(data[entity]);
}

async function* queryPages(
  connection: ConnectionConfiguration,
  entity: CommerceEntity,
  query: string
): AsyncGenerator<EntityPage> {
  let after: string | null = null;
  let page = 1;
  while (true) {
    const data = await graphql(connection, query, {first: 100, after});
    const container = connectionFor(entity, data);
    const raw = Array.isArray(container?.nodes) ? container?.nodes || [] : [];
    const items = raw
      .map(asRecord)
      .filter(Boolean)
      .map(item => entity === 'products'
        ? product(connection, item as JsonRecord)
        : entityItem(entity, item as JsonRecord));
    const pageInfo = asRecord(container?.pageInfo) || {};
    const hasMore = Boolean(pageInfo.hasNextPage);
    after = text(pageInfo.endCursor) || null;
    yield {items, cursor: {page, after}, hasMore};
    if (!hasMore || !after) break;
    page += 1;
  }
}

async function* pages(
  connection: ConnectionConfiguration,
  entity: CommerceEntity
): AsyncGenerator<EntityPage> {
  if (entity === 'products') yield* queryPages(connection, 'products', PRODUCT_QUERY);
  else if (entity === 'collections') yield* queryPages(connection, 'collections', COLLECTION_QUERY);
  else if (entity === 'orders') yield* queryPages(connection, 'orders', ORDER_QUERY);
  else if (entity === 'customers') yield* queryPages(connection, 'customers', CUSTOMER_QUERY);
}

async function test(connection: ConnectionConfiguration): Promise<StoreIdentity> {
  const data = await graphql(connection, `query StoreIdentity {
    shop { id name currencyCode primaryDomain { url } }
  }`);
  const shop = asRecord(data.shop);
  if (!shop || !text(shop.id)) throw new Error('shopify_store_identity_missing');
  return {
    externalStoreId: text(shop.id),
    name: text(shop.name) || 'Shopify Store',
    currency: text(shop.currencyCode),
    domain: text(valueAt(shop, 'primaryDomain.url')),
    metadata: {apiVersion: API_VERSION}
  };
}

export const shopifyAdapter: CommerceAdapter = {test, pages};
