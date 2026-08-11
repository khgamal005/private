import * as XLSX from 'xlsx';
import {
  ASSIGNMENT_METRIC_CONTRACT_VERSION,
  leadIntakeDateBasis
} from '../../../../lib/assignment-metric-contract.mjs';
import {authRpc} from '../../../../lib/server-auth';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const GENERAL_REPORTS=new Set(['overview','employees','employee','sales','campaigns']);
const LEAD_INTAKE_REPORT='lead-intake';
const GENERAL_PAGE_SIZE=100;
const DETAIL_EXPORT_LIMIT=100000;
const DETAIL_COLLECTIONS=['tasks','activities','calls','leads'];
const SECTION_KEYS={
  metrics:['summary'],
  employees:['employees'],
  campaigns:['campaigns'],
  courses:['courses'],
  details:['details'],
  calls:['calls'],
  extensions:['extensions'],
  callEmployees:['extensions','performance','dashboard'],
  queue:['queue'],
  batches:['batches'],
  assignments:['assignments'],
  analytics:['analytics'],
  team:['team'],
  all:null
};

function isoStart(value){
  if(!value)return null;
  const date=new Date(`${value}T00:00:00+03:00`);
  return Number.isNaN(date.getTime())?null:date.toISOString();
}

function isoEnd(value){
  if(!value)return null;
  const date=new Date(`${value}T23:59:59.999+03:00`);
  return Number.isNaN(date.getTime())?null:date.toISOString();
}

function safe(value){
  if(value===null||value===undefined)return '';
  if(value instanceof Date)return value.toISOString();
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value;
  return JSON.stringify(value);
}

function flatObject(value,prefix='',result={}){
  for(const [key,current] of Object.entries(value||{})){
    const next=prefix?`${prefix}.${key}`:key;
    if(current&&typeof current==='object'&&!Array.isArray(current))flatObject(current,next,result);
    else result[next]=safe(current);
  }
  return result;
}

function uniqueSheetName(workbook,name){
  const base=String(name||'data').replace(/[\\/?*\[\]:]/g,'_').slice(0,31)||'data';
  if(!workbook.Sheets[base])return base;
  let index=2;
  while(index<1000){
    const suffix=`_${index}`;
    const candidate=`${base.slice(0,31-suffix.length)}${suffix}`;
    if(!workbook.Sheets[candidate])return candidate;
    index+=1;
  }
  return `${base.slice(0,27)}_999`;
}

function appendRows(workbook,name,rows){
  const normalized=rows.length?rows:[{message:'لا توجد بيانات ضمن الفلاتر الحالية'}];
  const sheet=XLSX.utils.json_to_sheet(normalized);
  XLSX.utils.book_append_sheet(workbook,sheet,uniqueSheetName(workbook,name));
}

function appendValue(workbook,name,value){
  if(Array.isArray(value)){
    appendRows(workbook,name,value.map(item=>item&&typeof item==='object'&&!Array.isArray(item)?flatObject(item):{value:safe(item)}));
    return;
  }
  if(value&&typeof value==='object'){
    const primitive={};
    let hasPrimitive=false;
    for(const [key,current] of Object.entries(value)){
      if(current&&typeof current==='object')appendValue(workbook,`${name}_${key}`,current);
      else{primitive[key]=safe(current);hasPrimitive=true;}
    }
    if(hasPrimitive)appendRows(workbook,name,[primitive]);
    return;
  }
  appendRows(workbook,name,[{value:safe(value)}]);
}

function reportDataKeys(data,section){
  const requested=SECTION_KEYS[section]??SECTION_KEYS.all;
  if(requested)return requested.filter(key=>key in (data||{}));
  return Object.keys(data||{}).filter(key=>key!=='generatedAt');
}

async function loadCallContext(payload,rpcParams,first){
  const [performance,dashboard,departments]=await Promise.all([
    authRpc('v4_tenant_reports_snapshot',{
      p_slug:payload.slug,
      p_from:payload.from||null,
      p_to:payload.to||null,
      p_staff_id:payload.staffId||null,
      p_report:'employees',
      p_limit:GENERAL_PAGE_SIZE,
      p_offset:0
    }).catch(()=>({})),
    authRpc('v2_tenant_role_dashboard_snapshot_v3',{
      p_slug:payload.slug
    }).catch(()=>({})),
    authRpc('v4_tenant_yeastar_department_snapshot',{
      p_slug:payload.slug,
      p_from:rpcParams.p_from,
      p_to:rpcParams.p_to,
      p_extension:rpcParams.p_extension,
      p_call_type:rpcParams.p_call_type,
      p_status:rpcParams.p_status
    }).catch(()=>[])
  ]);
  return {...first,performance,dashboard,departments};
}

async function loadCallReport(payload){
  const rpcParams={
    p_slug:payload.slug,
    p_from:isoStart(payload.from),
    p_to:isoEnd(payload.to),
    p_extension:payload.extension||null,
    p_call_type:payload.callType||null,
    p_status:payload.status||null,
    p_limit:500,
    p_offset:0
  };
  const first=await authRpc('v3_tenant_yeastar_reports_snapshot',rpcParams);
  let data=await loadCallContext(payload,rpcParams,first);
  if(!['all','calls'].includes(payload.section||'all'))return data;

  const total=Math.max(0,Number(first?.totalRecords)||0);
  const calls=[...(first?.calls||[])];
  let offset=calls.length;
  while(offset<total){
    const page=await authRpc('v3_tenant_yeastar_reports_snapshot',{
      ...rpcParams,
      p_offset:offset
    });
    const rows=Array.isArray(page?.calls)?page.calls:[];
    if(!rows.length)break;
    calls.push(...rows);
    offset+=rows.length;
  }
  data={...data,calls};
  return data;
}

async function loadLeadIntakeReport(payload){
  const optional=value=>value&&value!=='all'?value:null;
  return authRpc('v3_tenant_lead_intake_export_v1',{
    p_slug:payload.slug,
    p_section:payload.section||'assignments',
    p_from:payload.from||null,
    p_to:payload.to||null,
    p_quality:optional(payload.quality),
    p_source:optional(payload.source),
    p_campaign:optional(payload.campaign),
    p_batch_id:optional(payload.batchId),
    p_validation:optional(payload.validation),
    p_query:optional(payload.query)
  });
}

async function loadGeneralReport(payload){
  const params={
    p_slug:payload.slug,
    p_report:payload.report,
    p_from:payload.from||null,
    p_to:payload.to||null,
    p_staff_id:payload.staffId||null,
    p_limit:GENERAL_PAGE_SIZE,
    p_offset:0
  };
  const first=await authRpc('v4_tenant_reports_snapshot',params);
  const section=payload.section||'all';
  if(payload.report!=='employee'||!['all','details'].includes(section))return first;

  const details={};
  for(const key of DETAIL_COLLECTIONS){
    details[key]=Array.isArray(first?.details?.[key])?[...first.details[key]]:[];
  }
  let needsMore=DETAIL_COLLECTIONS.some(key=>details[key].length===GENERAL_PAGE_SIZE);
  let offset=GENERAL_PAGE_SIZE;

  while(needsMore&&offset<DETAIL_EXPORT_LIMIT){
    const page=await authRpc('v4_tenant_reports_snapshot',{
      ...params,
      p_offset:offset
    });
    needsMore=false;
    for(const key of DETAIL_COLLECTIONS){
      const rows=Array.isArray(page?.details?.[key])?page.details[key]:[];
      if(rows.length)details[key].push(...rows);
      if(rows.length===GENERAL_PAGE_SIZE)needsMore=true;
    }
    offset+=GENERAL_PAGE_SIZE;
  }

  if(needsMore){
    throw new Error('report_export_limit_exceeded');
  }
  return {...first,details};
}

function fileName(payload){
  const report=String(payload.report||'report').replace(/[^a-z0-9_-]/gi,'-');
  const from=String(payload.from||'from').replace(/[^0-9-]/g,'');
  const to=String(payload.to||'to').replace(/[^0-9-]/g,'');
  return `Modaar-${report}-${from}-${to}.xlsx`;
}

export async function POST(request){
  try{
    const payload=await request.json();
    if(!payload?.slug||!payload?.report)return Response.json({error:'بيانات التقرير غير مكتملة'},{status:400});
    const isLeadIntake=payload.report===LEAD_INTAKE_REPORT;
    if(
      payload.report!=='calls'
      &&!GENERAL_REPORTS.has(payload.report)
      &&!isLeadIntake
    )return Response.json({error:'نوع التقرير غير مدعوم'},{status:400});

    if(!isLeadIntake){
      const access=await authRpc('v2_tenant_report_filter_options',{p_slug:payload.slug});
      if(!access?.canUseAnalytics)return Response.json({error:'لا تملك صلاحية تحليل وتصدير التقارير'},{status:403});

      const allowedStaff=new Set((access.staff||[]).map(item=>item.staffId));
      if(payload.staffId&&!allowedStaff.has(payload.staffId))return Response.json({error:'الموظف المحدد خارج نطاق الصلاحية'},{status:403});
      const allowedExtensions=new Set((access.extensions||[]).map(item=>String(item.extension)));
      if(payload.extension&&!allowedExtensions.has(String(payload.extension)))return Response.json({error:'التحويلة المحددة خارج نطاق الصلاحية'},{status:403});
    }

    const data=isLeadIntake
      ?await loadLeadIntakeReport(payload)
      :payload.report==='calls'
        ?await loadCallReport(payload)
        :await loadGeneralReport(payload);
    const workbook=XLSX.utils.book_new();
    appendRows(workbook,'filters',[{
      report:payload.report,
      section:payload.section||'all',
      from:payload.from||'',
      to:payload.to||'',
      staffId:payload.staffId||'',
      extension:payload.extension||'',
      callType:payload.callType||'',
      status:payload.status||'',
      quality:payload.quality||'',
      source:payload.source||'',
      campaign:payload.campaign||'',
      batchId:payload.batchId||'',
      validation:payload.validation||'',
      query:payload.query||'',
      dateBasis:isLeadIntake
        ?leadIntakeDateBasis(payload.section||'assignments').field
        :'event_specific',
      metricContract:isLeadIntake
        ?ASSIGNMENT_METRIC_CONTRACT_VERSION
        :'reporting-v4',
      exportedAt:new Date().toISOString()
    }]);
    for(const key of reportDataKeys(data,payload.section||'all'))appendValue(workbook,key,data[key]);
    const output=XLSX.write(workbook,{bookType:'xlsx',type:'buffer',compression:true});
    const filename=fileName(payload);
    return new Response(output,{
      status:200,
      headers:{
        'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control':'no-store'
      }
    });
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    console.error('[tenant-reports] xlsx export failed',{message});
    if(message.includes('report_export_limit_exceeded')){
      return Response.json({error:'حجم التقرير كبير جدًا للتصدير دفعة واحدة. قلّل المدى الزمني ثم أعد المحاولة.'},{status:413});
    }
    return Response.json({error:'تعذر إنشاء ملف إكسيل من التقرير الحالي'},{status:500});
  }
}
