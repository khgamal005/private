import TrainingAccessForm from '../../../components/training-access-form';

export const metadata={title:'دخول المتدرب | أودير',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function TrainingLoginPage({searchParams}){
  const search=await searchParams;
  const role=search?.role==='instructor'||search?.next==='/training/marktone?role=instructor'?'instructor':'learner';
  return <main style={{maxWidth:480,margin:'8vh auto',padding:24}}><TrainingAccessForm initialRole={role}/></main>;
}
