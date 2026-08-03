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
  assertPageLimit,
  attributionFields,
  compact,
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
  valueAt,
  withQuery
} from '../shared.ts';

const BASE = 'https://api.salla.dev/admin/v2';
const PATHS: Partial<Record<CommerceEntity, string>> = {
  products: '/products',
  categories: '/categories',
  coupons: '/coupons',
  orders: '/orders',
  customers: '/customers'
};

function headers(connection: ConnectionConfiguration) {
  return {authorization: `Bearer ${secret(connection, 'accessToken')}`};
}

function product(item: JsonRecord) {
  const price = valueAt(item, 'price.amount', 'taxed_price.amount');
  const regular = valueAt(item, 'regular_price.amount', 'price.amount');
  const sale = valueAt(item, 'sale_price.amount');
  const images = listAt(item, 'images')
    .map(asRecord)
    .filter(Boolean)
    .map(image => text(valueAt(image as JsonRecord, 'url')))
    .filter(Boolean);
  const categories = listAt(item, 'categories')
    .map(asRecord)
    .filter(Boolean)
    .map(category => text(valueAt(category as JsonRecord, 'name')))
    .filter(Boolean);
  const quantity = numberValue(valueAt(item, 'quantity', 'stock_quantity'));
  const status = text(valueAt(item, 'status'));
  return normalizedProduct(item, {
    externalId: text(valueAt(item, 'id')),
    externalUpdatedAt: text(valueAt(item, 'updated_at', 'updatedAt')),
    sku: text(valueAt(item, 'sku')),
    titleAr: text(valueAt(item, 'name')),
    description: stripHtml(valueAt(item, 'description')),
    regularPriceMinor: moneyMinor(regular),
    salePriceMinor: moneyMinor(sale),
    priceMinor: moneyMinor(price),
    currency: text(valueAt(item, 'price.currency', 'taxed_price.currency', 'currency')) || 'SAR',
    status: ['sale', 'active', 'published'].includes(status) ? 'active' : status || 'draft',
    externalUrl: text(valueAt(item, 'urls.customer', 'url')),
    primaryImageUrl: text(valueAt(item, 'main_image', 'thumbnail')),
    galleryUrls: compact(images),
    stockStatus: quantity === 0 ? 'outofstock' : 'instock',
    stockQuantity: quantity,
    productType: text(valueAt(item, 'type')) || 'simple',
    virtual: text(valueAt(item, 'type')) === 'digital'
      || valueAt(item, 'is_shipping_required', 'requires_shipping') === false,
    downloadable: text(valueAt(item, 'type')) === 'digital',
    categoryNames: categories
  });
}

function generic(entity: CommerceEntity, item: JsonRecord) {
  const id = valueAt(item, 'id', 'coupon_id', 'reference_id');
  if (entity === 'orders') {
    const customer = asRecord(valueAt(item, 'customer', 'buyer')) || {};
    return normalizedEntity(item, {
      externalId: text(id),
      externalUpdatedAt: text(valueAt(item, 'updated_at', 'updatedAt')),
      orderNumber: text(valueAt(item, 'reference_id', 'number', 'id')),
      occurredAt: text(valueAt(item, 'date.date', 'created_at', 'createdAt')),
      status: text(valueAt(item, 'status.slug', 'status.name', 'status')),
      paymentStatus: text(valueAt(
        item,
        'payment_status',
        'payment.status',
        'status.slug'
      )),
      amountMinor: moneyMinor(valueAt(
        item,
        'amounts.total.amount',
        'total.amount',
        'total'
      )),
      currency: text(valueAt(
        item,
        'amounts.total.currency',
        'total.currency',
        'currency'
      )) || 'SAR',
      customerId: text(valueAt(customer, 'id')),
      customerEmail: text(valueAt(customer, 'email')),
      customerPhone: text(valueAt(customer, 'mobile', 'phone')),
      ...attributionFields(item)
    });
  }
  if (entity === 'customers') {
    return normalizedEntity(item, {
      externalId: text(id),
      externalUpdatedAt: text(valueAt(item, 'updated_at', 'updatedAt')),
      customerEmail: text(valueAt(item, 'email')),
      customerPhone: text(valueAt(item, 'mobile', 'phone'))
    });
  }
  return externalItem(item, id);
}

async function* pages(
  connection: ConnectionConfiguration,
  entity: CommerceEntity
): AsyncGenerator<EntityPage> {
  const path = PATHS[entity];
  if (!path) return;
  let page = 1;
  while (true) {
    assertPageLimit(page);
    const perPage = entity === 'orders' ? 30 : 100;
    const {data} = await remoteJson(
      withQuery(`${BASE}${path}`, {page, per_page: perPage}),
      {headers: headers(connection)}
    );
    const record = asRecord(data);
    const raw = Array.isArray(record?.data) ? record?.data || [] : [];
    const items = raw
      .map(asRecord)
      .filter(Boolean)
      .map(item => entity === 'products'
        ? product(item as JsonRecord)
        : generic(entity, item as JsonRecord));
    const pagination = asRecord(record?.pagination);
    const currentPage = numberValue(valueAt(pagination || {}, 'currentPage', 'current_page')) || page;
    const totalPages = numberValue(valueAt(pagination || {}, 'totalPages', 'total_pages'));
    const hasMore = totalPages != null
      ? currentPage < totalPages
      : items.length === perPage;
    yield {items, cursor: {page: currentPage}, hasMore};
    if (!hasMore) break;
    page = currentPage + 1;
  }
}

async function test(connection: ConnectionConfiguration): Promise<StoreIdentity> {
  const {data} = await remoteJson(`${BASE}/store/info`, {headers: headers(connection)});
  const store = asRecord(asRecord(data)?.data);
  if (!store || !text(store.id)) throw new Error('salla_store_identity_missing');
  return {
    externalStoreId: text(store.id),
    name: text(store.name) || 'Salla Store',
    currency: text(store.currency) || 'SAR',
    domain: text(store.domain),
    metadata: {
      plan: text(store.plan),
      storeType: text(store.type),
      verified: Boolean(store.verified)
    }
  };
}

export const sallaAdapter: CommerceAdapter = {test, pages};
