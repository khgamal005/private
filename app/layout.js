import './globals.css';
import './marktone-theme.css';
import './rebuild.css';
import './action-feedback.css';
import './tenant-shell-polish.css';
import SystemActionFeedback from '../components/system-action-feedback';

export const metadata={title:'Marktone Platform Control',description:'منصة ماركتون لإدارة المنشآت'};
export default function RootLayout({children}){
  return <html lang="ar" dir="rtl">
    <head>
      <link rel="preconnect" href="https://fonts.googleapis.com"/>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap" rel="stylesheet"/>
    </head>
    <body style={{'--font-arabic':'IBM Plex Sans Arabic, Segoe UI, Tahoma, Arial, sans-serif','--font-latin':'Manrope, Arial, sans-serif',fontFamily:'var(--font-arabic)'}}>{children}<SystemActionFeedback/></body>
  </html>;
}
