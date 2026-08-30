import {getPageGuide,getRoleGuide} from './role-guide-content.js';

export const ODEIRY_OPERATION_TOPICS=[
  'current_role','current_page','lead_intake','sales_follow_up','admissions',
  'training','tasks_calendar','team_permissions','reports','integrations',
  'dashboard'
];

const TOPIC_CONFIG={
  current_role:{page:'overview',workflows:[]},
  current_page:{page:null,workflows:[]},
  lead_intake:{
    page:'lead-queue',
    workflows:[
      ['data_officer','import_batch'],
      ['data_officer','fix_invalid_rows'],
      ['sales_manager','distribute_leads']
    ]
  },
  sales_follow_up:{
    page:'sales',
    workflows:[
      ['sales_user','sales_followup'],
      ['sales_user','sales_payment'],
      ['sales_user','sales_paid'],
      ['sales_user','sales_close'],
      ['sales_manager','payment_push']
    ]
  },
  admissions:{
    page:'admissions',
    workflows:[
      ['customer_service','admission_review'],
      ['customer_service','document_followup'],
      ['customer_service','complete_registration']
    ]
  },
  training:{
    page:'courses',
    workflows:[
      ['training_manager','create_course_run'],
      ['training_manager','attendance'],
      ['training_manager','certificate']
    ]
  },
  tasks_calendar:{page:'tasks',workflows:[]},
  team_permissions:{
    page:'team',
    workflows:[['tenant_owner','owner_access']]
  },
  reports:{
    page:'reports',
    workflows:[
      ['tenant_owner','owner_daily_review'],
      ['sales_manager','coach_sales_user']
    ]
  },
  integrations:{
    page:'integrations',
    workflows:[['tenant_owner','owner_integrations']]
  },
  dashboard:{
    page:'overview',
    workflows:[['tenant_owner','owner_daily_review']]
  }
};

const PAGE_BY_MODULE={
  dashboard:'overview',tasks_calendar:'tasks',courses:'courses',
  sales_crm:'sales',admissions:'admissions',team_permissions:'team',
  reports:'reports',integrations:'integrations',performance:'reports',
  login_access:'settings'
};

const ROLE_LABELS={
  tenant_owner:'مالك المنشأة',tenant_admin:'مدير المنشأة',
  executive_manager:'المدير التنفيذي',sales_manager:'مدير المبيعات',
  sales_supervisor:'مشرف المبيعات',sales_user:'مسؤول المبيعات',
  customer_service:'خدمة العملاء',data_officer:'مسؤول البيانات',
  data_analyst:'محلل البيانات',training_manager:'مدير التدريب',
  admissions_officer:'مسؤول التسجيل والقبول',platform_owner:'إدارة المنصة',
  member:'مستخدم المنشأة'
};

const LEAD_INTAKE_FACTS=[
  'مسار الشاشة هو «توزيع العملاء» (lead-queue).',
  'رفع الملفات يقبل Excel بصيغتي .xlsx و.xls، ويقبل CSV بصيغة .csv.',
  'يمكن تنزيل القالب الجاهز marktone-lead-intake-template.xlsx من شاشة الرفع.',
  'الحد الأقصى للملف الواحد 5000 صف.',
  'الحقول التي يتعرف عليها الرفع تشمل: الاسم، الجوال، واتساب، البريد، المنشأة، البرنامج أو الدورة، المصدر، الحملة، مجموعة الإعلان، الإعلان، والملاحظات.',
  'بعد اختيار الملف تظهر معاينة؛ الإجراء الموثق هو «فحص وإضافة إلى Queue» قبل التوزيع.',
  'طرق التوزيع الموثقة: توزيع عادل على الفريق المتاح، فريق الأونلاين فقط، أو موظفون محددون.',
  'التوزيع يتطلب موعدًا مستقبليًا لأول متابعة، وينشئ موعدًا ومهمة مستقلة لكل عميل.'
];

export function buildOdeiryOperationalGuide({topic,viewer,uiContext={}}){
  const config=TOPIC_CONFIG[topic];
  if(!config){
    return {available:false,reason:'unsupported_topic',sources:[]};
  }
  const safeViewer=normalizeViewer(viewer);
  const guideRoleKey=safeViewer.roleKey==='admissions_officer'
    ?'customer_service':safeViewer.roleKey;
  const roleGuide=getRoleGuide(
    guideRoleKey,safeViewer.permissions,safeViewer.platformAccess
  );
  const pageKey=config.page||PAGE_BY_MODULE[uiContext?.module]||'overview';
  const page=getPageGuide(
    pageKey==='overview'?'/tenant/odeiry':'/tenant/odeiry/'+pageKey,
    'odeiry'
  );
  const workflows=topic==='current_role'||topic==='current_page'
    ?currentRoleWorkflows(roleGuide,pageKey,safeViewer)
    :configuredWorkflows(config.workflows,safeViewer);
  const facts=topic==='lead_intake'?LEAD_INTAKE_FACTS:[];
  const sources=sourceDocuments(topic,page,workflows,facts,safeViewer);

  return {
    available:true,
    mode:'documented_read_only_guidance',
    viewer:{
      roleKey:safeViewer.roleKey,
      roleLabel:ROLE_LABELS[safeViewer.roleKey]||ROLE_LABELS.member,
      accessMode:safeViewer.accessMode,
      executionPolicy:safeViewer.platformAccess
        ?'observe_and_explain_only':'follow_confirmed_permissions_only'
    },
    safety:{
      containsLiveTenantData:false,
      canReadCustomerOrEmployeeRecords:false,
      canModifyData:false,
      canCreateTickets:false
    },
    role:{
      headline:short(roleGuide.headline,220),
      summary:short(roleGuide.summary,500),
      responsibilities:list(roleGuide.responsibilities,6,300),
      checklist:(roleGuide.checklist||[]).slice(0,6).map(item=>({
        title:short(item.title,180),description:short(item.description,320),
        page:short(item.href,80)||null
      }))
    },
    page:{
      key:short(page.key,80),title:short(page.title,220),
      description:short(page.description,600),
      steps:list(page.steps,6,500),goldenRule:short(page.goldenRule,400)
    },
    workflows:workflows.slice(0,5),
    facts,
    sources
  };
}

function currentRoleWorkflows(roleGuide,pageKey,viewer){
  const workflows=Array.isArray(roleGuide.workflows)?roleGuide.workflows:[];
  const matching=workflows.filter(item=>{
    const href=String(item.href||'overview');
    return pageKey==='overview'||href===pageKey||href.startsWith(pageKey+'/');
  });
  return (matching.length?matching:workflows).slice(0,5).map(item=>
    workflowDocument(item,viewer,viewer.roleKey)
  );
}

function configuredWorkflows(entries,viewer){
  const output=[];
  for(const [roleKey,workflowId] of entries){
    const guide=getRoleGuide(roleKey,[],true);
    const workflow=(guide.workflows||[]).find(item=>item.id===workflowId);
    if(workflow)output.push(workflowDocument(workflow,viewer,roleKey));
  }
  return output;
}

function workflowDocument(item,viewer,recommendedRoleKey){
  const permission=typeof item.permission==='string'?item.permission:null;
  return {
    id:short(item.id,80),title:short(item.title,220),
    description:short(item.description,600),page:short(item.href,100)||null,
    recommendedRoleKey,
    recommendedRoleLabel:ROLE_LABELS[recommendedRoleKey]||ROLE_LABELS.member,
    requiredPermission:permission,
    viewerAccess:viewer.platformAccess
      ?'observe_only'
      :permission
        ?viewer.permissions.includes(permission)?'confirmed':'not_confirmed'
        :viewer.roleKey===recommendedRoleKey?'role_documented':'not_confirmed',
    steps:list(item.steps,7,600),tip:short(item.tip,400)||null
  };
}

function sourceDocuments(topic,page,workflows,facts,viewer){
  const sources=[{
    sourceId:`guide.page.${page.key}`,
    title:`دليل شاشة: ${page.title}`
  },{
    sourceId:`guide.role.${viewer.roleKey}`,
    title:`دليل دور: ${ROLE_LABELS[viewer.roleKey]||ROLE_LABELS.member}`
  }];
  for(const workflow of workflows){
    sources.push({
      sourceId:`guide.workflow.${workflow.id}`,
      title:`مسار عمل: ${workflow.title}`
    });
  }
  if(topic==='lead_intake'&&facts.length){
    sources.push({
      sourceId:'component.lead-intake-workspace',
      title:'شاشة رفع وتوزيع العملاء في أودير'
    });
  }
  return sources.slice(0,8);
}

function normalizeViewer(value){
  const permissions=Array.isArray(value?.permissions)
    ?value.permissions.filter(item=>typeof item==='string').slice(0,120):[];
  const platformAccess=value?.platformAccess===true;
  return {
    roleKey:typeof value?.roleKey==='string'?value.roleKey:'member',
    permissions,
    accessMode:platformAccess?'platform_operator':'tenant_member',
    platformAccess
  };
}

function list(value,limit,maxCharacters){
  return (Array.isArray(value)?value:[]).slice(0,limit)
    .map(item=>short(item,maxCharacters)).filter(Boolean);
}

function short(value,maxCharacters){
  if(typeof value!=='string')return '';
  return [...value.trim()].slice(0,maxCharacters).join('');
}
