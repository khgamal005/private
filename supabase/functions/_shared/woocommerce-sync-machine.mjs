const SUPPORTED_ENTITIES=new Set([
  'categories',
  'attributes',
  'attribute_terms',
  'products',
  'variations',
  'coupons',
  'orders',
  'customers'
]);

function uniqueScope(scope){
  return [...new Set(Array.isArray(scope)?scope:[])]
    .filter(entity=>SUPPORTED_ENTITIES.has(entity));
}

function plain(entityType){
  return {kind:'plain',entityType};
}

function nested(parentEntity,childEntity,storeParent){
  return {kind:'nested',parentEntity,childEntity,storeParent};
}

export function buildWooSyncPlan(scope){
  const selected=new Set(uniqueScope(scope));
  const plan=[];

  if(selected.has('categories'))plan.push(plain('categories'));

  if(selected.has('attribute_terms')){
    plan.push(nested(
      'attributes',
      'attribute_terms',
      selected.has('attributes')
    ));
  }else if(selected.has('attributes')){
    plan.push(plain('attributes'));
  }

  if(selected.has('variations')){
    plan.push(nested(
      'products',
      'variations',
      selected.has('products')
    ));
  }else if(selected.has('products')){
    plan.push(plain('products'));
  }

  for(const entityType of ['coupons','orders','customers']){
    if(selected.has(entityType))plan.push(plain(entityType));
  }

  return plan;
}

export function initialWooSyncCursor(startedAt=new Date().toISOString()){
  return {
    v:2,
    step:0,
    mode:'metadata',
    page:1,
    totals:{},
    pages:{},
    remoteMetadata:{},
    retryCount:0,
    startedAt
  };
}

export function isWooSyncCursor(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  if(value.v!==2||!Number.isInteger(value.step)||value.step<0)return false;
  if(!['metadata','page','parent','children','complete'].includes(value.mode)){
    return false;
  }
  if(value.mode==='page'||value.mode==='parent'){
    return Number.isInteger(value.page)&&value.page>0;
  }
  if(value.mode==='children'){
    return Array.isArray(value.parentIds)
      &&value.parentIds.length<=100
      &&value.parentIds.every(id=>Number.isInteger(id)&&id>0)
      &&Number.isInteger(value.parentIndex)
      &&value.parentIndex>=0
      &&value.parentIndex<value.parentIds.length
      &&Number.isInteger(value.childPage)
      &&value.childPage>0;
  }
  return true;
}

function nextStepCursor(cursor,plan){
  const step=cursor.step+1;
  if(step>=plan.length){
    return {
      ...cursor,
      step:plan.length,
      mode:'complete',
      page:0,
      retryCount:0
    };
  }
  return {
    ...cursor,
    step,
    mode:plan[step].kind==='nested'?'parent':'page',
    page:1,
    retryCount:0
  };
}

export function cursorAfterWooMetadata(cursor,plan,remoteMetadata){
  const base={
    ...cursor,
    remoteMetadata:{
      ...(cursor.remoteMetadata||{}),
      ...(remoteMetadata||{})
    },
    retryCount:0
  };
  if(!plan.length){
    return {...base,step:0,mode:'complete',page:0};
  }
  return {
    ...base,
    step:0,
    mode:plan[0].kind==='nested'?'parent':'page',
    page:1
  };
}

export function cursorAfterWooPlainPage(cursor,plan,hasMore){
  if(hasMore){
    return {...cursor,page:cursor.page+1,retryCount:0};
  }
  return nextStepCursor(cursor,plan);
}

export function cursorAfterWooParentPage(
  cursor,
  plan,
  parentIds,
  hasMore
){
  const ids=[...new Set(parentIds||[])]
    .filter(id=>Number.isInteger(id)&&id>0)
    .slice(0,100);
  if(ids.length){
    return {
      ...cursor,
      mode:'children',
      parentPage:cursor.page,
      parentIds:ids,
      parentIndex:0,
      childPage:1,
      nextParentPage:hasMore?cursor.page+1:null,
      retryCount:0
    };
  }
  if(hasMore){
    return {...cursor,mode:'parent',page:cursor.page+1,retryCount:0};
  }
  return nextStepCursor(cursor,plan);
}

export function cursorAfterWooChildPage(cursor,plan,hasMore){
  if(hasMore){
    return {...cursor,childPage:cursor.childPage+1,retryCount:0};
  }
  if(cursor.parentIndex+1<cursor.parentIds.length){
    return {
      ...cursor,
      parentIndex:cursor.parentIndex+1,
      childPage:1,
      retryCount:0
    };
  }
  if(Number.isInteger(cursor.nextParentPage)&&cursor.nextParentPage>0){
    return {
      ...cursor,
      mode:'parent',
      page:cursor.nextParentPage,
      parentPage:undefined,
      parentIds:undefined,
      parentIndex:undefined,
      childPage:undefined,
      nextParentPage:undefined,
      retryCount:0
    };
  }
  return nextStepCursor(cursor,plan);
}

export function recordWooSyncPage(cursor,entityType,itemCount){
  const count=Number.isFinite(Number(itemCount))?Number(itemCount):0;
  return {
    ...cursor,
    totals:{
      ...(cursor.totals||{}),
      [entityType]:(Number(cursor.totals?.[entityType])||0)+count
    },
    pages:{
      ...(cursor.pages||{}),
      [entityType]:(Number(cursor.pages?.[entityType])||0)+1
    },
    retryCount:0
  };
}

export function wooSyncCompletion(cursor,completedAt=new Date().toISOString()){
  const startedAt=String(cursor?.startedAt||completedAt);
  const durationMs=Math.max(
    0,
    Date.parse(completedAt)-Date.parse(startedAt)||0
  );
  return {
    stats:{
      startedAt,
      completedAt,
      durationMs,
      totals:cursor?.totals||{},
      pages:cursor?.pages||{}
    },
    remoteMetadata:cursor?.remoteMetadata||{}
  };
}
