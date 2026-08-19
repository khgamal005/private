const DISTRIBUTION_STRATEGIES=Object.freeze({
  fair:Object.freeze({
    mode:'auto',
    label:'تلقائي Auto',
    detail:'توزيع عادل على الفريق المتاح'
  }),
  online_only:Object.freeze({
    mode:'auto',
    label:'تلقائي Auto',
    detail:'توزيع تلقائي على فريق المبيعات الأونلاين'
  }),
  selected:Object.freeze({
    mode:'manual',
    label:'يدوي Manual',
    detail:'اختيار أو إعادة إسناد بواسطة المشرف'
  })
});

export function leadDistributionMode(strategy){
  const key=String(strategy||'').trim();
  const configured=DISTRIBUTION_STRATEGIES[key];
  if(configured)return {key,...configured};
  return {
    key,
    mode:'unknown',
    label:'غير محدد',
    detail:key||'لم يُسجل مصدر الإسناد'
  };
}

export function presentLeadAssignment(assignment={}){
  const rawStrategy=assignment.strategyKey||assignment.strategy||'';
  const presentation=leadDistributionMode(rawStrategy);
  return {
    ...assignment,
    strategyKey:presentation.key,
    distributionMode:presentation.mode,
    distributionModeLabel:presentation.label,
    distributionModeDetail:presentation.detail,
    strategy:`[${presentation.label}] — ${presentation.detail}`
  };
}

export function presentLeadAssignments(assignments=[]){
  if(!Array.isArray(assignments))return [];
  return assignments.map(presentLeadAssignment);
}
