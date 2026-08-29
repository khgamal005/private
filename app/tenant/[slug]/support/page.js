import OdeirSupportDesk from '../../../../components/odeir-support-desk';
import {getTenantSupport} from '../../../../lib/support-api';
import {hasPlatformPermission,requireTenant} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

const PAGE_SIZE=25;
const PLATFORM_SUPPORT_PERMISSIONS=[
  'platform.support.read','platform.support.reply','platform.support.manage'
];

export default async function TenantSupportPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const context=await requireTenant(slug);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const isPlatformReader=PLATFORM_SUPPORT_PERMISSIONS.some(permission=>
    hasPlatformPermission(context,permission)
  );
  const canViewAll=Boolean(
    membership?.permissions?.includes('tenant.support.read_all')
    ||isPlatformReader
  );

  const ticketId=safeUuid(query?.ticket||query?.ticketId);
  const scope=isPlatformReader?'all':query?.scope==='all'&&canViewAll?'all':'mine';
  const cursorUpdatedAt=safeTimestamp(query?.cursorUpdatedAt);
  const cursorId=safeUuid(query?.cursorId);
  const listOptions={
    scope,
    limit:PAGE_SIZE,
    cursorUpdatedAt,
    cursorId
  };
  const [listData,detailData]=await Promise.all([
    getTenantSupport(slug,listOptions),
    ticketId
      ?getTenantSupport(slug,{ticketId,scope,limit:PAGE_SIZE})
      :Promise.resolve(null)
  ]);
  const selectedTicket=detailData?.tickets?.[0]||detailData?.ticket||null;

  return <OdeirSupportDesk
    mode="tenant"
    slug={slug}
    data={{
      ...(listData&&typeof listData==='object'?listData:{}),
      selectedTicket,
      filters:{
        ...(listData?.filters&&typeof listData.filters==='object'?listData.filters:{}),
        scope,
        limit:PAGE_SIZE,
        ticketId,
        cursorUpdatedAt,
        cursorId
      }
    }}
  />;
}

function safeUuid(value){
  const normalized=String(value||'').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ?normalized
    :null;
}

function safeTimestamp(value){
  if(!value)return null;
  const parsed=new Date(value);
  return Number.isNaN(parsed.getTime())?null:parsed.toISOString();
}