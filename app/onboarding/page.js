import Link from 'next/link';
import {requirePlatform} from '../../lib/server-auth';
import {getControl} from '../../lib/api';
import OnboardingForm from '../../components/onboarding-form';

export const dynamic='force-dynamic';

export default async function Onboarding(){
  await requirePlatform();
  const data=await getControl();
  return <main className="onboarding">
    <section className="onboarding-head">
      <span>MARKTONE PROVISIONING</span>
      <h1>إنشاء منشأة جديدة</h1>
      <p>دورة واحدة تنشئ المنشأة ومساحتها المعزولة، وتربط الباقة والموديلات والدومين ومالك المنشأة.</p>
      <Link href="/control">العودة إلى لوحة التحكم</Link>
    </section>
    <OnboardingForm plans={data.plans||[]}/>
  </main>;
}
