import {Suspense} from 'react';import LoginForm from '../../components/login-form';import MarktoneLogo from '../../components/marktone-logo';
export const metadata={title:'تسجيل دخول المنشآت | أودير'};
export default function Login(){return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><MarktoneLogo/></div><div className="auth-copy"><p>مساحة منشأتك في أودير</p><h1>سجّل الدخول وتابع العمل من مكان واحد</h1><span>حساب واحد، صلاحيات دقيقة، وعزل كامل لبيانات كل منشأة.</span></div><Suspense><LoginForm/></Suspense></section></main>}
