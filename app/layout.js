import './globals.css';
import './marktone-theme.css';
import './rebuild.css';

export const metadata={title:'Marktone Platform Control',description:'منصة ماركتون لإدارة المنشآت'};
export default function RootLayout({children}){
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
