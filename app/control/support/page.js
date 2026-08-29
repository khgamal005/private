import OdeirSupportDesk from '../../../components/odeir-support-desk';
import {getPlatformSupport} from '../../../lib/support-api';
import {requireAnyPlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

const PAGE_SIZE=50;
const QUEUES=new Set([
  'all','new','unassigned','mine','urgent','at_risk','breached','waiting_tenant'
]);
const STATUSES=new Set([
  'new','triage','in_progress','waiting_tenant','waiting_external',
  'resolved','closed','reopened','reviewing','approved','done','rejected'
]);
const PRIORITIES=new Set(['urgent','high','medium','low']);
const SUPPORT_PERMISSIONS=[
  'platform.support.read','platform.support.reply','platform.support.manage'
];

export default async function PlatformSupportPage({searchParams}){
  await requireAnyPlatformPermission(SUPPORT_PERMISSIONS);
  const query=await searchParams;
  const filters={
    ticketId:safeUuid(query?.ticket||query?.ticketId),
    queue:safeOption(query?.queue,QUEUES,'all'),
    query:safeText(query?.query,100),
    tenantId:safeUuid(query?.tenantId),
    status:safeOption(query?.status,STATUSES,null),
    priority:safeOption(query?.priority,PRIORITIES,null),
    assigneeId:safeUuid(query?.assigneeId),
    limit:PAGE_SIZE,
    cursorUpdatedAt:safeTimestamp(query?.cursorUpdatedAt),
    cursorId:safeUuid(query?.cursorId)
  };
  const [listData,detailData]=await Promise.all([
    getPlatformSupport({...filters,ticketId:null}),
    filters.ticketId
      ?getPlatformSupport({ticketId:filters.ticketId,limit:PAGE_SIZE})
      :Promise.resolve(null)
  ]);
  const selectedTicket=detailData?.tickets?.[0]||detailData?.ticket||null;

  return <OdeirSupportDesk
    mode="platform"
    data={{
      ...(listData&&typeof listData==='object'?listData:{}),
      selectedTicket,
      filters:{
        ...(listData?.filters&&typeof listData.filters==='object'?listData.filters:{}),
        ...filters
      }
    }}
  />;
}

function safeText(value,maxLength){
  return String(value||'').trim().slice(0,maxLength);
}

function safeUuid(value){
  const normalized=String(value||'').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ?normalized
    :null;
}

function safeOption(value,allowed,fallback){
  const normalized=String(value||'').trim().toLowerCase();
  return allowed.has(normalized)?normalized:fallback;
}

function safeTimestamp(value){
  if(!value)return null;
  const parsed=new Date(value);
  return Number.isNaN(parsed.getTime())?null:parsed.toISOString();
}