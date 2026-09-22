import Link from 'next/link';
import AcademyIcon from './academy-icon';
import OdeirBrand from './odeir-brand';
import styles from './training-portal-shell.module.css';

export default function TrainingPortalShell({slug,tenantName,role='learner',workspace='odeir',children}){
  const academy=workspace==='academy';
  const instructor=role==='instructor';
  return <div className={styles.portal} dir="rtl">
    <header className={styles.topbar}>
      <Link className={styles.brand} href={academy?`/site/${encodeURIComponent(slug)}`:'/'} aria-label="العودة إلى الموقع"><OdeirBrand compact subtitle="منصة التدريب"/></Link>
      <div className={styles.tenant}><span>{tenantName?.trim()?.[0]||'أ'}</span><div><small>{instructor?'مساحة المحاضر':'مساحة المتدرب'}</small><strong>{tenantName}</strong></div></div>
      <nav aria-label="روابط بوابة التدريب">
        {academy&&<Link href={`/site/${encodeURIComponent(slug)}`} target="_blank" rel="noopener noreferrer"><AcademyIcon name="website"/><span>الموقع</span></Link>}
        {academy&&<Link href={`/site/${encodeURIComponent(slug)}/courses`} target="_blank" rel="noopener noreferrer"><AcademyIcon name="courses"/><span>الدورات</span></Link>}
        <form action="/api/auth/logout" method="post"><input type="hidden" name="workspace" value="training"/><input type="hidden" name="trainingWorkspace" value={workspace}/><input type="hidden" name="tenant" value={slug}/><input type="hidden" name="role" value={role}/><button type="submit"><AcademyIcon name="logout"/><span>تسجيل الخروج</span></button></form>
      </nav>
    </header>
    <div className={styles.context}><span><AcademyIcon name={instructor?'teaching':'user'} size={18}/>{instructor?'بوابة المحاضر':'بوابة المتدرب'}</span><p>{instructor?'دفعاتك وحضورك وتقييماتك في مكان واحد.':'دوراتك ومواعيدك ونتائجك في مكان واحد.'}</p></div>
    <div className={styles.content}>{children}</div>
  </div>;
}
