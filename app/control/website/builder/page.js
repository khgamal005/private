import {redirect} from 'next/navigation';
import {requirePlatform} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function BuilderHomePage(){
  await requirePlatform();
  redirect('/control/website?section=pages');
}
