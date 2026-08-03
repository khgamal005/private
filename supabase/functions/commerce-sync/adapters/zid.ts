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
  valueAt,
  withQuery
} from '../shared.ts';

const BASE = 'https://api.zid.sa/v1';

function productHeaders(connection: ConnectionConfiguration) {
  return {
    'Access-Token': secret(connection, 'accessToken'),
    'Store-Id': configuration(connection, 'storeId'),
    'Accept-Language': 'ar',
    Role: 'Manager'
  };
}

function managerHeaders(connection: ConnectionConfiguration) {
  return {
    Authorization: secret(connection, 'authorizationToken'),
    'X-Manager-Token': secret(connection, 'accessToken'),
    'Accept-Language': 'ar',
    Accept: 'application/json'
  };
}

function product(item: JsonRecord) {
  const images = listAt(item, 'images')
    .map(asRecord)
    .filter(Boolean)
    .map(image => text(valueAt(image as JsonRecord, 'image.url', 'url', 'full_size')))
    .filter(Boolean);
  const categories = listAt(item, 'categories')
    .map(asRecord)
    .filter(Boolean)
    .map(category => text(valueAt(category as JsonRecord, 'name.ar', 'name', 'names.ar')))
    .filter(Boolean);
  const quantity = numberValue(valueAt(item, 'quantity'));
  const isDraft = Boolean(valueAt(item, 'is_draft'));
  return normalizedProduct(item, {
    externalId: text(valueAt(item, 'id')),
    externalUpdatedAt: text(valueAt(item, 'updated_at')),
    sku: text(valueAt(item, 'sku')),
    titleAr: text(valueAt(item, 'name.ar', 'name')),
    titleEn: text(valueAt(item, 'name.en')),
    description: stripHtml(valueAt(item, 'description.ar', 'short_description.ar')),
    regularPriceMinor: moneyMinor(valueAt(item, 'price')),
    salePriceMinor: moneyMinor(valueAt(item, 'sale_price')),
    priceMinor: moneyMinor(valueAt(item, 'sale_price', 'price')),
    currency: text(valueAt(item, 'currency')) || 'SAR',
    status: isDraft ? 'draft' : 'active',
    externalUrl: text(valueAt(item, 'html_url')),
    primaryImageUrl: images[0] || '',
    galleryUrls: compact(images),
    stockStatus: quantity === 0 ? 'outofstock' : 'instock',
    stockQuantity: quantity,
    productType: text(valueAt(item, 'product_class')) || 'simple',
    virtual: !Boolean(valueAt(item, 'requires_shipping')),
    downloadable: text(valueAt(item, 'product_class')) === 'downloadable',
    categoryNames: categories
  });
}

async function* products(connection: ConnectionConfiguration): AsyncGenerator<EntityPage> {
  let page = 1;
  while (true) {
    assertPageLimit(page);
    const {data} = await remoteJson(
      withQuery(`${BASE}/products/`, {page, page_size: 100}),
      {headers: productHeaders(connection)}
    );
    const record = asRecord(data) || {};
    const raw = Array.isArray(record.results) ? record.results : [];
    const items = raw.map(asRecord).filter(Boolean).map(item => product(item as JsonRecord));
    const hasMore = Boolean(record.next) && items.length > 0;
    yield {items, cursor: {page}, hasMore};
    if (!hasMore) break;
    page += 1;
  }
}

const managerPaths: Partial<Record<CommerceEntity, string>> = {
  categories: '/managers/store/categories',
  coupons: '/managers/store/coupons',
  orders: '/managers/store/orders',
  customers: '/managers/store/customers'
};

function managerItems(entity: CommerceEntity, record: JsonRecord) {
  const key = entity === 'categories' ? 'categories'
    : entity === 'coupons' ? 'coupons'
    : entity === 'orders' ? 'orders'
    : 'customers';
  return Array.isArray(record[key]) ? record[key] as unknown[] : [];
}

function managerEntity(entity: CommerceEntity, item: JsonRecord) {
  const externalId = valueAt(item, 'id', 'uuid', 'coupon_id', 'invoice_number');
  if (entity === 'orders') {
    const customer = asRecord(valueAt(item, 'customer', 'client', 'shipping.address')) || {};
    return normalizedEntity(item, {
      externalId: text(externalId),
      externalUpdatedAt: text(valueAt(item, 'updated_at', 'updatedAt')),
      orderNumber: text(valueAt(item, 'invoice_number', 'order_number', 'id')),
      occurredAt: text(valueAt(item, 'created_at', 'createdAt', 'date')),
      status: text(valueAt(item, 'status.code', 'status.name', 'status')),
      paymentStatus: text(valueAt(
        item,
        'payment_status.code',
        'payment_status.name',
        'payment_status',
        'payment.status'
      )),
      amountMinor: moneyMinor(valueAt(
        item,
        'order_total',
        'order_amount',
        'total.amount',
        'total',
        'amount'
      )),
      currency: text(valueAt(
        item,
        'currency.code',
        'currency',
        'total.currency'
      )) || 'SAR',
      customerId: text(valueAt(customer, 'id', 'uuid')),
      customerEmail: text(valueAt(customer, 'email')),
      customerPhone: text(valueAt(customer, 'mobile', 'phone')),
      ...attributionFields(item)
    });
  }
  if (entity === 'customers') {
    return normalizedEntity(item, {
      externalId: text(externalId),
      externalUpdatedAt: text(valueAt(item, 'updated_at', 'updatedAt')),
      customerEmail: text(valueAt(item, 'email')),
      customerPhone: text(valueAt(item, 'mobile', 'phone'))
    });
  }
  return externalItem(item, externalId);
}

async function* managerPages(
  connection: ConnectionConfiguration,
  entity: CommerceEntity
): AsyncGenerator<EntityPage> {
  const path = managerPaths[entity];
  if (!path) return;
  let page = 1;
  let after = 0;
  while (true) {
    assertPageLimit(page);
    const query = entity === 'customers'
      ? {after, per_page: 100}
      : entity === 'categories'
        ? {}
        : {page, per_page: 100, payload_type: entity === 'orders' ? 'full' : null};
    const {data} = await remoteJson(withQuery(`${BASE}${path}`, query), {
      headers: managerHeaders(connection)
    });
    const record = asRecord(data) || {};
    const items = managerItems(entity, record)
      .map(asRecord)
      .filter(Boolean)
      .map(item => managerEntity(entity, item as JsonRecord));
    let hasMore = false;
    if (entity === 'customers') {
      const next = numberValue(record.next_cursor);
      hasMore = next != null && next > after && items.length > 0;
      after = next || after;
    } else if (entity !== 'categories') {
      const total = numberValue(valueAt(record, 'total', 'grand_total', 'total_count'));
      hasMore = total != null ? page * 100 < total : items.length === 100;
    }
    yield {items, cursor: {page, after}, hasMore};
    if (!hasMore) break;
    page += 1;
  }
}

async function* pages(
  connection: ConnectionConfiguration,
  entity: CommerceEntity
): AsyncGenerator<EntityPage> {
  if (entity === 'products') {
    yield* products(connection);
    return;
  }
  yield* managerPages(connection, entity);
}

async function test(connection: ConnectionConfiguration): Promise<StoreIdentity> {
  const {data} = await remoteJson(
    withQuery(`${BASE}/products/`, {page: 1, page_size: 1}),
    {headers: productHeaders(connection)}
  );
  const record = asRecord(data);
  if (!record || !Array.isArray(record.results)) throw new Error('zid_products_unavailable');
  const storeId = configuration(connection, 'storeId');
  return {
    externalStoreId: storeId,
    name: `Zid Store ${storeId}`,
    currency: text(valueAt(asRecord(record.results[0]) || {}, 'currency')) || 'SAR',
    metadata: {productsCount: numberValue(record.total_products_count) || 0}
  };
}

export const zidAdapter: CommerceAdapter = {test, pages};
