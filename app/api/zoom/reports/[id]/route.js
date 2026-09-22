import {createHash} from 'node:crypto';
import {cookies} from 'next/headers';
import {ACCESS_COOKIE} from '../../../../../lib/config';
import {trainingRpc,trainingJson} from '../../../../../lib/training-server';
import {zoomErrorMessage,zoomErrorStatus} from '../../../../../lib/zoom-contract.mjs';
import {reportCsv} from '../../../../../supabase/functions/_shared/zoom-evidence.mjs';
export const dynamic='force-dynamic';
const header=['المحاضرة','الدورة','الدفعة','البداية UTC','الحالة','المضيف','الحساب','المدرب','المطلوب حضورهم','نتائج معتمدة','نسبة الزمن المعتمد','جودة الأدلة'];
const values=r=>[r.title,r.course_title,r.run_title,r.starts_at,r.state,r.host_name,r.account_name,r.instructor_name,r.expected_learners,r.approved_learners,r.attendance_percent,r.evidence_quality];
export async function GET(request,{params}){
 try{
  const {id}=await params;const url=new URL(request.url),slug=url.searchParams.get('tenant'),ticket=url.searchParams.get('token');
  if(!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug||'')||!/^[-0-9a-f]{36}$/.test(id)||!/^[a-f0-9]{64}$/.test(ticket||''))return trainingJson({error:'الرابط غير صالح.'},400);
  const token=(await cookies()).get(ACCESS_COOKIE)?.value;if(!token)return trainingJson({error:'سجّل الدخول لتنزيل تقريرك.'},401);
  const args={p_slug:slug,p_export_id:id,p_token_hash:createHash('sha256').update(ticket).digest('hex')};
  const first=await trainingRpc('v1_zoom_report_chunk',{...args,p_page:0},{token});let page=0;const encoder=new TextEncoder();
  const stream=new ReadableStream({async pull(controller){try{
   const chunk=page===0?first:await trainingRpc('v1_zoom_report_chunk',{...args,p_page:page},{token});
   const rows=chunk.rows.map(values);if(page===0){rows.unshift(header);rows.unshift(['الفترة',chunk.period.from,chunk.period.to,'بدء التجهيز',chunk.generatedFrom,'نهاية التجهيز',chunk.generatedTo]);}
   const csv=reportCsv(rows);controller.enqueue(encoder.encode((page===0?csv:csv.slice(1))+'\r\n'));page++;if(page>=first.pages)controller.close();
  }catch(error){controller.error(error);}}});
  return new Response(stream,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="odeir-zoom-report.csv"','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
 }catch(error){return trainingJson({error:zoomErrorMessage(error.code||error.message)},error.status||zoomErrorStatus(error.code||''));}
}
