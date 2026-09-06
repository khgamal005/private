import LegalPageShell from '../../components/public/legal-page-shell';
import {SUPABASE_URL} from '../../lib/config';
import {loadDeletionStatus} from '../../lib/social-connect-v2.mjs';

export const dynamic='force-dynamic';

export const metadata={
  title:'حذف البيانات | ODEIR',
  description:'طريقة فصل الربط وطلب حذف البيانات المرتبطة بخدمة أودير.'
};

const sections=[
  {
    title:'1. حذف تلقائي بعد طلب مزود المنصة',
    paragraphs:[
      'عند طلب حذف البيانات عبر Meta، يتحقق أودير من الطلب ويزيل بيانات التعريف والتفويض الخاصة بالربط. يصدر رمز تأكيد يمكنك استخدام رابطه للتحقق من حالة التنفيذ. إزالة التطبيق وإلغاء التفويض يوقفان الاتصال، لكنهما لا يصدران رمز طلب حذف.'
    ]
  },
  {
    title:'2. فصل الربط من أودير',
    items:[
      'سجّل الدخول إلى أودير وافتح «إضافاتي» ثم «ربط حساب الإعلانات».',
      'اختر «فصل الربط». يتطلب الإجراء صلاحية إدارة الربط داخل المنشأة.',
      'بعد التأكيد يُحذف رمز الوصول المشفر وتتوقف أي مزامنة جديدة، مع بقاء سجل تدقيق غير سري لإثبات الإجراء.'
    ]
  },
  {
    title:'3. طلب مباشر عبر البريد',
    paragraphs:[
      'إذا تعذر دخولك إلى الحساب، أرسل الطلب من بريدك المسجل إلى admin@marktone.sa، واكتب اسم المنشأة والبريد المستخدم في أودير ورمز التأكيد إن وجد. قد نطلب تحققًا إضافيًا لحماية بياناتك من طلبات الانتحال.'
    ]
  },
  {
    title:'4. ما الذي يُحذف ومدة التنفيذ',
    paragraphs:[
      'نزيل رموز التفويض والمعرّفات الشخصية الخاصة بالربط فور التحقق من الطلب، ونحذف أو نجعل بيانات الربط التابعة له مجهولة خلال مدة لا تتجاوز 30 يومًا، إلا إذا وجب الاحتفاظ بحد أدنى محدد بموجب نظام أو نزاع قائم. لا يؤدي الطلب إلى حذف بيانات مستقلة تملكها المنشأة خارج نطاق الربط إلا إذا طلب صاحب الصلاحية ذلك صراحة.'
    ]
  },
  {
    title:'5. متابعة رمز التأكيد',
    paragraphs:[
      'إذا وصلت إلى هذه الصفحة ومع الرابط رمز تأكيد، تظهر نتيجة التحقق أعلى الصفحة. احتفظ بالرابط للمتابعة. عند التواصل مع الدعم أرسل رمز التأكيد فقط، ولا ترسل كلمات مرور أو مفاتيح سرية.'
    ]
  }
];

export default async function DataDeletionPage({searchParams}){
  const params=await searchParams;
  const candidate=typeof params?.code==='string'?params.code:'';
  const confirmationCode=/^[a-f0-9]{48}$/.test(candidate)?candidate:'';
  const result=candidate
    ?await loadDeletionStatus({code:candidate,supabaseUrl:SUPABASE_URL})
    :null;
  const messages={
    completed:{label:'اكتمل حذف بيانات الربط',description:'تحققنا من الطلب: أزيلت بيانات التعريف والتفويض الخاصة بهذا الربط. احتفظ برمز التأكيد للمتابعة.'},
    no_data:{label:'اكتملت مراجعة الطلب',description:'تحققنا من الطلب ولم نجد بيانات ربط متبقية مرتبطة به.'},
    failed:{label:'طلب الحذف يحتاج متابعة',description:'الطلب موجود، لكن لم يكتمل تنفيذه. تواصل مع الدعم مستخدمًا رمز التأكيد.'},
    not_found:{label:'لم نعثر على طلب بهذا الرمز',description:'تحقق من رابط التأكيد الذي حصلت عليه. وجود رمز في الرابط وحده لا يؤكد استلام الطلب.'},
    invalid_code:{label:'رابط التأكيد غير صالح',description:'افتح رابط التأكيد الكامل الذي حصلت عليه، أو تواصل مع الدعم.'},
    unavailable:{label:'تعذر التحقق من حالة الطلب الآن',description:'أعد فتح الصفحة لاحقًا. لا نستطيع تأكيد الاستلام أو التنفيذ حتى يعود التحقق متاحًا.'}
  };
  const notice=result?{...messages[result.status],value:confirmationCode||'—'}:null;
  return <LegalPageShell
    eyebrow="التحكم في بياناتك"
    title="حذف بيانات الربط"
    intro="يمكنك إيقاف التفويض وحذف بيانات الربط بأمان من أودير أو من إعدادات مزود المنصة، مع رمز تأكيد للمتابعة."
    notice={notice}
    sections={sections}
    english={{
      title:'User Data Deletion Instructions',
      paragraphs:[
        'Disconnect the account from your ODEIR add-ons page to remove its stored access credential. To request deletion of identifying connection data, use the data-deletion option provided by Meta. A verified deletion request issues a confirmation code; this page checks its actual status.',
        'If you cannot sign in, email admin@marktone.sa from your registered address with the tenant name and confirmation code. We may request identity verification before processing a manual request.',
        'Identifying connection data is deleted or anonymized within 30 days unless limited retention is legally required. Never send us an App Secret, password or access token.'
      ]
    }}
  />;
}
