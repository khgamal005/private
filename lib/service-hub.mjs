export const REQUEST_STATUS={requested:'قيد المراجعة',offered:'عرض بانتظار موافقتك',accepted:'تم اعتماد العرض',declined:'العرض مرفوض',cancelled:'ملغي'};
export function safePortfolioUrl(value){
  if(!value)return '';
  try{const u=new URL(String(value));return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}
}
export function validateExpertApplication(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('راجع بيانات طلب الانضمام.');
  const read=(key,min,max)=>{if(typeof value[key]!=='string')throw Error('راجع البيانات المطلوبة.');const s=value[key].trim();if(s.length<min||s.length>max)throw Error('راجع طول البيانات المدخلة.');return s;};
  const name=read('name',2,150),email=read('email',5,254).toLowerCase(),phone=read('phone',7,40);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^\+?[0-9 ()-]{7,40}$/.test(phone))throw Error('راجع البريد الإلكتروني ورقم الجوال.');
  const title=read('title',2,180),bio=read('bio',30,4000),city=read('city',2,100);
  const expertise=read('expertise',2,1000),languages=read('languages',2,300);
  if(languages.split(/[,،\n]+/).length>20||expertise.split(/[,،\n]+/).length>30)throw Error('أدخل حتى ٢٠ لغة و٣٠ تخصصًا.');
  if(!/^[0-9]{1,2}$/.test(String(value.yearsExperience)))throw Error('أدخل عدد سنوات الخبرة.');
  const years=Number(value.yearsExperience);
  if(!Number.isInteger(years)||years<0||years>80)throw Error('سنوات الخبرة غير صحيحة.');
  if(!['lecturer','trainer','consultant'].includes(value.type)||value.consent!==true)throw Error('حدد تخصصك ووافق على مراجعة بياناتك.');
  const portfolioUrl=safePortfolioUrl(value.portfolioUrl);
  if(value.portfolioUrl&&(!portfolioUrl||portfolioUrl.length>2000))throw Error('أدخل رابط أعمال صالحًا يبدأ بـ https.');
  return {name,email,phone,title,bio,city,expertise,languages,yearsExperience:years,type:value.type,portfolioUrl,consent:true};
}
export function publicationReasons(item,categories,providers){
  const reasons=[];
  if(!item.marketplaceVisible)reasons.push('الظهور في المتجر مغلق');
  if(!['active','beta'].includes(item.status))reasons.push('الخدمة ليست نشطة');
  if(!categories.some(c=>c.id===item.categoryId&&c.status==='active'))reasons.push('القسم غير نشط');
  if(item.providerId&&!providers.some(p=>p.id===item.providerId&&p.status==='active'))reasons.push('مقدم الخدمة غير نشط');
  return reasons;
}
export function canOrderDirectly(item){return item.pricingMode!=='quote'&&(item.pricingMode!=='from'||item.packages?.length>0);}
