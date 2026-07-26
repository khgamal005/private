import {Suspense} from 'react';import LoginForm from '../../components/login-form';import MarktoneLogo from '../../components/marktone-logo';
export const metadata={title:'تسجيل الدخول | Marktone Platform'};
export default function Login(){return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><MarktoneLogo/></div><div className="auth-copy"><p>منصة التشغيل المركزية</p><h1>سجّل الدخول لإدارة المنصات والمنشآت</h1><span>حساب واحد، صلاحيات دقيقة، وعزل كامل لبيانات كل منشأة.</span></div><Suspense><LoginForm/></Suspense></section></main>}
