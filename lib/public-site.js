import 'server-only';

import {SUPABASE_KEY,SUPABASE_URL} from './config';

const FALLBACK_MENU=[
  {id:'home',label:'الرئيسية',href:'#home',kind:'anchor',sortOrder:10},
  {id:'about',label:'من نحن',href:'#about',kind:'anchor',sortOrder:20},
  {id:'system',label:'منظومتنا',href:'#system',kind:'anchor',sortOrder:30},
  {id:'solutions',label:'الحلول',href:'#solutions',kind:'anchor',sortOrder:40},
  {id:'impact',label:'الأثر',href:'#impact',kind:'anchor',sortOrder:50}
];

const FALLBACK_SECTIONS=[
  {
    id:'home',key:'home',type:'hero',eyebrow:'استشارات تطوير إداري وتشغيلي',
    title:'نبني مؤسسات تصنع أثرًا مستدامًا',
    summary:'نحوّل الاستراتيجية إلى منظومة عمل مترابطة تجمع التسويق والمبيعات والتشغيل والبيانات في مسار واحد قابل للقياس.',
    body:'من التشخيص إلى التنفيذ ثم القياس والتحسين المستمر، تعمل ماركتون كشريك تشغيل ونمو لا كمورد منفصل.',
    primaryCta:{label:'اكتشف منهجنا',href:'#system'},secondaryCta:{label:'تحدث مع خبير',href:'#contact'},
    items:[
      {title:'رؤية واحدة للنمو',description:'تسويق ومبيعات وتشغيل وبيانات في منظومة مترابطة'},
      {title:'قرارات قابلة للقياس',description:'مؤشرات واضحة بدل الإدارة بالانطباع'}
    ],media:{badge:'منظومة مترابطة',caption:'رؤية واحدة للنمو'},variant:'dark',sortOrder:10
  },
  {
    id:'about',key:'about',type:'journey',eyebrow:'رحلتك معنا',title:'أين تبدأ رحلتك معنا؟',
    summary:'نبدأ بالتشخيص قبل الحل، ونحوّل الملاحظات المتفرقة إلى خريطة واضحة تحدد الأولويات والفرص وخطوات التنفيذ.',
    body:'لا نقدم قالبًا جاهزًا؛ نقرأ الواقع التشغيلي والبيانات ورحلة العميل ثم نبني المسار الأنسب للمؤسسة.',
    items:[
      {title:'فهم الوضع الحالي',description:'قراءة دقيقة للمشهد والتحديات'},
      {title:'تحليل البيانات',description:'تحويل الأرقام إلى مؤشرات قابلة للتصرف'},
      {title:'تحديد فرص النمو',description:'ترتيب الأولويات حسب أثرها الحقيقي'},
      {title:'بناء خطة واضحة',description:'مسار تنفيذ بمسؤوليات ومقاييس محددة'}
    ],variant:'light',sortOrder:20
  },
  {
    id:'system',key:'system',type:'system',eyebrow:'منظومة واحدة',title:'إمكاناتك… في كل جزء من منظومتك',
    summary:'نربط المحاور التي تعمل منفصلة ونحوّلها إلى منظومة نمو واحدة تتغذى من البيانات وتتحسن باستمرار.',
    body:'المشكلة غالبًا ليست في غياب الأدوات، بل في عملها دون رابط تشغيلي موحد.',
    primaryCta:{label:'شاهد كيف تتحرك المنظومة',href:'#engine'},
    items:[
      {title:'الاستراتيجية',description:'أهداف واختيارات واضحة'},
      {title:'التسويق',description:'استقطاب يمكن قياسه'},
      {title:'المبيعات',description:'تحويل منضبط للفرص'},
      {title:'خدمة العملاء',description:'متابعة وتجربة مستمرة'},
      {title:'التحول الرقمي',description:'أتمتة وربط للأنظمة'},
      {title:'الجودة والحوكمة',description:'معايير ووضوح للمسؤوليات'}
    ],variant:'dark',sortOrder:30
  },
  {
    id:'engine',key:'engine',type:'process',eyebrow:'محرك النمو',title:'خمسة محاور تعمل معًا لتحريك النمو',
    summary:'منهجية مترابطة تبدأ بفهم السوق وتنتهي بنمو قابل للتوسع، وكل محور يغذي المحور الذي يليه.',
    items:[
      {title:'دراسة السوق',description:'فهم المنافسة والفرص وسلوك العميل'},
      {title:'استقطاب العملاء',description:'قنوات واضحة لجذب الفرص المؤهلة'},
      {title:'المبيعات',description:'رحلة تحويل منضبطة قابلة للقياس'},
      {title:'خدمة العملاء',description:'متابعة وتجربة تعززان الثقة والولاء'},
      {title:'النمو والتوسع',description:'قرارات أسرع ونمو يمكن تكراره'}
    ],variant:'paper',sortOrder:40
  },
  {
    id:'gap',key:'gap',type:'comparison',eyebrow:'التحول',title:'من الفجوة إلى القمة',
    summary:'نحوّل التحديات اليومية إلى نظام تشغيلي متكامل يختصر الوقت، يرفع الكفاءة، ويقود إلى نتائج قابلة للقياس.',
    items:[
      {title:'قبل',description:'عمليات منفصلة، بيانات متأخرة، تسرب في المتابعة، وقرارات بالانطباع.'},
      {title:'بعد',description:'عمليات مترابطة، رؤية لحظية، متابعة مستمرة، وقرارات بالبيانات.'}
    ],variant:'dark',sortOrder:50
  },
  {
    id:'team',key:'team',type:'team',eyebrow:'تمكين الفريق',title:'نُمكّن فريقك لنُمكّن مؤسستك',
    summary:'ننقل المعرفة إلى الداخل، ونبني قدرات الفريق ليقود التشغيل والتحسين بعد انتهاء المشروع.',
    body:'التقنية وحدها لا تكفي؛ لذلك نربط الأدوات بالتدريب وأدلة العمل والمتابعة الإدارية.',
    items:[
      {title:'كفاءة أعلى',description:'تقليل الهدر والعمل المتكرر'},
      {title:'فريق متمكن',description:'أدوار واضحة وأدلة عمل'},
      {title:'قيادة واضحة',description:'لوحات متابعة ومؤشرات'},
      {title:'أثر مستمر',description:'تحسين لا يتوقف بانتهاء المشروع'}
    ],variant:'light',sortOrder:60
  },
  {
    id:'data',key:'data',type:'metrics',eyebrow:'البيانات',title:'كل قرار يبدأ من رقم واضح',
    summary:'نوحّد البيانات من الحملات والمتاجر والمبيعات وخدمة العملاء لنقدم رؤية تشغيلية واحدة.',
    body:'من معرفة مصدر العميل إلى قياس العائد على الإنفاق الإعلاني وأداء الموظف، تظهر الصورة في مكان واحد.',
    items:[
      {title:'رحلة العميل',description:'تتبّع المصدر والتفاعل والتحويل'},
      {title:'أداء الفريق',description:'مبيعات ومهام ومكالمات ومتابعات'},
      {title:'كفاءة الحملات',description:'تكلفة العميل والتحويل وROAS'},
      {title:'جودة التشغيل',description:'اختناقات ومواعيد ومستوى الإنجاز'}
    ],variant:'dark',sortOrder:70
  },
  {
    id:'impact',key:'impact',type:'impact',eyebrow:'الأثر',title:'نقيس ما يتغير، لا ما يتم تنفيذه فقط',
    summary:'كل مبادرة ترتبط بمؤشر قبل وبعد، حتى يعرف صاحب القرار أين تحققت القيمة وما الذي يحتاج إلى تحسين.',
    items:[
      {title:'وضوح أكبر',description:'رؤية موحدة للعمليات والأولويات'},
      {title:'تحويل أعلى',description:'متابعة أفضل للفرص والعملاء'},
      {title:'زمن أقل',description:'أتمتة المهام المتكررة'},
      {title:'نمو قابل للتوسع',description:'نظام يمكن تكراره وتطويره'}
    ],variant:'paper',sortOrder:80
  },
  {
    id:'solutions',key:'solutions',type:'solutions',eyebrow:'حلول متخصصة',title:'حل واحد لا يناسب كل مؤسسة',
    summary:'نختار المزيج الأنسب من الاستشارات والتشغيل والتقنية والتدريب وفق المرحلة والتحدي.',
    body:'يمكن البدء بمحور واحد ثم التوسع تدريجيًا داخل نفس المنظومة.',
    items:[
      {title:'التسويق والنمو',description:'استراتيجية وحملات وصفحات هبوط وقياس'},
      {title:'المبيعات وخدمة العملاء',description:'فرق ومتابعة ومسارات تحويل واتصالات'},
      {title:'منصة التشغيل',description:'CRM وأتمتة وتقارير وربط المتاجر'},
      {title:'الاستشارات والحوكمة',description:'مؤشرات وإجراءات وجودة وتطوير مؤسسي'},
      {title:'التدريب والمحتوى',description:'حقائب وبرامج ومنصات تعلم'},
      {title:'الشراكات الدولية',description:'تعاون أكاديمي وتطوير منتجات'}
    ],variant:'light',sortOrder:90
  },
  {
    id:'partnership',key:'partnership',type:'partnership',eyebrow:'شراكة نمو',title:'نبدأ بخطوة واضحة ونبني عليها',
    summary:'جلسة تشخيص مختصرة تحدد الفجوة والأولوية وأفضل مسار للتنفيذ.',
    primaryCta:{label:'ابدأ جلسة التشخيص',href:'#contact'},secondaryCta:{label:'دخول العملاء',href:'/login'},
    items:[],variant:'dark',sortOrder:100
  },
  {
    id:'contact',key:'contact',type:'contact',eyebrow:'تواصل معنا',title:'دعنا نفهم التحدي أولًا',
    summary:'شاركنا نبذة عن مؤسستك والتحدي الحالي، وسيتواصل فريق ماركتون لترتيب الخطوة المناسبة.',
    body:'لن نرسل عرضًا عامًا قبل فهم الاحتياج.',items:[],variant:'light',sortOrder:110
  }
];

export const FALLBACK_PUBLIC_SITE={
  available:true,
  site:{
    key:'marktone-main',nameAr:'ماركتون',nameEn:'Marktone',
    settings:{
      siteTitle:'ماركتون | منظومات نمو للمؤسسات',
      description:'ماركتون منظومة تشغيل ونمو متخصصة تربط التسويق والمبيعات والتشغيل والبيانات في مسار واحد قابل للقياس.',
      customerLoginLabel:'دخول العملاء',customerLoginUrl:'/login',
      contactCtaLabel:'تواصل معنا',contactCtaUrl:'#contact',
      contactEmail:'hello@marktone.sa',contactPhone:'',country:'المملكة العربية السعودية',
      footerText:'ماركتون — منظومة تشغيل ونمو متخصصة للمؤسسات ومراكز التدريب.'
    },
    theme:{navy:'#06182e',navySoft:'#0b2949',gold:'#e6b34e',paper:'#f7f2e8',white:'#ffffff'}
  },
  menu:FALLBACK_MENU,
  sections:FALLBACK_SECTIONS,
  pages:[],articles:[],page:null,article:null
};

async function rpc(name,body){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${SUPABASE_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store'
  });
  if(!response.ok){
    const detail=await response.text();
    throw new Error(`${name}: ${response.status} ${detail.slice(0,500)}`);
  }
  return response.json();
}

export async function getPublicSiteSnapshot({pageSlug=null,articleSlug=null}={}){
  try{
    const data=await rpc('v2_public_site_snapshot',{
      p_page_slug:pageSlug,
      p_article_slug:articleSlug
    });
    if(!data?.available)return FALLBACK_PUBLIC_SITE;
    return data;
  }catch(error){
    console.error('public_site_snapshot_failed',error);
    return FALLBACK_PUBLIC_SITE;
  }
}
