const homeUrl='/odeir-preview';

export const odeirPreviewSnapshot={
  available:true,
  site:{
    key:'odeir-design-preview',
    nameAr:'أودير',
    nameEn:'ODEIR',
    theme:{
      navy:'#06182e',
      navySoft:'#0b2949',
      gold:'#f0c534',
      teal:'#08b8b1',
      cyan:'#13c7d1',
      paper:'#f7f2e8',
      white:'#ffffff'
    },
    settings:{
      brandKey:'odeir',
      homeUrl,
      siteTitle:'أودير | منصة تشغيل وإدارة المنشآت',
      description:'منصة واحدة لإدارة العملاء والمبيعات والمهام والتسجيل والدورات والفوترة والتقارير.',
      footerText:'أودير — تشغيل أوضح وإدارة مترابطة للمنشآت.',
      customerLoginLabel:'تسجيل دخول المنشآت',
      customerLoginUrl:'/login',
      contactCtaLabel:'سجّل منشأتك مجانًا',
      contactCtaUrl:'/free-trial/apply',
      country:'المملكة العربية السعودية'
    }
  },
  menu:[
    {id:'preview-platform',label:'المنصة',href:'#capabilities',sortOrder:10},
    {id:'preview-how',label:'كيف تبدأ',href:'#how',sortOrder:20},
    {id:'preview-security',label:'الحماية',href:'#security',sortOrder:30},
    {id:'preview-faq',label:'الأسئلة الشائعة',href:'#faq',sortOrder:40}
  ],
  footerMenu:[
    {id:'preview-home',label:'الرئيسية',href:homeUrl,sortOrder:10},
    {id:'preview-free',label:'التسجيل المجاني',href:'/free-trial/apply',sortOrder:15},
    {id:'preview-privacy',label:'سياسة الخصوصية',href:`${homeUrl}/privacy-policy`,sortOrder:20},
    {id:'preview-security-policy',label:'أمن المعلومات',href:`${homeUrl}/information-security`,sortOrder:30},
    {id:'preview-terms',label:'شروط الاستخدام',href:`${homeUrl}/terms-of-use`,sortOrder:40},
    {id:'preview-cookies',label:'ملفات الارتباط',href:`${homeUrl}/cookie-policy`,sortOrder:50},
    {id:'preview-rights',label:'حقوق البيانات',href:`${homeUrl}/data-rights`,sortOrder:60}
  ]
};

export const odeirHomeContent={
  title:'أودير',
  content:{
    schemaVersion:1,
    settings:{
      contentWidth:'wide',
      background:'#ffffff',
      customCss:odeirIdentityCss()
    },
    blocks:[
      {
        id:'odeir-home-hero',
        type:'hero',
        props:{
          anchor:'home',
          eyebrow:'منصة واحدة لإدارة منشأتك',
          title:'شغّل منشأتك على بيّنة.',
          body:'أودير يربط العملاء والمبيعات، التسجيل والدورات، المهام، الفوترة والفريق في مسار واحد واضح. ابدأ مجانًا دون بطاقة بنكية.',
          imageUrl:'',
          imageAlt:'معاينة لوحة تشغيل أودير',
          primaryLabel:'سجّل منشأتك مجانًا',
          primaryHref:'/free-trial/apply',
          secondaryLabel:'تسجيل دخول المنشآت',
          secondaryHref:'/login'
        },
        style:{variant:'dark',align:'right',paddingY:104,maxWidth:'wide',cssClass:'odeir-product-hero'},
        responsive:{}
      },
      {
        id:'odeir-capabilities',
        type:'cards',
        props:{
          anchor:'capabilities',
          eyebrow:'منصة واحدة',
          title:'كل ما يحتاجه فريقك. بلا تشتيت.',
          body:'وحدات مترابطة تعطي كل دور شاشته، وتمنح الإدارة صورة واحدة للعمل.',
          columns:3,
          items:[
            {title:'العملاء والمبيعات',description:'من مصدر العميل والتوزيع إلى المتابعة والتحويل والتسجيل.'},
            {title:'المهام والتقويم',description:'أولويات ومواعيد وتنبيهات وتسليم موثق بين أعضاء الفريق.'},
            {title:'التسجيل والقبول',description:'ملف منظم للمتدرب وربط مباشر بالبرنامج والدفعة.'},
            {title:'البرامج والدورات',description:'إدارة البرامج والأسعار والجداول من مصدر واحد.'},
            {title:'الحسابات والفوترة',description:'فواتير وتحصيل مرتبطان برحلة العميل والتسجيل.'},
            {title:'التقارير والقرار',description:'مؤشرات واضحة حسب المنشأة والفرع والدور والفترة.'}
          ]
        },
        style:{variant:'light',align:'center',paddingY:90,maxWidth:'wide',cssClass:'odeir-capabilities'},
        responsive:{}
      },
      {
        id:'odeir-start-steps',
        type:'timeline',
        props:{
          anchor:'how',
          eyebrow:'بداية بسيطة',
          title:'ثلاث خطوات وتبدأ',
          body:'تسجيل واضح، تهيئة للأدوار، ثم تشغيل يومي قابل للقياس.',
          items:[
            {value:'01',title:'سجّل منشأتك',description:'ابحث عنها في السجل أو أضفها للمراجعة، ثم أدخل بيانات المسؤول.'},
            {value:'02',title:'جهّز فريقك',description:'حدّد الأدوار والصلاحيات والمسار الذي تريد البدء به.'},
            {value:'03',title:'ابدأ التشغيل',description:'تابع العملاء والمهام والتسجيل والأرقام من لوحة واحدة.'}
          ]
        },
        style:{variant:'paper',align:'center',paddingY:88,maxWidth:'reading',cssClass:'odeir-start'},
        responsive:{}
      },
      {
        id:'odeir-trust',
        type:'cards',
        props:{
          anchor:'security',
          eyebrow:'سرية المعلومات مسؤولية',
          title:'بيانات منشأتك… أمانة تُدار بمسؤولية.',
          body:'نتعامل مع بيانات منشأتك ومعلوماتها التشغيلية بسرية، ونقصر الوصول إليها واستخدامها على ما يلزم لتقديم الخدمة وتشغيلها. وتُعالج البيانات الشخصية وفق سياسة الخصوصية، وبما يراعي أحكام نظام حماية البيانات الشخصية ولائحته التنفيذية والأنظمة ذات الصلة في المملكة العربية السعودية.',
          columns:4,
          items:[
            {title:'عزل بيانات كل منشأة',description:'تُدار بيانات كل منشأة داخل سياق مستقل للحد من اختلاطها ببيانات منشأة أخرى.'},
            {title:'وصول بحسب الصلاحية والحاجة',description:'يُقصر الوصول على المستخدمين المخولين وبالقدر اللازم لأداء مسؤولياتهم.'},
            {title:'استخدام ومشاركة محددان',description:'تُستخدم البيانات للأغراض اللازمة لتقديم الخدمة، وتُشارك بالقدر اللازم أو وفق ما يجيزه أو يوجبه النظام.'},
            {title:'تدابير حماية مناسبة',description:'تدابير تنظيمية وإدارية وتقنية مناسبة للحد من مخاطر الوصول أو الاستخدام أو الإفصاح غير المصرح به.'}
          ]
        },
        style:{variant:'dark',align:'center',paddingY:90,maxWidth:'wide',cssClass:'odeir-trust'},
        responsive:{}
      },
      {
        id:'odeir-faq',
        type:'faq',
        props:{
          anchor:'faq',
          eyebrow:'أسئلة سريعة',
          title:'قبل أن تبدأ',
          body:'إجابات مباشرة على أكثر الأسئلة شيوعًا.',
          items:[
            {title:'هل التسجيل المجاني يحتاج بطاقة بنكية؟',description:'لا. لا نطلب بطاقة بنكية لبدء التسجيل المجاني.'},
            {title:'هل يجب نقل بياناتنا الحالية فورًا؟',description:'لا. ابدأ بالتهيئة الأساسية، ثم انقل أو اربط ما تحتاجه وفق جاهزية منشأتك.'},
            {title:'هل بيانات المنشآت منفصلة؟',description:'نعم. الوصول مبني حول سياق المنشأة وصلاحيات الدور لمنع اختلاط البيانات.'},
            {title:'هل يمكن تعديل الموقع والسياسات من أودير؟',description:'نعم. الصفحات والقوائم والسياسات قابلة للتعديل والنشر من لوحة الموقع والبيلدر المرئي.'}
          ]
        },
        style:{variant:'light',align:'right',paddingY:84,maxWidth:'reading',cssClass:'odeir-faq'},
        responsive:{}
      },
      {
        id:'odeir-final-cta',
        type:'cta',
        props:{
          anchor:'start',
          eyebrow:'جاهز للبدء؟',
          title:'سجّل منشأتك، وابدأ بمسار أوضح.',
          body:'الحساب الأساسي يبدأ دون بطاقة بنكية، ويمكنك التوسع عندما تحتاج.',
          buttonLabel:'سجّل منشأتك مجانًا',
          buttonHref:'/free-trial/apply'
        },
        style:{variant:'brand',align:'right',paddingY:76,maxWidth:'wide',cssClass:'odeir-final-cta'},
        responsive:{}
      }
    ]
  }
};

const legalDefinitions={
  'privacy-policy':{
    menuLabel:'سياسة الخصوصية',title:'سياسة الخصوصية',eyebrow:'خصوصيتك أولًا',
    description:'كيف تجمع أودير البيانات الشخصية وتستخدمها وتحميها.',
    body:'توضح هذه السياسة كيف تعالج أودير البيانات عند استخدام الموقع والمنصة، وما الخيارات والحقوق المتاحة لأصحاب البيانات.',
    items:[
      {title:'البيانات التي نجمعها',description:'بيانات الحساب والمنشأة والتواصل، والبيانات التشغيلية التي تدخلها المنشأة، وسجلات الاستخدام والأمان.'},
      {title:'أغراض الاستخدام',description:'إنشاء الحساب وتقديم الخدمة ودعمها وحمايتها وتحسينها والوفاء بالالتزامات التعاقدية والنظامية.'},
      {title:'المشاركة والاحتفاظ',description:'نشارك الحد الأدنى اللازم مع مزودي الخدمة المعتمدين ونحتفظ بالبيانات وفق الحاجة والالتزامات المطبقة.'},
      {title:'حقوقك والتواصل',description:'يمكنك طلب العلم أو الوصول أو النسخة أو التصحيح أو الإتلاف بحسب النظام والدور الذي تؤديه أودير في المعالجة.'}
    ]
  },
  'information-security':{
    menuLabel:'أمن المعلومات',title:'أمن المعلومات وحماية البيانات',eyebrow:'حماية عملية',
    description:'نظرة واضحة على الضوابط التي تدعم حماية بيانات المنشآت.',
    body:'نبني الحماية على طبقات مترابطة تشمل الهوية والصلاحيات والعزل والمراقبة والاستجابة.',
    items:[
      {title:'عزل سياق المنشأة',description:'ترتبط البيانات بسياق المنشأة، وتُطبق حدود وصول تقلل خطر ظهورها في مساحة أخرى.'},
      {title:'أقل صلاحية لازمة',description:'تُمنح الصلاحيات بحسب الدور والمسؤولية، مع فصل الوظائف الإدارية عن التشغيلية.'},
      {title:'حماية الاتصال والجلسات',description:'تستخدم المنصة ضوابط للمصادقة والجلسات وقنوات اتصال مشفرة وفق إعدادات مزودي الخدمة.'},
      {title:'المراقبة والاستجابة',description:'تدعم السجلات التشغيلية والأمنية التشخيص والمراجعة ومسار تقييم الحوادث ومعالجتها.'}
    ]
  },
  'terms-of-use':{
    menuLabel:'شروط الاستخدام',title:'شروط الاستخدام',eyebrow:'استخدام واضح ومسؤول',
    description:'الشروط المنظمة لاستخدام موقع ومنصة أودير.',
    body:'باستخدام الموقع أو المنصة فإنك توافق على هذه الشروط والسياسات المرتبطة بها، مع مراعاة أي اتفاقية طلب منفصلة.',
    items:[
      {title:'الأهلية والحساب',description:'يجب أن تكون مخولًا بالتصرف عن المنشأة، وتقدم معلومات صحيحة وتحافظ على سرية بيانات الدخول.'},
      {title:'الاستخدام المقبول',description:'يُمنع تجاوز الصلاحيات أو تعطيل الخدمة أو إدخال محتوى غير مشروع أو ينتهك حقوق الآخرين.'},
      {title:'مسؤولية بيانات المنشأة',description:'المنشأة مسؤولة عن مشروعية بياناتها وتحديد مستخدميها وصلاحياتهم والحصول على الموافقات المطلوبة.'},
      {title:'الخدمة والخطة المجانية',description:'تخضع حدود الحساب الأساسي والإضافات والتكاملات للسياسات والأسعار المعلنة وقت الطلب.'}
    ]
  },
  'cookie-policy':{
    menuLabel:'ملفات الارتباط',title:'سياسة ملفات الارتباط',eyebrow:'خياراتك الرقمية',
    description:'كيف يستخدم موقع أودير ملفات الارتباط وتقنيات التخزين المشابهة.',
    body:'تساعد ملفات الارتباط على تشغيل الموقع والجلسات بأمان وتذكر بعض التفضيلات، ويختلف الاستخدام بحسب الخصائص المفعلة.',
    items:[
      {title:'ملفات ضرورية',description:'تدعم تسجيل الدخول وأمان الجلسة ومنع إساءة الاستخدام، وقد لا تعمل الخدمة الأساسية دونها.'},
      {title:'ملفات التفضيلات',description:'تساعد على تذكر اللغة والعرض والإعدادات التي اختارها المستخدم.'},
      {title:'القياس والتحليلات',description:'قد نستخدم قياسًا محدودًا لفهم الأداء وتحسين التجربة، مع طلب الموافقة عندما يلزم.'},
      {title:'إدارة الخيارات',description:'يمكنك التحكم في الملفات من المتصفح أو أداة الموافقة عند توفرها.'}
    ]
  },
  'data-rights':{
    menuLabel:'حقوق البيانات',title:'حقوق أصحاب البيانات',eyebrow:'طلبك له مسار واضح',
    description:'كيفية ممارسة الحقوق المتعلقة بالبيانات الشخصية في أودير.',
    body:'قد تكون أودير متحكمًا في بيانات الحساب والتواصل، بينما تكون المنشأة غالبًا المتحكم في بيانات عملائها ومتدربيها داخل مساحتها.',
    items:[
      {title:'العلم والوصول',description:'يمكنك معرفة سبب جمع بياناتك وطلب الاطلاع عليها والحصول على نسخة منها عندما يجيز النظام ذلك.'},
      {title:'التصحيح والاستكمال',description:'يمكنك طلب تصحيح البيانات غير الدقيقة أو استكمال الناقص منها.'},
      {title:'الإتلاف أو سحب الموافقة',description:'يمكن طلب الإتلاف أو سحب الموافقة مع مراعاة الالتزامات والاستثناءات النظامية.'},
      {title:'تقديم الطلب',description:'قدّم الطلب عبر قنوات التواصل المعتمدة، وقد نتحقق من الهوية والصفة لحماية البيانات.'}
    ]
  }
};

export const odeirLegalSlugs=Object.keys(legalDefinitions);

export function getOdeirLegalContent(slug){
  const definition=legalDefinitions[slug];
  if(!definition)return null;
  return {
    title:definition.title,
    seoTitle:`${definition.title} | أودير`,
    seoDescription:definition.description,
    content:{
      schemaVersion:1,
      settings:{contentWidth:'wide',background:'#ffffff',customCss:odeirIdentityCss()},
      blocks:[
        {
          id:`legal-hero-${slug}`,
          type:'hero',
          props:{
            anchor:'top',eyebrow:definition.eyebrow,title:definition.title,
            body:`${definition.body} آخر تحديث: 20 أغسطس 2026.`,
            imageUrl:'',imageAlt:'',primaryLabel:'العودة إلى أودير',primaryHref:homeUrl,
            secondaryLabel:'حقوق البيانات',secondaryHref:`${homeUrl}/data-rights`
          },
          style:{variant:'dark',align:'right',paddingY:78,maxWidth:'wide',cssClass:'odeir-legal-hero'},
          responsive:{}
        },
        {
          id:`legal-cards-${slug}`,
          type:'cards',
          props:{anchor:'details',eyebrow:'التفاصيل',title:'ما الذي تعنيه هذه السياسة؟',body:'صياغة واضحة قابلة للتحديث والنشر من بيلدر موقع أودير.',columns:2,items:definition.items},
          style:{variant:'light',align:'right',paddingY:78,maxWidth:'reading',cssClass:'odeir-legal-cards'},
          responsive:{}
        }
      ]
    }
  };
}

function odeirIdentityCss(){
  return `:root{--odeir-navy:#06182e;--odeir-navy-soft:#0b2949;--odeir-cyan:#13c7d1;--odeir-teal:#08b8b1;--odeir-gold:#f0c534;--odeir-paper:#f7f2e8}.odeir-product-hero{background:radial-gradient(circle at 14% 18%,rgba(19,199,209,.2),transparent 30%),radial-gradient(circle at 90% 6%,rgba(240,197,52,.14),transparent 26%),linear-gradient(145deg,#031326 0%,#06182e 54%,#0b2949 100%)!important}.odeir-product-hero h1{font-size:clamp(50px,6vw,82px)!important;line-height:1.08!important;letter-spacing:-.045em}.odeir-product-hero .buttonRow a:first-child{background:#f0c534!important;border-color:#f0c534!important;color:#06182e!important;border-radius:12px!important}.odeir-product-hero .buttonRow a:last-child{border-color:rgba(19,199,209,.55)!important;border-radius:12px!important}.odeir-capabilities{background:#f7f9fc!important}.odeir-capabilities article,.odeir-trust article{border-radius:18px!important;transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease}.odeir-capabilities article{border-color:rgba(6,24,46,.1)!important;background:#fff!important}.odeir-capabilities article:hover{transform:translateY(-4px);border-color:rgba(19,199,209,.55)!important;box-shadow:0 20px 55px rgba(6,24,46,.09)!important}.odeir-capabilities article>span:first-child{color:#08aeb7!important}.odeir-capabilities article:nth-child(3n+2)>span:first-child{color:#d1a800!important}.odeir-start{background:#f7f2e8!important}.odeir-trust{background:radial-gradient(circle at 86% 14%,rgba(19,199,209,.16),transparent 30%),radial-gradient(circle at 8% 86%,rgba(240,197,52,.09),transparent 27%),linear-gradient(145deg,#06182e,#0b2949)!important}.odeir-trust article:hover{transform:translateY(-4px);border-color:rgba(240,197,52,.42)!important}.odeir-faq{background:#fff!important}.odeir-final-cta{background:radial-gradient(circle at 12% 50%,rgba(19,199,209,.28),transparent 30%),linear-gradient(115deg,#06182e,#0b4161)!important}.odeir-final-cta a{background:#f0c534!important;color:#06182e!important;border-radius:12px!important}.odeir-legal-hero{min-height:430px!important;background:radial-gradient(circle at 12% 20%,rgba(19,199,209,.2),transparent 30%),radial-gradient(circle at 90% 10%,rgba(240,197,52,.12),transparent 24%),linear-gradient(145deg,#031326,#0b2949)!important}.odeir-legal-hero h1{font-size:clamp(42px,5vw,66px)!important}.odeir-legal-hero .buttonRow a:first-child{background:#f0c534!important;color:#06182e!important;border-radius:12px!important}.odeir-legal-cards{background:#f7f9fc!important}.odeir-legal-cards article{border-radius:16px!important;border-color:rgba(6,24,46,.1)!important;box-shadow:none!important}`;
}
