import {permanentRedirect} from 'next/navigation';

export default function ExistingPolicyPage(){
  permanentRedirect('/p/terms-of-use');
}
