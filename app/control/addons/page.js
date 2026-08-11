import Link from 'next/link';
import PlatformAddonConsole from '../../../components/platform-addon-console';
import {getPlatformAddonCenter,getPlatformCommerce} from '../../../lib/api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PlatformAddonsPage(){
  await requirePlatformPermission('platform.billing.manage');
  const [center,commerce]=await Promise.all([
    getPlatformAddonCenter(),getPlatformCommerce()
  ]);
  const commerceProducts=new Map((commerce.addons||[]).map(item=>[item.key,item]));
  const initialData={
    ...center,
    addonCategories:commerce.addonCategories||[],
    tenants:center.tenants||commerce.tenants||[],
    products:(center.products||[]).map(item=>({
      ...item,
      categoryId:commerceProducts.get(item.key)?.categoryId||null,
      categoryName:commerceProducts.get(item.key)?.categoryName||null
    }))
  };
  return <>
    <div style={{display:'flex',justifyContent:'flex-end',marginBottom:16}}>
      <Link href="/control/addons/bank-transfers" style={{padding:'10px 14px',border:'1px solid #cfd8e3',borderRadius:10,fontWeight:700,textDecoration:'none'}}>
        مراجعة التحويلات البنكية
      </Link>
    </div>
    <PlatformAddonConsole initialData={initialData}/>
  </>;
}
