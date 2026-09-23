'use client';

import {useState} from 'react';
import styles from './zoom-workspace.module.css';

const kinds={draft:'مسودة الدورة',release:'نسخة التأليف المنشورة',unit:'وحدة التعلّم',version:'فهرس المنهج المنشور',event:'سجل نشر المنهج'};
export function ZoomRetention({action,busy}){
 const [page,setPage]=useState(null),[preview,setPreview]=useState(null);
 async function load(offset=0){const result=await action('derivative_snapshot',{offset},'حُدثت طلبات مراجعة المشتقات.');if(result){setPage(result);setPreview(null);}}
 async function review(draftId){setPreview(null);const result=await action('derivative_preview',{draftId},'راجِع نطاق الحذف قبل التأكيد.');if(result)setPreview(result);}
 return <section className={styles.card} aria-label="حذف مشتقات زووم"><h2>مراجعة حذف المشتقات التعليمية</h2>
  <p>بعد حذف المصدر، يمكن مراجعة نسخه التعليمية. يبقى المحتوى الذي تغير بشريًا معلقًا لمعالجة منفصلة. يلزم امتلاك صلاحية الاحتفاظ وإدارة محتوى الدورات.</p>
  <button type="button" disabled={busy} onClick={()=>load()}>عرض طلبات حذف المشتقات</button>
  {page&&<><ul>{page.rows.map(row=><li key={row.draft_id}>{row.course_title} · {row.deleted_at?'أزيلت النسخ المحلية':row.provenance_available?'بانتظار المراجعة':'تحتاج إثبات مصدر سابق'} {!row.deleted_at&&<button type="button" disabled={busy} onClick={()=>review(row.draft_id)}>مراجعة النسخ</button>}</li>)}</ul>
   {!page.rows.length&&<p>لا توجد طلبات في هذه الصفحة.</p>}<div className={styles.actions}><button type="button" disabled={busy||page.offset===0} onClick={()=>load(page.offset-50)}>السابق</button><button type="button" disabled={busy||!page.hasMore} onClick={()=>load(page.offset+50)}>التالي</button></div></>}
  {preview&&<form key={preview.previewHash} onSubmit={async event=>{event.preventDefault();const fields=new FormData(event.currentTarget);const result=await action('derivative_delete',{draftId:preview.draftId,previewHash:preview.previewHash,reviewed:fields.get('reviewed')==='on',reason:fields.get('reason')},'أزيلت نسخ المحتوى المحددة محليًا. تظل متابعة النسخ الاحتياطية منفصلة.');if(result)await load(page?.offset||0);}}>
   <h3>النسخ التي يشملها الطلب</h3><ul>{Object.entries(kinds).map(([key,label])=>{const count=preview.changes.filter(x=>x.kind===key).length;return count?<li key={key}>{label}: {count}</li>:null;})}</ul>
   {!!preview.conflicts.length&&<p role="alert">توجد {preview.conflicts.length} حالة تغيّر بشري أو مصدر غير موثق. أُوقف الحذف لحماية المحتوى؛ يلزم فحص المصدر والتعديلات في محرر الدورة.</p>}
   <p>تحل عبارة حذف محل المادة المحددة، وتبقى معرّفات الوحدات وتقدم المتدربين ونتائجهم. هذا الإجراء لا يثبت حذف النسخ الاحتياطية أو النسخ التي نزلها مستخدم.</p>
   <label className={styles.field}>سبب القرار<input name="reason" required minLength={10} maxLength={500}/></label>
   <label><input name="reviewed" type="checkbox" required/> راجعت النسخ وأعتمد حذف محتوى المصدر منها.</label>
   <button disabled={busy||!!preview.conflicts.length}>تأكيد حذف المشتقات المحددة</button>
  </form>}
 </section>;
}
