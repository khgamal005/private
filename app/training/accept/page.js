import TrainingAccessForm from '../../../components/training-access-form';

export const metadata={title:'تفعيل حساب التدريب | أودير',robots:{index:false,follow:false},referrer:'no-referrer'};
export default function AcceptTrainingInvitationPage(){
  return <main style={{maxWidth:480,margin:'8vh auto',padding:24}}><TrainingAccessForm invitation/></main>;
}
