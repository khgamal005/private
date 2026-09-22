export function pagePublication(site,page){
 const published=page?.status==='published';
 const visible=published&&site?.status==='published'&&['public','unlisted'].includes(page?.visibility);
 if(!published)return {visible:false,label:'مسودة — غير منشورة'};
 if(site?.status!=='published')return {visible:false,label:'الصفحة منشورة — الموقع غير منشور'};
 if(!visible)return {visible:false,label:'منشورة — الوصول مقيد'};
 return {visible:true,label:page?.builder?.hasUnpublishedChanges?'متاحة — توجد تعديلات غير منشورة':'متاحة للزوار'};
}
export function sitePublication(site,home){
 if(site?.status==='maintenance')return {live:false,label:'الموقع في وضع الصيانة',detail:'الصفحات محجوبة حتى إعادة نشر الموقع.'};
 if(site?.status!=='published')return {live:false,label:'الموقع غير منشور',detail:'نشر الصفحة لا يفتح الموقع تلقائيًا. انشر الموقع بعد تجهيز الصفحة الرئيسية.'};
 if(!home||!pagePublication(site,home).visible)return {live:false,label:'الموقع منشور — الرئيسية غير متاحة',detail:'انشر الصفحة الرئيسية واجعل الوصول إليها عامًا أو عبر الرابط.'};
 return {live:true,label:'الموقع متاح للزوار',detail:'تظهر النسخ المنشورة فقط. تعديلات المسودة تنتظر النشر.'};
}
