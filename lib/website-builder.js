export const BUILDER_SCHEMA_VERSION=1;

const BASE_RESPONSIVE={hideDesktop:false,hideTablet:false,hideMobile:false};
const BASE_STYLE={
  variant:'light',align:'right',paddingY:48,maxWidth:'wide',
  background:'',color:'',borderColor:'',borderWidth:0,borderRadius:0,
  shadow:'none',animation:'none',animationDelay:0,cssClass:''
};

const def=(label,icon,category,description,props={},style={})=>({
  label,icon,category,description,
  defaults:{props:{anchor:'',...props},style:{...BASE_STYLE,...style},responsive:{...BASE_RESPONSIVE}}
});

export const ROW_LAYOUTS=Object.freeze({
  '1':{label:'عمود واحد',template:'1fr',columns:1,icon:'▰'},
  '1-1':{label:'عمودان متساويان',template:'1fr 1fr',columns:2,icon:'▰▰'},
  '1-2':{label:'ثلث + ثلثان',template:'1fr 2fr',columns:2,icon:'▰▰'},
  '2-1':{label:'ثلثان + ثلث',template:'2fr 1fr',columns:2,icon:'▰▰'},
  '1-3':{label:'ربع + ثلاثة أرباع',template:'1fr 3fr',columns:2,icon:'▰▰'},
  '3-1':{label:'ثلاثة أرباع + ربع',template:'3fr 1fr',columns:2,icon:'▰▰'},
  '1-1-1':{label:'ثلاثة أعمدة',template:'repeat(3,1fr)',columns:3,icon:'▰▰▰'},
  '1-2-1':{label:'ربع + نصف + ربع',template:'1fr 2fr 1fr',columns:3,icon:'▰▰▰'},
  '1-1-1-1':{label:'أربعة أعمدة',template:'repeat(4,1fr)',columns:4,icon:'▰▰▰▰'},
  '1-1-1-1-1':{label:'خمسة أعمدة',template:'repeat(5,1fr)',columns:5,icon:'▰▰▰▰▰'},
  '1-1-1-1-1-1':{label:'ستة أعمدة',template:'repeat(6,1fr)',columns:6,icon:'▰▰▰▰▰▰'}
});

export const BLOCK_CATALOG=Object.freeze({
  hero:def('واجهة رئيسية','✦','أساسية','عنوان قوي، وصف، أزرار وصورة.',{
    eyebrow:'أودير',title:'عنوان رئيسي يصنع الانطباع الأول',
    body:'اكتب وصفًا واضحًا يشرح القيمة التي تقدمها هذه الصفحة.',
    imageUrl:'',imageAlt:'',primaryLabel:'ابدأ الآن',primaryHref:'#contact',
    secondaryLabel:'اعرف المزيد',secondaryHref:'#details'
  },{variant:'dark',paddingY:88}),
  heading:def('عنوان','H','نصوص','عنوان رئيسي أو فرعي مع وصف.',{
    eyebrow:'عنوان صغير',title:'عنوان القسم',body:'وصف مختصر يهيئ القارئ للمحتوى التالي.',level:'h2'
  }),
  fancyHeading:def('عنوان مميز','✧','نصوص','عنوان زخرفي لإبراز الرسالة.',{
    eyebrow:'تميّز',title:'عنوان مميز وجذاب',body:'وصف اختياري',accent:'كلمة بارزة',level:'h2'
  }),
  text:def('نص','¶','نصوص','فقرات نصية مرنة.',{
    content:'اكتب المحتوى هنا.\n\nيمكنك فصل الفقرات بسطر فارغ.',columns:1
  },{maxWidth:'reading',paddingY:28}),
  box:def('صندوق','□','عام','صندوق محتوى بخلفية وحدود.',{
    title:'عنوان الصندوق',body:'ضع محتوى الصندوق هنا.',icon:'◇'
  },{borderWidth:1,borderRadius:16,paddingY:30}),
  alert:def('تنبيه','⚠','عام','رسالة تنبيه أو نجاح أو معلومة.',{
    title:'تنبيه مهم',body:'اكتب رسالة التنبيه هنا.',tone:'info',icon:'!'
  },{paddingY:24}),
  accordion:def('أكورديون','☷','عام','قائمة قابلة للفتح والإغلاق.',{
    title:'تفاصيل إضافية',items:[
      {title:'العنصر الأول',description:'تفاصيل العنصر الأول.'},
      {title:'العنصر الثاني',description:'تفاصيل العنصر الثاني.'}
    ]
  }),
  code:def('عرض كود','</>','عام','عرض كود برمجي منسق.',{
    title:'مثال برمجي',language:'html',code:'<div>ODEIR Builder</div>'
  },{variant:'dark',paddingY:28}),
  callout:def('ملاحظة بارزة','◉','عام','بلوك بارز لرسالة أو نصيحة.',{
    eyebrow:'معلومة',title:'رسالة تستحق الانتباه',body:'اكتب المعلومة أو التوصية هنا.',icon:'✦'
  },{variant:'paper'}),
  button:def('زر','↗','عام','زر واحد قابل للتخصيص.',{
    label:'اضغط هنا',href:'#',style:'primary',size:'medium',icon:'↗'
  },{paddingY:18}),
  buttons:def('مجموعة أزرار','⇥','أساسية','زر أساسي وآخر ثانوي.',{
    primaryLabel:'تواصل معنا',primaryHref:'#contact',secondaryLabel:'دخول العملاء',secondaryHref:'/login'
  },{paddingY:20}),
  divider:def('فاصل','—','تخطيط','خط فاصل مرن.',{width:100,thickness:1,style:'solid'},{paddingY:12}),
  spacer:def('مسافة','↕','تخطيط','مساحة رأسية لكل جهاز.',{desktop:72,tablet:52,mobile:36},{paddingY:0}),
  copyright:def('حقوق النشر','©','عام','نص حقوق النشر المتجدد.',{
    text:'© {year} جميع الحقوق محفوظة.',company:'أودير'
  },{paddingY:16}),
  icon:def('أيقونة','◇','عام','أيقونة مع عنوان ووصف.',{
    icon:'✦',title:'عنوان الأيقونة',body:'وصف مختصر',size:42
  },{align:'center',paddingY:24}),
  image:def('صورة','▧','وسائط','صورة مع وصف اختياري.',{
    url:'',alt:'',caption:'',ratio:'16 / 9',fit:'cover',linkHref:''
  },{paddingY:24}),
  gallery:def('معرض صور','▦','وسائط','شبكة صور قابلة للتخصيص.',{
    columns:3,ratio:'1 / 1',items:[
      {url:'',alt:'الصورة الأولى'},{url:'',alt:'الصورة الثانية'},{url:'',alt:'الصورة الثالثة'}
    ]
  }),
  mosaic:def('موزاييك','▩','إضافات','معرض صور بتوزيع بصري متنوع.',{
    items:[{url:'',alt:'صورة رئيسية'},{url:'',alt:'صورة'},{url:'',alt:'صورة'}]
  }),
  feature:def('ميزة','◆','عام','ميزة بأيقونة وعنوان ووصف.',{
    icon:'✦',title:'ميزة قوية',body:'اشرح القيمة التي يحصل عليها العميل.',linkLabel:'اعرف المزيد',linkHref:'#'
  },{paddingY:28}),
  linkBlock:def('بلوك رابط','↗','عام','بطاقة كاملة قابلة للنقر.',{
    eyebrow:'رابط',title:'انتقل إلى صفحة مهمة',body:'وصف مختصر للوجهة.',href:'#',icon:'↗'
  },{borderWidth:1,borderRadius:16,paddingY:28}),
  layoutPart:def('جزء محفوظ','▥','عام','إدراج جزء تصميم محفوظ وقابل لإعادة الاستخدام.',{
    title:'جزء تصميم محفوظ',body:'اختر الجزء من مكتبة العناصر المحفوظة.',partKey:''
  }),
  map:def('خريطة','⌖','وسائط','عنوان وموقع ورابط خريطة.',{
    title:'موقعنا',address:'اكتب العنوان هنا',mapUrl:'',height:320
  }),
  lottie:def('Lottie Animation','◌','وسائط','حركة Lottie من رابط JSON.',{
    title:'حركة تفاعلية',url:'',autoplay:true,loop:true
  }),
  login:def('تسجيل الدخول','⌁','نماذج','نموذج دخول للعملاء أو الموظفين.',{
    title:'تسجيل الدخول',body:'أدخل بيانات حسابك للمتابعة.',buttonLabel:'دخول',forgotLabel:'نسيت كلمة المرور؟'
  }),
  overlay:def('محتوى فوق صورة','▣','وسائط','صورة بخلفية ونص فوقها.',{
    imageUrl:'',eyebrow:'اكتشف',title:'عنوان فوق الصورة',body:'وصف مختصر',buttonLabel:'اعرف المزيد',buttonHref:'#'
  },{variant:'dark',paddingY:64}),
  optin:def('نموذج اشتراك','✉','نماذج','جمع البريد والجوال للاشتراك.',{
    eyebrow:'ابقَ على اطلاع',title:'اشترك في التحديثات',body:'أدخل بياناتك ليصلك كل جديد.',buttonLabel:'اشتراك',fields:'name,email,phone'
  }),
  menu:def('قائمة','☰','الموقع','عرض قائمة الموقع الرئيسية.',{
    title:'القائمة',orientation:'horizontal',items:[
      {title:'الرئيسية',href:'/'},{title:'الخدمات',href:'#services'},{title:'تواصل معنا',href:'#contact'}
    ]
  },{paddingY:18}),
  serviceMenu:def('قائمة خدمات','☷','الموقع','قائمة جانبية للخدمات أو الأقسام.',{
    title:'خدماتنا',items:[{title:'الخدمة الأولى',href:'#'},{title:'الخدمة الثانية',href:'#'}]
  }),
  post:def('مقالات','▤','المحتوى','شبكة مقالات أو أخبار.',{
    eyebrow:'المعرفة',title:'أحدث المقالات',columns:3,items:[
      {title:'عنوان المقال الأول',description:'ملخص قصير للمقال.',href:'#'},
      {title:'عنوان المقال الثاني',description:'ملخص قصير للمقال.',href:'#'},
      {title:'عنوان المقال الثالث',description:'ملخص قصير للمقال.',href:'#'}
    ]
  }),
  html:def('HTML / Text / Shortcode','<>','عام','إدراج HTML أو نص مخصص.',{
    content:'<p>ضع المحتوى المخصص هنا</p>'
  },{paddingY:20}),
  socialShare:def('مشاركة اجتماعية','✣','عام','أزرار مشاركة على الشبكات الاجتماعية.',{
    title:'شارك الصفحة',networks:'x,linkedin,facebook,whatsapp'
  },{paddingY:20}),
  slider:def('سلايدر','◫','وسائط','شرائح صور ونصوص.',{
    height:480,autoplay:true,items:[
      {title:'الشريحة الأولى',description:'وصف الشريحة الأولى',imageUrl:'',buttonLabel:'اعرف المزيد',buttonHref:'#'},
      {title:'الشريحة الثانية',description:'وصف الشريحة الثانية',imageUrl:'',buttonLabel:'ابدأ الآن',buttonHref:'#'}
    ]
  },{variant:'dark',paddingY:0}),
  signup:def('نموذج تسجيل','✎','نماذج','نموذج تسجيل مختصر.',{
    title:'سجل بياناتك',body:'أكمل البيانات وسيتواصل معك الفريق.',buttonLabel:'إرسال التسجيل'
  }),
  table:def('جدول','▤','عام','جدول بيانات متجاوب.',{
    title:'جدول البيانات',rows:[['البند','التفاصيل','الحالة'],['البند الأول','تفاصيل','متاح'],['البند الثاني','تفاصيل','قريبًا']]
  }),
  tabs:def('تبويبات','▣','عام','محتوى منظم داخل تبويبات.',{
    items:[{title:'التبويب الأول',description:'محتوى التبويب الأول.'},{title:'التبويب الثاني',description:'محتوى التبويب الثاني.'}]
  }),
  rating:def('تقييم بالنجوم','★★★★★','عام','عرض تقييم ورقم المراجعات.',{
    title:'تقييم العملاء',value:5,outOf:5,count:120
  },{align:'center',paddingY:20}),
  toc:def('جدول المحتويات','≡','المحتوى','روابط داخلية لأقسام الصفحة.',{
    title:'في هذه الصفحة',items:[{title:'القسم الأول',href:'#section-1'},{title:'القسم الثاني',href:'#section-2'}]
  }),
  testimonials:def('آراء العملاء','❞','المحتوى','شبكة شهادات العملاء.',{
    eyebrow:'آراء العملاء',title:'تجارب صنعت فرقًا',columns:3,items:[
      {title:'عميل أول',description:'تجربة ممتازة ونتائج واضحة.',role:'مدير منشأة'},
      {title:'عميل ثان',description:'سهولة في الاستخدام وسرعة في التنفيذ.',role:'مدير تدريب'},
      {title:'عميل ثالث',description:'منظومة متكاملة للفريق.',role:'مدير مبيعات'}
    ]
  }),
  widgetArea:def('منطقة ودجت','▦','الموقع','منطقة لعرض ودجات الموقع.',{
    title:'منطقة الودجات',areaKey:'sidebar'
  }),
  widget:def('ودجت','▧','الموقع','ودجت مخصص من إضافات الموقع.',{
    title:'ودجت مخصص',widgetKey:'',body:'يتم عرض محتوى الودجت هنا.'
  }),
  video:def('فيديو','▶','وسائط','فيديو من YouTube أو Vimeo أو رابط مباشر.',{
    url:'',title:'فيديو تعريفي',poster:'',ratio:'16 / 9',autoplay:false
  }),
  cards:def('بطاقات','▦','المحتوى','شبكة خدمات أو مزايا أو خطوات.',{
    eyebrow:'مزايا',title:'ما الذي نقدمه؟',body:'مجموعة مترابطة من الحلول.',columns:3,
    items:[{title:'الميزة الأولى',description:'وصف مختصر.'},{title:'الميزة الثانية',description:'وصف مختصر.'},{title:'الميزة الثالثة',description:'وصف مختصر.'}]
  },{paddingY:54}),
  stats:def('أرقام وإحصائيات','123','المحتوى','أرقام بارزة تدعم الثقة.',{
    eyebrow:'أثر قابل للقياس',title:'نتائج تظهر في الأرقام',body:'استخدم أرقامًا يمكن إثباتها.',columns:4,
    items:[{value:'+20',title:'عامًا',description:'خبرة'},{value:'360°',title:'رؤية موحدة',description:'للعمليات'},{value:'24/7',title:'متابعة',description:'للمؤشرات'},{value:'1',title:'منظومة',description:'تربط الفرق'}]
  },{variant:'dark',paddingY:48}),
  columns:{
    label:'صف وأعمدة',icon:'▥',category:'تخطيط',description:'صف مرن يحتوي أعمدة وموديولات بالسحب والإفلات.',
    defaults:{
      props:{anchor:'',row:true,layoutKey:'1',gap:18,fullWidth:false,minHeight:0,verticalAlign:'stretch',items:[]},
      style:{...BASE_STYLE,paddingY:18,maxWidth:'wide'},responsive:{...BASE_RESPONSIVE}
    }
  },
  quote:def('اقتباس أو شهادة','❞','المحتوى','شهادة عميل أو اقتباس بارز.',{
    quote:'ضع هنا شهادة حقيقية أو اقتباسًا يختصر قيمة التجربة.',author:'اسم العميل',role:'المسمى أو المنشأة'
  },{variant:'paper',maxWidth:'reading'}),
  faq:def('أسئلة شائعة','?','المحتوى','أسئلة وأجوبة قابلة للفتح.',{
    eyebrow:'الأسئلة الشائعة',title:'إجابات واضحة قبل البدء',body:'',
    items:[{title:'كيف نبدأ؟',description:'نبدأ بجلسة تشخيص وفهم الاحتياج.'},{title:'هل الحل قابل للتخصيص؟',description:'نعم، وفق واقع المؤسسة.'}]
  },{maxWidth:'reading'}),
  cta:def('دعوة لاتخاذ إجراء','◎','أساسية','شريط قوي لتحويل الزائر.',{
    eyebrow:'الخطوة التالية',title:'ابدأ بخطوة واضحة',body:'شاركنا التحدي وسنحدد المسار الأنسب.',buttonLabel:'تواصل معنا',buttonHref:'#contact'
  },{variant:'brand'}),
  contact:def('نموذج تواصل','✉','نماذج','نموذج مرتبط بقاعدة البيانات.',{
    eyebrow:'تواصل معنا',title:'دعنا نفهم احتياجك',body:'اكتب نبذة قصيرة وسيتواصل معك الفريق.',buttonLabel:'إرسال الطلب'
  },{paddingY:54}),
  productCategories:def('تصنيفات المنتجات','🛒','إضافات','عرض تصنيفات الدورات أو المنتجات.',{
    eyebrow:'التصنيفات',title:'استكشف البرامج',columns:4,items:[{title:'الإدارة',description:'برامج الإدارة'},{title:'التقنية',description:'برامج التقنية'},{title:'الموارد البشرية',description:'برامج الموارد البشرية'},{title:'الضيافة',description:'برامج الضيافة'}]
  }),
  timeline:def('خط زمني','◷','إضافات','عرض مراحل أو أحداث زمنية.',{
    eyebrow:'الرحلة',title:'خطوات التنفيذ',items:[{value:'01',title:'الاكتشاف',description:'فهم الاحتياج.'},{value:'02',title:'التصميم',description:'بناء الحل.'},{value:'03',title:'الإطلاق',description:'التشغيل والقياس.'}]
  }),
  products:def('منتجات WooCommerce','🛍','إضافات','عرض منتجات أو دورات المتجر.',{
    eyebrow:'الدورات',title:'البرامج الأكثر طلبًا',columns:3,source:'latest',items:[{title:'دورة احترافية',description:'وصف الدورة',value:'699 ر.س'},{title:'برنامج تدريبي',description:'وصف البرنامج',value:'899 ر.س'},{title:'دبلوم مهني',description:'وصف الدبلوم',value:'2,499 ر.س'}]
  })
});

export const MODULE_TYPES=Object.freeze(Object.keys(BLOCK_CATALOG).filter(type=>type!=='columns'));

export const SECTION_PRESETS=Object.freeze({
  trainingHero:{label:'واجهة مركز تدريب',icon:'✦',description:'عنوان وصورة واعتمادات وأزرار.'},
  featureGrid:{label:'مزايا بثلاثة أعمدة',icon:'▦',description:'عنوان وثلاث مزايا واضحة.'},
  statistics:{label:'شريط إحصائيات',icon:'123',description:'أربعة أرقام رئيسية.'},
  courses:{label:'متجر دورات',icon:'🛍',description:'عنوان وشبكة دورات قابلة للربط.'},
  testimonials:{label:'آراء العملاء',icon:'❞',description:'ثلاث شهادات احترافية.'},
  faq:{label:'الأسئلة الشائعة',icon:'?',description:'عنوان وقائمة أسئلة.'},
  contact:{label:'دعوة ونموذج تواصل',icon:'✉',description:'رسالة تحويل ونموذج.'}
});

export const BUILDER_TEMPLATES=Object.freeze({
  blank:{label:'صفحة فارغة',description:'صف واحد فارغ للبدء.',presets:[]},
  landing:{label:'صفحة هبوط احترافية',description:'واجهة، مزايا، أرقام، شهادات وتواصل.',presets:['trainingHero','statistics','featureGrid','testimonials','faq','contact']},
  training:{label:'موقع مركز تدريب',description:'واجهة ومتجر دورات واعتمادات وتواصل.',presets:['trainingHero','statistics','courses','featureGrid','faq','contact']},
  service:{label:'صفحة خدمة',description:'واجهة، شرح، مزايا، أسئلة وتواصل.',presets:['trainingHero','featureGrid','statistics','faq','contact']}
});

export function createBuilderId(prefix='block'){
  const random=globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${String(random).replaceAll('-','').slice(0,16)}`;
}

export function createBuilderBlock(type,overrides={}){
  const definition=BLOCK_CATALOG[type]||BLOCK_CATALOG.text;
  const defaults=clone(definition.defaults);
  if(type==='columns'&&overrides?.props&&!Object.prototype.hasOwnProperty.call(overrides.props,'row')){
    const legacy=Array.isArray(overrides.props.items)&&!overrides.props.items.some(item=>Array.isArray(item?.modules));
    if(legacy)defaults.props.row=false;
  }
  const block={
    id:overrides.id||createBuilderId(type),type:BLOCK_CATALOG[type]?type:'text',
    props:{...defaults.props,...clone(overrides.props||{})},
    style:{...defaults.style,...clone(overrides.style||{})},
    responsive:{...defaults.responsive,...clone(overrides.responsive||{})}
  };
  if(block.type==='columns'&&block.props.row!==false)return normalizeLayoutRow(block);
  return block;
}

export function createLayoutColumn(width='1fr',overrides={}){
  return {
    id:overrides.id||createBuilderId('column'),width:overrides.width||width,
    modules:(Array.isArray(overrides.modules)?overrides.modules:[]).map(normalizeNestedModule),
    style:{background:'',color:'',padding:18,gap:14,borderColor:'',borderWidth:0,borderRadius:0,shadow:'none',verticalAlign:'stretch',...clone(overrides.style||{})},
    responsive:{...BASE_RESPONSIVE,...clone(overrides.responsive||{})}
  };
}

export function createLayoutRow(layoutKey='1',overrides={}){
  const layout=ROW_LAYOUTS[layoutKey]||ROW_LAYOUTS['1'];
  const items=splitTemplate(layout.template).map(width=>createLayoutColumn(width));
  return createBuilderBlock('columns',{
    ...overrides,
    props:{row:true,layoutKey,gap:18,fullWidth:false,minHeight:0,verticalAlign:'stretch',items,...clone(overrides.props||{})}
  });
}

export function changeLayoutRow(row,layoutKey){
  const layout=ROW_LAYOUTS[layoutKey]||ROW_LAYOUTS['1'];
  const widths=splitTemplate(layout.template);
  const current=Array.isArray(row?.props?.items)?row.props.items:[];
  const next=widths.map((width,index)=>createLayoutColumn(width,current[index]||{}));
  if(current.length>next.length){
    const overflow=current.slice(next.length).flatMap(column=>Array.isArray(column.modules)?column.modules:[]);
    next[next.length-1].modules.push(...overflow.map(normalizeNestedModule));
  }
  return createBuilderBlock('columns',{
    ...row,
    props:{...row.props,row:true,layoutKey,items:next}
  });
}

export function createSectionPreset(key){
  if(key==='trainingHero'){
    const row=createLayoutRow('1-1',{props:{gap:34,minHeight:560},style:{variant:'dark',paddingY:54,maxWidth:'full'}});
    row.props.items[0].modules=[
      createBuilderBlock('fancyHeading',{props:{eyebrow:'مركز تدريب معتمد',title:'بوابتك نحو مهارات تصنع مستقبلك',body:'برامج تدريبية عملية، مدربون خبراء وتجربة تسجيل سهلة.',accent:'مهارات'}}),
      createBuilderBlock('buttons',{props:{primaryLabel:'سجل الآن',primaryHref:'#contact',secondaryLabel:'استكشف الدورات',secondaryHref:'#courses'}}),
      createBuilderBlock('rating',{props:{title:'تقييم المتدربين',value:5,outOf:5,count:420}})
    ];
    row.props.items[1].modules=[createBuilderBlock('image',{props:{url:'',alt:'صورة الواجهة الرئيسية',caption:'أضف صورة المتحدث أو المتدرب من مكتبة الوسائط',ratio:'4 / 3'}})];
    return [row];
  }
  if(key==='featureGrid'){
    const head=createLayoutRow('1');head.props.items[0].modules=[createBuilderBlock('heading',{props:{eyebrow:'لماذا نحن؟',title:'تجربة تدريبية متكاملة',body:'كل ما يحتاجه المتدرب من التسجيل حتى الشهادة.'},style:{align:'center'}})];
    const row=createLayoutRow('1-1-1');
    row.props.items.forEach((column,index)=>{column.modules=[createBuilderBlock('feature',{props:{icon:['✦','◎','↗'][index],title:['اعتماد موثوق','تطبيق عملي','دعم مستمر'][index],body:['برامج وفق معايير واضحة.','تمارين ومشروعات حقيقية.','متابعة قبل وأثناء وبعد التدريب.'][index]}})];});
    return [head,row];
  }
  if(key==='statistics'){
    const row=createLayoutRow('1');row.style.variant='dark';row.props.items[0].modules=[createBuilderBlock('stats')];return [row];
  }
  if(key==='courses'){
    const row=createLayoutRow('1');row.props.anchor='courses';row.props.items[0].modules=[createBuilderBlock('products')];return [row];
  }
  if(key==='testimonials'){
    const row=createLayoutRow('1');row.props.items[0].modules=[createBuilderBlock('testimonials')];return [row];
  }
  if(key==='faq'){
    const row=createLayoutRow('1');row.props.items[0].modules=[createBuilderBlock('faq')];return [row];
  }
  if(key==='contact'){
    const row=createLayoutRow('1-1',{props:{gap:28}});
    row.props.items[0].modules=[createBuilderBlock('cta')];
    row.props.items[1].modules=[createBuilderBlock('contact')];
    return [row];
  }
  return [createLayoutRow('1')];
}

export function createBuilderDocument(templateKey='blank'){
  const template=BUILDER_TEMPLATES[templateKey]||BUILDER_TEMPLATES.blank;
  const blocks=template.presets.flatMap(createSectionPreset);
  if(!blocks.length){
    const row=createLayoutRow('1');
    row.props.items[0].modules=[createBuilderBlock('heading'),createBuilderBlock('text')];
    blocks.push(row);
  }
  return {schemaVersion:BUILDER_SCHEMA_VERSION,settings:{contentWidth:'wide',background:'#ffffff',customCss:''},blocks};
}

export function normalizeBuilderDocument(input){
  const source=input&&typeof input==='object'?input:{};
  const blocks=Array.isArray(source.blocks)?source.blocks:[];
  return {
    schemaVersion:BUILDER_SCHEMA_VERSION,
    settings:{
      contentWidth:['wide','full','reading'].includes(source.settings?.contentWidth)?source.settings.contentWidth:'wide',
      background:safeColor(source.settings?.background,'#ffffff'),
      customCss:String(source.settings?.customCss||'').slice(0,30000)
    },
    blocks:blocks.filter(block=>block&&typeof block==='object'&&BLOCK_CATALOG[block.type]).slice(0,80).map(block=>createBuilderBlock(block.type,block))
  };
}

export function isBuilderDocument(value){
  return Boolean(value&&typeof value==='object'&&Number(value.schemaVersion)===BUILDER_SCHEMA_VERSION&&Array.isArray(value.blocks));
}

export function blockCatalogGroups(){
  const result=new Map();
  for(const [type,definition] of Object.entries(BLOCK_CATALOG)){
    if(type==='columns')continue;
    const items=result.get(definition.category)||[];
    items.push({type,...definition});
    result.set(definition.category,items);
  }
  return [...result.entries()].map(([category,items])=>({category,items}));
}

function normalizeLayoutRow(block){
  const props=block.props||{};
  const layoutKey=ROW_LAYOUTS[props.layoutKey]?props.layoutKey:inferLayoutKey(props.items);
  const layout=ROW_LAYOUTS[layoutKey]||ROW_LAYOUTS['1'];
  const widths=splitTemplate(layout.template);
  const source=Array.isArray(props.items)?props.items:[];
  const items=widths.map((width,index)=>createLayoutColumn(width,source[index]||{}));
  if(source.length>items.length){
    const overflow=source.slice(items.length).flatMap(column=>Array.isArray(column?.modules)?column.modules:[]);
    items[items.length-1].modules.push(...overflow.map(normalizeNestedModule));
  }
  return {...block,props:{...props,row:true,layoutKey,gap:clamp(props.gap,0,64,18),minHeight:clamp(props.minHeight,0,1200,0),items}};
}

function normalizeNestedModule(module){
  if(!module||typeof module!=='object'||!BLOCK_CATALOG[module.type]||module.type==='columns')return createBuilderBlock('text');
  return createBuilderBlock(module.type,module);
}

function inferLayoutKey(items){
  const count=Math.max(1,Math.min(6,Array.isArray(items)?items.length:1));
  return ({1:'1',2:'1-1',3:'1-1-1',4:'1-1-1-1',5:'1-1-1-1-1',6:'1-1-1-1-1-1'})[count]||'1';
}

function splitTemplate(template){
  if(template.startsWith('repeat(')){
    const count=Number(template.match(/repeat\((\d+)/)?.[1])||1;
    return Array.from({length:count},()=> '1fr');
  }
  return template.split(/\s+/).filter(Boolean);
}

function safeColor(value,fallback){const result=String(value||'').trim();return /^#[0-9a-f]{3,8}$/i.test(result)?result:fallback;}
function clamp(value,min,max,fallback){const number=Number(value);return Number.isFinite(number)?Math.min(Math.max(number,min),max):fallback;}
function clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value));}
