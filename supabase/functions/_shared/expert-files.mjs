import {validateExpertApplication} from './expert-application.mjs';

export const EXPERTISE_OPTIONS=['إدارة المشروعات','القيادة والإدارة','إدارة الأعمال','ريادة الأعمال','الموارد البشرية','التسويق والمبيعات','خدمة العملاء','المحاسبة والمالية','التحليل المالي والاستثمار','إدارة الجودة','التخطيط الاستراتيجي','مؤشرات الأداء','إدارة المخاطر والحوكمة','سلاسل الإمداد والخدمات اللوجستية','التقنية والبرمجة','تحليل البيانات وذكاء الأعمال','الذكاء الاصطناعي','الأمن السيبراني','التحول الرقمي','التصميم والإعلام','التعليم وتصميم التدريب','تدريب المدربين','المهارات الشخصية والتواصل','اللغات والترجمة','القانون والامتثال','الصحة والسلامة المهنية','السياحة والضيافة','الهندسة والصناعة','الاستدامة والبيئة','أخرى'];
export const LANGUAGE_OPTIONS=['العربية','الإنجليزية','الفرنسية','الألمانية','الإسبانية','الإيطالية','التركية','الصينية','اليابانية','الكورية','الروسية','البرتغالية','الأردية','الهندية','البنغالية','الإندونيسية','الفارسية','لغة الإشارة','أخرى'];
export const CV_MAX=5*1024*1024,PHOTO_MAX=2*1024*1024,BODY_MAX=CV_MAX+PHOTO_MAX+64*1024;
export const PHOTO_TYPES=['image/jpeg','image/png','image/webp'];
export const BUCKET='expert-application-files';
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function validateChoices(value){
  for(const [key,options,max] of [['expertise',EXPERTISE_OPTIONS,10],['languages',LANGUAGE_OPTIONS,10]]){
    const list=String(value[key]||'').split(/[,،\n]+/).map(s=>s.trim());
    if(!list.length||list.length>max||new Set(list).size!==list.length||list.some(s=>!options.includes(s)))throw fail('اختر من قائمة التخصصات واللغات، حتى ١٠ اختيارات لكل قائمة.');
  }
  return value;
}
export function fileProblem(file,kind){
  if(!file?.size)return 'الملف فارغ.';
  if(file.size>(kind==='cv'?CV_MAX:PHOTO_MAX))return kind==='cv'?'السيرة الذاتية يجب ألا تتجاوز ٥ ميجابايت.':'الصورة يجب ألا تتجاوز ٢ ميجابايت.';
  if(kind==='cv'&&(file.type!=='application/pdf'||!file.name.toLowerCase().endsWith('.pdf')))return 'ارفع السيرة الذاتية بصيغة PDF.';
  if(kind==='photo'&&!PHOTO_TYPES.includes(file.type))return 'اختر صورة بصيغة JPG أو PNG أو WebP.';
  return '';
}
export async function boundedBytes(request,max=BODY_MAX){
  if(Number(request.headers.get('content-length')||0)>max)throw fail('حجم الطلب أكبر من المسموح.',413);
  const reader=request.body?.getReader();if(!reader)throw fail('الطلب فارغ.');
  const chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max){await reader.cancel();throw fail('حجم الطلب أكبر من المسموح.',413);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export function validSignature(bytes,mime){
  const ascii=(a,b)=>new TextDecoder().decode(bytes.subarray(a,b));
  if(mime==='application/pdf')return ascii(0,5)==='%PDF-'&&ascii(Math.max(0,bytes.length-1024)).includes('%%EOF');
  if(mime==='image/jpeg')return bytes.length>4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217;
  if(mime==='image/png')return bytes.length>32&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)&&ascii(12,16)==='IHDR'&&ascii(bytes.length-8,bytes.length-4)==='IEND';
  if(mime==='image/webp')return bytes.length>20&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'&&new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true)+8===bytes.length;
  return false;
}
export async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function parseExpertMultipart(request){
  if(!request.headers.get('content-type')?.startsWith('multipart/form-data;'))throw fail('نوع الطلب غير مدعوم.',415);
  const bytes=await boundedBytes(request);let form;
  try{form=await new Response(bytes,{headers:{'content-type':request.headers.get('content-type')}}).formData();}catch{throw fail('بيانات الطلب غير صالحة.');}
  if(form.get('website'))return {honeypot:true};
  for(const key of form.keys())if(!['payload','requestKey','cv','photo','website'].includes(key)||form.getAll(key).length!==1)throw fail('بيانات الطلب غير صالحة.');
  let payload;try{payload=validateChoices(validateExpertApplication(JSON.parse(String(form.get('payload')))));}catch(error){throw fail(error.message);}
  const requestKey=String(form.get('requestKey')||'').toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey))throw fail('أعد إرسال النموذج.');
  const files=[];
  for(const kind of ['cv','photo']){
    const file=form.get(kind);if(!file)continue;
    if(typeof file==='string')throw fail('اختر ملفًا صالحًا.');
    const problem=fileProblem(file,kind);if(problem)throw fail(problem,file.size>(kind==='cv'?CV_MAX:PHOTO_MAX)?413:415);
    const content=new Uint8Array(await file.arrayBuffer());if(!validSignature(content,file.type))throw fail('الملف تالف أو لا يطابق صيغته.',415);
    const name=file.name.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,160);
    files.push({kind,name,mimeType:file.type,size:file.size,sha256:await sha256(content),bytes:content});
  }
  if(!files.length)throw fail('اختر السيرة الذاتية أو الصورة.');
  return {payload,requestKey,files};
}
