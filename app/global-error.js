'use client';

import RuntimeErrorRecovery from '../components/runtime-error-recovery';

export default function GlobalError(props){
  return <html lang="ar" dir="rtl">
    <body style={{margin:0}}>
      <RuntimeErrorRecovery {...props}/>
    </body>
  </html>;
}
