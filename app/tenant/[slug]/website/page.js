import Link from 'next/link';
import CmsStudio from '../../../../components/cms-studio';
import {authRpc,requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function TenantWebsitePage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.website.read');

  let data=null;
  let addonRequired=false;
  try{
    data=await authRpc('v3_cms_workspace_snapshot',{
      p_site_key:'marktone-main',
      p_tenant_slug:slug
    });
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    if(!detail.includes('cms_addon_required'))throw error;
    addonRequired=true;
  }

  if(addonRequired)return <CmsAddonRequired slug={slug}/>;
  return <CmsStudio initialData={data}/>;
}

function CmsAddonRequired({slug}){
  return <section className="mt-panel" style={{overflow:'hidden',padding:0}}>
    <div style={{padding:'36px',background:'linear-gradient(135deg,#06182e,#0d3158)',color:'#fff'}}>
      <span style={{display:'inline-flex',padding:'7px 11px',borderRadius:'999px',background:'rgba(230,179,78,.16)',color:'#f2c96e',fontWeight:900,fontSize:'12px'}}>إضافة احترافية مدفوعة</span>
      <h1 style={{fontSize:'34px',margin:'16px 0 10px'}}>Marktone CMS Pro</h1>
      <p style={{maxWidth:'760px',lineHeight:1.9,color:'#cbd8e5',margin:0}}>حوّل منشأتك إلى موقع متكامل بصفحات قابلة للتصميم، متجر دورات، مقالات، ميجا منيو، مكتبة وسائط، نماذج مرتبطة بالعملاء، وتتبع للحملات — من داخل منصة ماركتون نفسها.</p>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:'14px',padding:'28px'}}>
      {['مصمم صفحات مرئي','صفوف وأعمدة مرنة','صفحات هبوط للحملات','مقالات وSEO','قوائم وميجا منيو','مكتبة صور','نشر وإصدارات'].map(item=><article key={item} style={{padding:'18px',border:'1px solid #e1e7ed',borderRadius:'14px',background:'#fff'}}><b>{item}</b><p style={{fontSize:'12px',color:'#708092',margin:'8px 0 0'}}>جزء من نفس المحرك الذي يدير موقع ماركتون.</p></article>)}
    </div>
    <footer style={{display:'flex',gap:'10px',flexWrap:'wrap',padding:'0 28px 28px'}}>
      <Link href={`/tenant/${encodeURIComponent(slug)}/settings`} className="mt-button mt-button-primary">طلب تفعيل الإضافة</Link>
      <Link href={`/tenant/${encodeURIComponent(slug)}`} className="mt-button">العودة للوحة القيادة</Link>
    </footer>
  </section>;
}
