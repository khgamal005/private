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
  configuration,
  externalItem,
  itemsFrom,
  moneyMinor,
  normalizedProduct,
  numberValue,
  remoteJson,
  secret,
  stripHtml,
  text,
  valueAt,
  withQuery
} from '../shared.ts';

function headers(connection: ConnectionConfiguration) {
  const type = configuration(connection, 'authType');
  if (type === 'api_key') return {'X-API-Key': secret(connection, 'apiKey')};
  if (type === 'bearer') return {Authorization: `Bearer ${secret(connection, 'bearerToken')}`};
  if (type === 'basic') {
    const token = btoa(`${secret(connection, 'basicUsername')}:${secret(connection, 'basicPassword')}`);
    return {Authorization: `Basic ${token}`};
  }
  return {};
}

function isPrivateIpv4(ip: string) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value))) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] === 0;
}

function isPrivateIpv6(ip: string) {
  const value = ip.toLowerCase();
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || value.startsWith('fe8') || value.startsWith('fe9')
    || value.startsWith('fea') || value.startsWith('feb');
}

async function safeBase(connection: ConnectionConfiguration) {
  const url = new URL(configuration(connection, 'baseUrl'));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('custom_public_https_required');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('custom_private_host_blocked');
  }
  try {
    const ipv4 = await Deno.resolveDns(host, 'A');
    const ipv6 = await Deno.resolveDns(host, 'AAAA').catch(() => [] as string[]);
    if ([...ipv4, ...ipv6].some(ip => isPrivateIpv4(ip) || isPrivateIpv6(ip))) {
      throw new Error('custom_private_host_blocked');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'custom_private_host_blocked') throw error;
    throw new Error('custom_host_resolution_failed');
  }
  return url.toString().replace(/\/$/, '');
}

function product(item: JsonRecord) {
  const quantity = numberValue(valueAt(item, 'stock_quantity', 'quantity', 'inventory'));
  return normalizedProduct(item, {
    externalId: text(valueAt(item, 'id', 'uuid')),
    externalUpdatedAt: text(valueAt(item, 'updated_at', 'updatedAt')),
    sku: text(valueAt(item, 'sku', 'code')),
    titleAr: text(valueAt(item, 'title_ar', 'name_ar', 'name', 'title')),
    titleEn: text(valueAt(item, 'title_en', 'name_en')),
    description: stripHtml(valueAt(item, 'description')),
    regularPriceMinor: moneyMinor(valueAt(item, 'regular_price', 'price')),
    salePriceMinor: moneyMinor(valueAt(item, 'sale_price')),
    priceMinor: moneyMinor(valueAt(item, 'price', 'sale_price')),
    currency: text(valueAt(item, 'currency')) || 'SAR',
    status: text(valueAt(item, 'status')) || 'active',
    externalUrl: text(valueAt(item, 'url', 'external_url')),
    primaryImageUrl: text(valueAt(item, 'image', 'primary_image_url')),
    galleryUrls: Array.isArray(item.images) ? item.images : [],
    stockStatus: quantity === 0 ? 'outofstock' : 'instock',
    stockQuantity: quantity,
    productType: text(valueAt(item, 'type')) || 'simple',
    virtual: Boolean(valueAt(item, 'virtual')),
    downloadable: Boolean(valueAt(item, 'downloadable'))
  });
}

async function* pages(
  connection: ConnectionConfiguration,
  entity: CommerceEntity
): AsyncGenerator<EntityPage> {
  const base = await safeBase(connection);
  let page = 1;
  while (page <= 300) {
    const {data} = await remoteJson(withQuery(`${base}/${entity}`, {page, per_page: 100}), {
      headers: headers(connection)
    });
    const raw = itemsFrom(data, entity);
    const items = raw.map(item => entity === 'products'
      ? product(item)
      : externalItem(item, valueAt(item, 'id', 'uuid', 'code')));
    const record = asRecord(data) || {};
    const pagination = asRecord(record.pagination) || {};
    const totalPages = numberValue(valueAt(pagination, 'total_pages', 'totalPages'));
    const next = valueAt(record, 'next', 'next_page');
    const hasMore = totalPages != null ? page < totalPages : Boolean(next) || items.length === 100;
    yield {items, cursor: {page}, hasMore};
    if (!hasMore) break;
    page += 1;
  }
}

async function test(connection: ConnectionConfiguration): Promise<StoreIdentity> {
  const base = await safeBase(connection);
  const {data} = await remoteJson(base, {headers: headers(connection)});
  const record = asRecord(data) || {};
  return {
    externalStoreId: text(valueAt(record, 'id', 'store_id', 'uuid')) || new URL(base).hostname,
    name: text(valueAt(record, 'name', 'store_name')) || new URL(base).hostname,
    currency: text(valueAt(record, 'currency')) || 'SAR',
    domain: base,
    metadata: {contract: 'marktone-commerce-v1'}
  };
}

export const customAdapter: CommerceAdapter = {test, pages};
