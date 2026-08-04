import Link from 'next/link';
import styles from './website-control-nav.module.css';

export default function WebsiteControlLayout({children}){
  return <>
    <nav className={styles.nav} aria-label="أدوات إدارة الموقع">
      <Link href="/control/website">إدارة المحتوى</Link>
      <Link href="/control/website/builder">مصمم الصفحات</Link>
      <span>الهيدر والفوتر عالميان · محتوى الصفحات قابل للتصميم المرئي</span>
    </nav>
    {children}
  </>;
}
