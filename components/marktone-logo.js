import OdeirBrand from './odeir-brand';

export default function MarktoneLogo({
  subtitle='منصة إدارة المنشآت',
  compact=false,
  wordmark=false
}){
  return <OdeirBrand
    subtitle={wordmark?'':subtitle}
    compact={wordmark?false:compact}
    className={`marktone-logo ${wordmark?'marktone-logo-wordmark':''}`}
  />;
}
