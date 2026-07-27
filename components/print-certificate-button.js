'use client';

export default function PrintCertificateButton(){
  return <button onClick={()=>window.print()}>
    طباعة أو حفظ PDF
  </button>;
}
