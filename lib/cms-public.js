import 'server-only';

import {SUPABASE_KEY,SUPABASE_URL} from './config';
import {FALLBACK_PUBLIC_SITE,getPublicSiteSnapshot} from './public-site';

const ALLOW_LEGACY_FALLBACK=process.env.CMS_V3_LEGACY_FALLBACK==='true';
import {tenantSiteKey} from './cms';

async function rpc(name,body){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${SUPABASE_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store'
  });
  if(!response.ok){
    const detail=await response.text();
    throw new Error(`${name}: ${response.status} ${detail.slice(0,400)}`);
  }
  return response.json();
}

export async function getCmsPublicSnapshot({
  siteKey='marktone-main',
  tenantSlug=null,
  pageSlug=null,
  articleSlug=null
}={}){
  const resolvedSiteKey=tenantSlug?tenantSiteKey(tenantSlug):siteKey;
  try{
    const data=await rpc('v3_cms_public_snapshot',{
      p_site_key:resolvedSiteKey,
      p_page_slug:pageSlug,
      p_article_slug:articleSlug
    });
    if(data?.available)return data;
  }catch(error){
    console.error('cms_public_snapshot_failed',{
      siteKey:resolvedSiteKey,
      message:error instanceof Error?error.message:String(error)
    });
  }
  if(resolvedSiteKey==='marktone-main'&&ALLOW_LEGACY_FALLBACK){
    console.warn('cms_public_legacy_fallback_enabled',{siteKey:resolvedSiteKey,pageSlug,articleSlug});
    const legacy=await getPublicSiteSnapshot({pageSlug,articleSlug});
    return {...legacy,cmsFallback:'v2'};
  }
  return {
    ...FALLBACK_PUBLIC_SITE,
    available:false,
    cmsError:'v3_snapshot_unavailable',
    site:{...FALLBACK_PUBLIC_SITE.site,key:resolvedSiteKey}
  };
}
