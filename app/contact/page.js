import OdeirContactPage from '../../components/odeir-contact-page';
import {getCmsPublicSnapshot} from '../../lib/cms-public';

export const dynamic='force-dynamic';
export const metadata={
  title:'تواصل معنا | أودير',
  description:'تواصل مع فريق أودير للاستفسارات المتعلقة بالمنصة والدعم والاشتراكات والتكاملات والخصوصية وأمن المعلومات.'
};

export default async function ContactPage(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  return <OdeirContactPage snapshot={snapshot}/>;
}
