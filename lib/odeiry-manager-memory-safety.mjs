const CATALOG=Object.freeze({
  goal_increase_registrations:{
    category:'goal',statement:'هدفنا زيادة التسجيلات',
    evidence:['هدفنا زيادة التسجيلات','هدفي زيادة التسجيلات',
      'our goal is to increase registrations',
      'my goal is to increase registrations']
  },
  goal_improve_conversion:{
    category:'goal',statement:'هدفنا تحسين معدل التحويل',
    evidence:['هدفنا تحسين معدل التحويل','هدفي تحسين معدل التحويل',
      'our goal is to improve conversion rate',
      'my goal is to improve conversion rate']
  },
  goal_reduce_response_time:{
    category:'goal',statement:'هدفنا تقليل زمن الاستجابة',
    evidence:['هدفنا تقليل زمن الاستجابة','هدفي تقليل زمن الاستجابة',
      'our goal is to reduce response time',
      'my goal is to reduce response time']
  },
  goal_improve_follow_up:{
    category:'goal',statement:'هدفنا تحسين انتظام المتابعة',
    evidence:['هدفنا تحسين انتظام المتابعة','هدفي تحسين انتظام المتابعة',
      'our goal is to improve follow-up consistency',
      'my goal is to improve follow-up consistency']
  },
  goal_improve_data_completeness:{
    category:'goal',statement:'هدفنا رفع اكتمال البيانات',
    evidence:['هدفنا رفع اكتمال البيانات','هدفي رفع اكتمال البيانات',
      'our goal is to improve data completeness',
      'my goal is to improve data completeness']
  },
  preference_concise_answers:{
    category:'preference',statement:'أفضّل إجابات مختصرة وواضحة',
    evidence:['أفضّل إجابات مختصرة وواضحة','افضل إجابات مختصرة وواضحة',
      'i prefer concise and clear answers']
  },
  preference_detailed_answers:{
    category:'preference',statement:'أفضّل إجابات تفصيلية',
    evidence:['أفضّل إجابات تفصيلية','افضل إجابات تفصيلية',
      'i prefer detailed answers']
  },
  preference_summary_first:{
    category:'preference',statement:'أفضّل أن يبدأ التقرير بالملخص التنفيذي',
    evidence:['أفضّل أن يبدأ التقرير بالملخص التنفيذي',
      'افضل أن يبدأ التقرير بالملخص التنفيذي',
      'i prefer the report to start with the executive summary']
  },
  preference_weekly_review:{
    category:'preference',statement:'أفضّل مراجعة المؤشرات أسبوعيًا',
    evidence:['أفضّل مراجعة المؤشرات أسبوعيًا',
      'افضل مراجعة المؤشرات أسبوعيا',
      'i prefer a weekly metrics review']
  },
  principle_data_first_decisions:{
    category:'operating_principle',
    statement:'مبدؤنا اتخاذ القرارات بناءً على البيانات',
    evidence:['مبدؤنا اتخاذ القرارات بناءً على البيانات',
      'مبدئي اتخاذ القرارات بناءً على البيانات',
      'our principle is to make decisions based on data',
      'my principle is to make decisions based on data']
  },
  principle_review_before_adoption:{
    category:'operating_principle',
    statement:'مبدؤنا مراجعة التغيير قبل اعتماده',
    evidence:['مبدؤنا مراجعة التغيير قبل اعتماده',
      'مبدئي مراجعة التغيير قبل اعتماده',
      'our principle is to review changes before approval',
      'my principle is to review changes before approval']
  },
  constraint_verified_numbers_only:{
    category:'constraint',statement:'قيدنا عدم اعتماد أرقام غير موثقة',
    evidence:['قيدنا عدم اعتماد أرقام غير موثقة',
      'قيدي عدم اعتماد أرقام غير موثقة',
      'our constraint is to reject unverified numbers',
      'my constraint is to reject unverified numbers']
  },
  constraint_read_only_recommendations:{
    category:'constraint',statement:'قيدنا إبقاء توصيات أوديري للقراءة فقط',
    evidence:['قيدنا إبقاء توصيات أوديري للقراءة فقط',
      'قيدي إبقاء توصيات أوديري للقراءة فقط',
      'our constraint is to keep odeiry recommendations read-only',
      'my constraint is to keep odeiry recommendations read-only']
  },
  priority_sales:{
    category:'decision_context',statement:'أولويتنا الحالية تحسين المبيعات',
    evidence:['أولويتنا الحالية تحسين المبيعات',
      'أولويتي الحالية تحسين المبيعات',
      'our current priority is improving sales',
      'my current priority is improving sales']
  },
  priority_operations:{
    category:'decision_context',statement:'أولويتنا الحالية تحسين التشغيل',
    evidence:['أولويتنا الحالية تحسين التشغيل',
      'أولويتي الحالية تحسين التشغيل',
      'our current priority is improving operations',
      'my current priority is improving operations']
  },
  priority_cash_collection:{
    category:'decision_context',statement:'أولويتنا الحالية تحسين التحصيل',
    evidence:['أولويتنا الحالية تحسين التحصيل',
      'أولويتي الحالية تحسين التحصيل',
      'our current priority is improving cash collection',
      'my current priority is improving cash collection']
  }
});

const PERSON_FACT=/(?:(?:^|[^A-Za-z])[A-Z][a-z]{1,24}(?:\s+[A-Z][a-z]{1,24}){0,2}\s+(?:(?:is|leads?|manages?|heads?)\b|(?:is\s+)?(?:to\s+)?(?:lead|manage|head)\b)|(?:^|[^\p{L}])[\p{L}]{2,20}\s+(?:هو|هي)\s+(?:مدير|مديرة|موظف|موظفة|عميل|عميلة|مسؤول|مسؤولة)|(?:يدير|تدير|يقود|تقود)\s+[\p{L}]{2,20}\s+(?:المبيعات|التسويق|القبول|الفريق|العمليات))/u;

export const MANAGER_MEMORY_CATALOG=Object.freeze(Object.fromEntries(
  Object.entries(CATALOG).map(([key,value])=>[
    key,Object.freeze({category:value.category,statement:value.statement})
  ])
));

export function canonicalManagerMemoryProposal(value){
  const memoryKey=String(value?.memoryKey||'').trim().toLowerCase();
  const category=String(value?.category||'').trim().toLowerCase();
  const statement=normalizedStatement(value?.statement);
  const evidenceQuote=String(value?.evidenceQuote||'').trim().normalize('NFKC');
  const sourceMessage=String(value?.sourceMessage??evidenceQuote)
    .trim().normalize('NFKC');
  const evidenceAssertion=normalizedEvidenceAssertion(evidenceQuote);
  const sourceAssertion=normalizedEvidenceAssertion(sourceMessage);
  const entry=CATALOG[memoryKey];
  if(!entry||category!==entry.category
     ||statement!==normalizedStatement(entry.statement)
     ||evidenceAssertion!==sourceAssertion
     ||!entry.evidence.includes(sourceAssertion))return null;
  return {memoryKey,category,statement:entry.statement};
}

export function containsManagerPersonFact(value){
  return PERSON_FACT.test(String(value||'').normalize('NFKC'));
}

function normalizedEvidenceAssertion(value){
  let normalized=String(value||'').normalize('NFKC').trim().toLowerCase()
    .replace(/\s+/gu,' ').replace(/[.!]+$/u,'').trim();
  normalized=normalized.replace(/^يا أوديري[،,]?\s*/u,'');
  normalized=normalized.replace(/^(?:من فضلك|لو سمحت)[،,]?\s*/u,'');
  normalized=normalized.replace(/^please[,]?\s+/u,'');
  normalized=normalized.replace(
    /^(?:احفظ|تذكر|تذكّر|اعتمد)\s+أن(?:ي|ني|نا)?\s+/u,''
  );
  normalized=normalized.replace(
    /^(?:remember|save|store|adopt)\s+that\s+/u,''
  );
  return normalized.trim();
}

function normalizedStatement(value){
  return String(value||'').normalize('NFKC').trim()
    .replace(/[.!؟]+$/u,'').replace(/\s+/gu,' ');
}
