import BuiltPublicPage from '../../components/built-public-page';
import {odeirHomeContent,odeirPreviewSnapshot} from '../../lib/odeir-preview-content';

export const metadata={
  title:'معاينة أودير | ODEIR',
  description:'معاينة واجهة أودير الجديدة لإدارة وتشغيل المنشآت.',
  robots:{index:false,follow:false}
};

export default function OdeirPreviewPage(){
  return <BuiltPublicPage snapshot={odeirPreviewSnapshot} content={odeirHomeContent}/>;
}
