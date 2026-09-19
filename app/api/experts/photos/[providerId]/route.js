import {expertFile} from '../../../../../lib/expert-file-http';
export const runtime='nodejs';
export async function GET(request,{params}){const {providerId}=await params;return expertFile({id:providerId,kind:'photo',publicPhoto:true});}
