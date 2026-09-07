'use client';
import Link from 'next/link';
export default function PricingError({reset}){
  return <main dir="rtl" style={{maxWidth:720,margin:'8vh auto',padding:24}}><h1>تعذر تحميل الأسعار الآن</h1><p>لم نعرض أسعارًا قديمة أو تقديرية. أعد المحاولة للاطلاع على الكتالوج الحالي.</p><button type="button" onClick={reset}>إعادة المحاولة</button><p><Link href="/">العودة إلى الرئيسية</Link></p></main>;
}
