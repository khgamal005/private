export default function MarktoneLogo({subtitle='Platform Control',compact=false}){
  return <div className={`marktone-logo ${compact?'compact':''}`}>
    <svg viewBox="0 0 260 92" role="img" aria-label="Marktone" dir="ltr" style={{direction:'ltr',unicodeBidi:'isolate'}} focusable="false" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="258" height="90" rx="18" fill="#0b2a4d" stroke="rgba(255,255,255,.12)"/>
      <path d="M22 58 C29 58 30 29 38 29 C46 29 45 67 53 67 C61 67 62 23 70 23 C77 23 78 55 84 58" fill="none" stroke="#13c7d1" strokeWidth="6" strokeLinecap="round"/>
      <path d="M70 23 C78 20 82 32 84 58" fill="none" stroke="#f0c534" strokeWidth="6" strokeLinecap="round"/>
      <text x="100" y="56" direction="ltr" textAnchor="start" fill="#ffffff" fontFamily="Arial, sans-serif" fontSize="30" fontWeight="700">Marktone</text>
      <text x="101" y="74" direction="ltr" textAnchor="start" fill="#91a6bb" fontFamily="Arial, sans-serif" fontSize="8" fontWeight="600" letterSpacing="2.3">PLATFORM CONTROL</text>
    </svg>
    {!compact&&<span>{subtitle}</span>}
  </div>;
}
