import InvitationActivationForm from '../../components/invitation-activation-form';
import MarktoneLogo from '../../components/marktone-logo';
import {publicRpc} from '../../lib/public-api';

export const dynamic='force-dynamic';
export const metadata={title:'تفعيل حساب المنشأة | Marktone Platform'};

export default async function AcceptInvitePage({searchParams}){
  const {token}=await searchParams;
  let invitation=null;
  let invalid=false;
  try{
    if(token)invitation=await publicRpc('v2_invitation_preview',{p_token:token});
    else invalid=true;
  }catch{invalid=true}

  return <main className="auth-page">
    <section className="auth-card narrow">
      <div className="auth-brand"><MarktoneLogo/></div>
      {invalid?<div className="auth-form">
        <div className="form-error">رابط الدعوة غير صالح أو انتهت صلاحيته.</div>
        <a className="mt-button primary" href="/login">العودة إلى تسجيل الدخول</a>
      </div>:<InvitationActivationForm token={token} invitation={invitation}/>}
    </section>
  </main>;
}
