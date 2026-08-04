export const CMS_SECTIONS=Object.freeze([
  {key:'overview',label:'نظرة عامة',icon:'⌂'},
  {key:'pages',label:'الصفحات',icon:'▤'},
  {key:'menus',label:'القوائم والميجا منيو',icon:'☷'},
  {key:'articles',label:'المقالات',icon:'✎'},
  {key:'media',label:'مكتبة الوسائط',icon:'▧'},
  {key:'messages',label:'رسائل الموقع',icon:'✉'},
  {key:'settings',label:'إعدادات الموقع',icon:'⚙'}
]);

export function cmsBasePath(context={}){
  return context.scope==='tenant'&&context.tenantSlug
    ?`/tenant/${encodeURIComponent(context.tenantSlug)}/website`
    :'/control/website';
}

export function cmsBuilderPath(context={},entityType,entityId){
  return `${cmsBasePath(context)}/builder/${entityType}/${entityId}`;
}

export function cmsPreviewPath(context={},entityType,entityId){
  return `/cms-preview/${encodeURIComponent(context.siteKey||'marktone-main')}/${entityType}/${entityId}`;
}

export function cmsPublicPath(context={},entityType,entity={}){
  const tenantPrefix=context.scope==='tenant'&&context.tenantSlug
    ?`/site/${encodeURIComponent(context.tenantSlug)}`:'';
  if(entityType==='article')return `${tenantPrefix}/articles/${encodeURIComponent(entity.slug||'')}`;
  if(entity.isHome)return tenantPrefix||'/';
  return `${tenantPrefix}/p/${encodeURIComponent(entity.slug||'')}`;
}

export function tenantSiteKey(slug){
  return `tenant:${String(slug||'').trim().toLowerCase()}`;
}

export function buildMenuTree(items=[],menuId=null){
  const filtered=(Array.isArray(items)?items:[])
    .filter(item=>!menuId||item.menuId===menuId)
    .map(item=>({...item,children:[]}));
  const byId=new Map(filtered.map(item=>[item.id,item]));
  const roots=[];
  for(const item of filtered){
    const parent=item.parentId?byId.get(item.parentId):null;
    if(parent)parent.children.push(item);
    else roots.push(item);
  }
  const sort=rows=>rows
    .sort((a,b)=>(a.columnIndex-b.columnIndex)||(a.sortOrder-b.sortOrder)||String(a.label).localeCompare(String(b.label),'ar'))
    .map(item=>({...item,children:sort(item.children||[])}));
  return sort(roots);
}

export function flattenMenuTree(items=[],depth=0,result=[]){
  for(const item of items){
    result.push({...item,depth});
    flattenMenuTree(item.children||[],depth+1,result);
  }
  return result;
}

export function slugify(value,prefix='item'){
  const normalized=String(value||'').trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'')
    .slice(0,80);
  return normalized||`${prefix}-${Date.now().toString(36)}`;
}

export function formatCmsDate(value,{time=true}={}){
  if(!value)return '—';
  try{
    return new Intl.DateTimeFormat('ar-SA',time
      ?{dateStyle:'medium',timeStyle:'short'}
      :{dateStyle:'medium'}).format(new Date(value));
  }catch{return '—';}
}

export function formatBytes(value){
  const bytes=Math.max(0,Number(value)||0);
  if(bytes<1024)return `${bytes} B`;
  if(bytes<1024**2)return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024**2).toFixed(1)} MB`;
}
