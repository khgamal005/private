import {expertFile} from '../../../../../../lib/expert-file-http';
export const runtime='nodejs';
export async function GET(request,{params}){const {applicationId,kind}=await params;return expertFile({id:applicationId,kind});}
