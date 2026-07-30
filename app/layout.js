import './globals.css';
import './marktone-theme.css';
import './rebuild.css';
import './action-feedback.css';
import './tenant-shell-polish.css';
import SystemActionFeedback from '../components/system-action-feedback';

export const metadata={title:'Marktone Platform Control',description:'منصة ماركتون لإدارة المنشآت'};
export default function RootLayout({children}){
  return <html lang="ar" dir="rtl"><body>{children}<SystemActionFeedback/></body></html>;
}
