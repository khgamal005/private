import PlatformRegistrationRequests from '../../../components/platform-registration-requests';
import {getPlatformRegistrationRequests} from '../../../lib/platform-registration-requests';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

const PAGE_SIZE=25;

function firstValue(source,keys,fallback=null){
  for(const key of keys){
    const value=source?.[key];
    if(value!==undefined&&value!==null&&value!=='')return value;
  }
  return fallback;
}

function safeText(value,fallback=''){
  const text=String(value??'').trim();
  return text||fallback;
}

function safeNumber(value,fallback=0){
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?number:fallback;
}

function safeOffset(value){
  return Math.max(0,Math.floor(safeNumber(value,0)/PAGE_SIZE)*PAGE_SIZE);
}

function safeFilter(value){
  const normalized=safeText(value,'all').toLowerCase();
  return [
    'all','awaiting_email','pending_review','under_review','approved',
    'rejected','converted','trust_pending','trust_review','trust_restricted',
    'manual_attention','trust_attention','restricted'
  ].includes(normalized)?normalized:'all';
}

function safeQuery(value){
  return safeText(value).normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,80);
}

function safeStatus(value){
  const normalized=safeText(value,'pending_review').toLowerCase();
  if(['pending','pending_review'].includes(normalized))return 'pending_review';
  if(['reviewing','in_review','under_review'].includes(normalized))return 'under_review';
  return [
    'approved','rejected','converted','awaiting_email','trust_pending',
    'trust_review','trust_restricted'
  ].includes(normalized)
    ?normalized
    :'unknown';
}

function safeDate(value){
  if(!value)return null;
  const date=new Date(value);
  return Number.isNaN(date.getTime())?null:date.toISOString();
}

function sanitizeListItem(item){
  return {
    id:safeText(firstValue(item,['id','requestId','request_id'])),
    reference:safeText(firstValue(item,[
      'reference','requestReference','request_reference','requestRef','request_ref'
    ]),'—'),
    institutionName:safeText(firstValue(item,[
      'institutionName','institution_name','organizationName','organization_name','name'
    ]),'منشأة دون اسم'),
    institutionState:safeText(firstValue(item,[
      'institutionState','institution_state','accountState','account_state'
    ]),'new'),
    commercialRegistration:safeText(firstValue(item,[
      'commercialRegistration','commercial_registration','commercialRegistrationNumber',
      'commercial_registration_number','crNumber','cr_number'
    ])),
    nationalRegistration:safeText(firstValue(item,[
      'nationalRegistration','national_registration','nationalNumber','national_number'
    ])),
    tvtcLicense:safeText(firstValue(item,[
      'tvtcLicense','tvtc_license','tvtcLicenseNumber','tvtc_license_number',
      'trainingLicense','training_license'
    ])),
    contactName:safeText(firstValue(item,['contactName','contact_name','applicantName','applicant_name'])),
    contactTitle:safeText(firstValue(item,['contactTitle','contact_title','jobTitle','job_title'])),
    status:safeStatus(firstValue(item,['status','requestStatus','request_status'])),
    requestStatus:safeText(firstValue(item,['requestStatus','request_status'])),
    activationMode:safeText(firstValue(item,['activationMode','activation_mode']),'manual_review'),
    trustStatus:safeText(firstValue(item,['trustStatus','trust_status']),'pending_review'),
    emailConfirmedAt:safeDate(firstValue(item,['emailConfirmedAt','email_confirmed_at'])),
    version:safeNumber(firstValue(item,['version','rowVersion','row_version']),0),
    createdAt:safeDate(firstValue(item,['createdAt','created_at','submittedAt','submitted_at'])),
    updatedAt:safeDate(firstValue(item,['updatedAt','updated_at'])),
    dueAt:safeDate(firstValue(item,['dueAt','due_at','reviewDueAt','review_due_at'])),
    reviewerName:safeText(firstValue(item,[
      'reviewerName','reviewer_name','assignedReviewerName','assigned_reviewer_name'
    ])),
    tenantSlug:safeText(firstValue(item,['tenantSlug','tenant_slug','provisionedTenantSlug','provisioned_tenant_slug'])),
    provisionedTenantId:safeText(firstValue(item,[
      'provisionedTenantId','provisioned_tenant_id','tenantId','tenant_id'
    ]))
  };
}

function sanitizeSummary(summary,total){
  return {
    pendingReview:safeNumber(firstValue(summary,['pendingReview','pending_review','pending','pendingCount','pending_count'])),
    underReview:safeNumber(firstValue(summary,['underReview','under_review','inReview','in_review','reviewing','reviewingCount','reviewing_count'])),
    approved:safeNumber(firstValue(summary,['approved','approvedCount','approved_count'])),
    rejected:safeNumber(firstValue(summary,['rejected','rejectedCount','rejected_count'])),
    converted:safeNumber(firstValue(summary,['converted','convertedCount','converted_count'])),
    awaitingEmail:safeNumber(firstValue(summary,['awaitingEmail','awaiting_email'])),
    trustPending:safeNumber(firstValue(summary,['trustPending','trust_pending'])),
    trusted:safeNumber(firstValue(summary,['trusted','trustedCount','trusted_count'])),
    trustRestricted:safeNumber(firstValue(summary,['trustRestricted','trust_restricted'])),
    total:safeNumber(firstValue(summary,['total','totalCount','total_count']),total)
  };
}

export default async function RegistrationRequestsPage({searchParams}){
  await requirePlatformPermission('platform.tenants.manage');
  const params=await searchParams;
  const offset=safeOffset(params?.offset);
  const filter=safeFilter(params?.status);
  const query=safeQuery(params?.query);
  const result=await getPlatformRegistrationRequests({
    status:filter==='all'?null:filter,
    query:query||null,
    offset,
    limit:PAGE_SIZE
  });
  const total=safeNumber(result?.total,result?.items?.length||0);
  const resolvedOffset=safeOffset(result?.offset??offset);
  const resolvedLimit=Math.min(50,Math.max(1,safeNumber(result?.limit,PAGE_SIZE)));
  const items=(Array.isArray(result?.items)?result.items:[])
    .map(sanitizeListItem)
    .filter(item=>item.id);

  return <PlatformRegistrationRequests initialQuery={query} initialFilter={filter} initialData={{
    summary:sanitizeSummary(result?.summary||{},total),
    items,
    total,
    offset:resolvedOffset,
    limit:resolvedLimit
  }}/>;
}
