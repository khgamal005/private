'use client';
import styles from './payment-method-picker.module.css';
const FIELDS=[['firstName','الاسم الأول','given-name'],['lastName','اسم العائلة','family-name'],
 ['phone','رقم الجوال','tel'],['email','البريد الإلكتروني','email'],['city','المدينة','address-level2'],['address','عنوان الفوترة','address-line1']];
export default function TamaraContactFields({value,onChange}){
 return <fieldset className={styles.contact}><legend>بيانات صاحب عملية الدفع</legend><p>تُرسل إلى تمارا لإتمام الطلب. لا تُدخل بيانات البطاقة هنا.</p>
  <div>{FIELDS.map(([key,label,complete])=><label key={key}><span>{label}</span><input value={value[key]||''}
   onChange={event=>onChange({...value,[key]:event.target.value})} required autoComplete={complete}
   type={key==='email'?'email':key==='phone'?'tel':'text'} dir={['phone','email'].includes(key)?'ltr':undefined}
   maxLength={key==='address'?200:100} pattern={key==='phone'?'\\+9665[0-9]{8}':undefined}
   placeholder={key==='phone'?'+9665XXXXXXXX':undefined}/></label>)}</div>
 </fieldset>;
}
