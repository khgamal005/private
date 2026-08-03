export const BUILDER_SCHEMA_VERSION=1;

const BASE_RESPONSIVE={
  hideDesktop:false,
  hideTablet:false,
  hideMobile:false
};

const BASE_STYLE={
  variant:'light',
  align:'right',
  paddingY:72,
  maxWidth:'wide',
  background:'',
  color:''
};

export const BLOCK_CATALOG=Object.freeze({
  hero:{
    label:'واجهة رئيسية',icon:'✦',category:'أساسية',
    description:'عنوان قوي، وصف، أزرار وصورة أو شكل بصري.',
    defaults:{
      props:{
        anchor:'',eyebrow:'ماركتون',title:'عنوان رئيسي يصنع الانطباع الأول',
        body:'اكتب وصفًا واضحًا يشرح القيمة التي تقدمها هذه الصفحة.',
        imageUrl:'',imageAlt:'',
        primaryLabel:'ابدأ الآن',primaryHref:'#contact',
        secondaryLabel:'اعرف المزيد',secondaryHref:'#details'
      },
      style:{...BASE_STYLE,variant:'dark',paddingY:96},
      responsive:{...BASE_RESPONSIVE}
    }
  },
  heading:{
    label:'عنوان قسم',icon:'H',category:'نصوص',
    description:'عنوان وملخص لافتتاح قسم جديد.',
    defaults:{
      props:{anchor:'',eyebrow:'عنوان صغير',title:'عنوان القسم',body:'وصف مختصر يهيئ القارئ للمحتوى التالي.',level:'h2'},
      style:{...BASE_STYLE,paddingY:48},responsive:{...BASE_RESPONSIVE}
    }
  },
  text:{
    label:'نص',icon:'¶',category:'نصوص',
    description:'فقرات نصية مرنة مع عرض ومحاذاة قابلين للتحكم.',
    defaults:{
      props:{anchor:'',content:'اكتب المحتوى هنا.\n\nيمكنك فصل الفقرات بسطر فارغ.',columns:1},
      style:{...BASE_STYLE,paddingY:36,maxWidth:'reading'},responsive:{...BASE_RESPONSIVE}
    }
  },
  image:{
    label:'صورة',icon:'▧',category:'وسائط',
    description:'صورة كاملة أو داخل إطار مع وصف اختياري.',
    defaults:{
      props:{anchor:'',url:'',alt:'',caption:'',ratio:'16 / 9',fit:'cover'},
      style:{...BASE_STYLE,paddingY:36},responsive:{...BASE_RESPONSIVE}
    }
  },
  buttons:{
    label:'مجموعة أزرار',icon:'↗',category:'أساسية',
    description:'زر أساسي وآخر ثانوي في صف واحد.',
    defaults:{
      props:{anchor:'',primaryLabel:'تواصل معنا',primaryHref:'#contact',secondaryLabel:'دخول العملاء',secondaryHref:'/login'},
      style:{...BASE_STYLE,paddingY:28,align:'center'},responsive:{...BASE_RESPONSIVE}
    }
  },
  cards:{
    label:'بطاقات',icon:'▦',category:'محتوى',
    description:'شبكة خدمات أو مزايا أو خطوات.',
    defaults:{
      props:{
        anchor:'',eyebrow:'مزايا',title:'ما الذي نقدمه؟',body:'مجموعة مترابطة من الحلول.',columns:3,
        items:[
          {title:'الميزة الأولى',description:'وصف مختصر للميزة الأولى.'},
          {title:'الميزة الثانية',description:'وصف مختصر للميزة الثانية.'},
          {title:'الميزة الثالثة',description:'وصف مختصر للميزة الثالثة.'}
        ]
      },
      style:{...BASE_STYLE,paddingY:72},responsive:{...BASE_RESPONSIVE}
    }
  },
  stats:{
    label:'أرقام وإحصائيات',icon:'123',category:'محتوى',
    description:'أرقام بارزة تدعم الرسالة والثقة.',
    defaults:{
      props:{
        anchor:'',eyebrow:'أثر قابل للقياس',title:'نتائج تظهر في الأرقام',body:'استخدم أرقامًا يمكن إثباتها وتحديثها.',columns:4,
        items:[
          {value:'+20',title:'عامًا',description:'خبرة في التعليم والتشغيل'},
          {value:'360°',title:'رؤية موحدة',description:'لرحلة العميل والعمليات'},
          {value:'24/7',title:'متابعة',description:'للبيانات ومؤشرات الأداء'},
          {value:'1',title:'منظومة',description:'تربط الأدوات والفرق'}
        ]
      },
      style:{...BASE_STYLE,variant:'dark',paddingY:64},responsive:{...BASE_RESPONSIVE}
    }
  },
  columns:{
    label:'أعمدة محتوى',icon:'Ⅱ',category:'تخطيط',
    description:'عمودان أو ثلاثة للنصوص والمقارنات.',
    defaults:{
      props:{
        anchor:'',columns:2,
        items:[
          {title:'العمود الأول',description:'المحتوى الأول يوضع هنا.'},
          {title:'العمود الثاني',description:'المحتوى الثاني يوضع هنا.'}
        ]
      },
      style:{...BASE_STYLE,paddingY:56},responsive:{...BASE_RESPONSIVE}
    }
  },
  quote:{
    label:'اقتباس أو شهادة',icon:'❞',category:'محتوى',
    description:'شهادة عميل أو اقتباس إداري بارز.',
    defaults:{
      props:{anchor:'',quote:'ضع هنا شهادة حقيقية أو اقتباسًا يختصر قيمة التجربة.',author:'اسم العميل',role:'المسمى أو المنشأة'},
      style:{...BASE_STYLE,variant:'paper',paddingY:56,maxWidth:'reading'},responsive:{...BASE_RESPONSIVE}
    }
  },
  faq:{
    label:'أسئلة شائعة',icon:'?',category:'محتوى',
    description:'أسئلة وأجوبة قابلة للفتح والإغلاق.',
    defaults:{
      props:{
        anchor:'faq',eyebrow:'الأسئلة الشائعة',title:'إجابات واضحة قبل البدء',body:'',
        items:[
          {title:'كيف نبدأ؟',description:'نبدأ بجلسة تشخيص وفهم الاحتياج.'},
          {title:'هل الحل قابل للتخصيص؟',description:'نعم، يتم اختيار المكونات وفق واقع المؤسسة.'}
        ]
      },
      style:{...BASE_STYLE,paddingY:72,maxWidth:'reading'},responsive:{...BASE_RESPONSIVE}
    }
  },
  cta:{
    label:'دعوة لاتخاذ إجراء',icon:'◎',category:'أساسية',
    description:'شريط ختامي قوي لتحويل الزائر.',
    defaults:{
      props:{anchor:'',eyebrow:'الخطوة التالية',title:'ابدأ بخطوة واضحة',body:'شاركنا التحدي وسنحدد معك المسار الأنسب.',buttonLabel:'تواصل معنا',buttonHref:'#contact'},
      style:{...BASE_STYLE,variant:'brand',paddingY:64},responsive:{...BASE_RESPONSIVE}
    }
  },
  contact:{
    label:'نموذج تواصل',icon:'✉',category:'نماذج',
    description:'نموذج مرتبط برسائل الموقع وقاعدة البيانات.',
    defaults:{
      props:{anchor:'contact',eyebrow:'تواصل معنا',title:'دعنا نفهم احتياجك',body:'اكتب نبذة قصيرة وسيتواصل معك فريق ماركتون.',buttonLabel:'إرسال الطلب'},
      style:{...BASE_STYLE,paddingY:80},responsive:{...BASE_RESPONSIVE}
    }
  },
  divider:{
    label:'فاصل',icon:'—',category:'تخطيط',
    description:'خط فاصل مرن بين أجزاء الصفحة.',
    defaults:{
      props:{anchor:'',width:100,thickness:1},
      style:{...BASE_STYLE,paddingY:16,maxWidth:'wide'},responsive:{...BASE_RESPONSIVE}
    }
  },
  spacer:{
    label:'مسافة',icon:'↕',category:'تخطيط',
    description:'مساحة رأسية منفصلة لكل حجم شاشة.',
    defaults:{
      props:{anchor:'',desktop:72,tablet:52,mobile:36},
      style:{...BASE_STYLE,paddingY:0},responsive:{...BASE_RESPONSIVE}
    }
  }
});

export const BUILDER_TEMPLATES=Object.freeze({
  blank:{
    label:'صفحة فارغة',description:'ابدأ بواجهة رئيسية ومساحة بيضاء.',
    blocks:['hero','text','contact']
  },
  landing:{
    label:'صفحة هبوط',description:'واجهة، أرقام، مزايا، دعوة ونموذج تواصل.',
    blocks:['hero','stats','cards','cta','contact']
  },
  service:{
    label:'صفحة خدمة',description:'واجهة، شرح، محاور الخدمة، أسئلة وتواصل.',
    blocks:['hero','heading','columns','cards','faq','contact']
  }
});

export function createBuilderId(prefix='block'){
  const random=globalThis.crypto?.randomUUID?.()
    ||`${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${String(random).replaceAll('-','').slice(0,16)}`;
}

export function createBuilderBlock(type,overrides={}){
  const definition=BLOCK_CATALOG[type]||BLOCK_CATALOG.text;
  const defaults=clone(definition.defaults);
  return {
    id:overrides.id||createBuilderId(type),
    type:BLOCK_CATALOG[type]?type:'text',
    props:{...defaults.props,...clone(overrides.props||{})},
    style:{...defaults.style,...clone(overrides.style||{})},
    responsive:{...defaults.responsive,...clone(overrides.responsive||{})}
  };
}

export function createBuilderDocument(templateKey='blank'){
  const template=BUILDER_TEMPLATES[templateKey]||BUILDER_TEMPLATES.blank;
  return {
    schemaVersion:BUILDER_SCHEMA_VERSION,
    settings:{contentWidth:'wide',background:'#ffffff'},
    blocks:template.blocks.map(type=>createBuilderBlock(type))
  };
}

export function normalizeBuilderDocument(input){
  const source=input&&typeof input==='object'?input:{};
  const blocks=Array.isArray(source.blocks)?source.blocks:[];
  return {
    schemaVersion:BUILDER_SCHEMA_VERSION,
    settings:{
      contentWidth:['wide','full','reading'].includes(source.settings?.contentWidth)
        ?source.settings.contentWidth:'wide',
      background:safeColor(source.settings?.background,'#ffffff')
    },
    blocks:blocks
      .filter(block=>block&&typeof block==='object'&&BLOCK_CATALOG[block.type])
      .slice(0,80)
      .map(block=>createBuilderBlock(block.type,block))
  };
}

export function isBuilderDocument(value){
  return Boolean(
    value&&typeof value==='object'
    &&Number(value.schemaVersion)===BUILDER_SCHEMA_VERSION
    &&Array.isArray(value.blocks)
  );
}

export function blockCatalogGroups(){
  const result=new Map();
  for(const [type,definition] of Object.entries(BLOCK_CATALOG)){
    const items=result.get(definition.category)||[];
    items.push({type,...definition});
    result.set(definition.category,items);
  }
  return [...result.entries()].map(([category,items])=>({category,items}));
}

function safeColor(value,fallback){
  const result=String(value||'').trim();
  return /^#[0-9a-f]{3,8}$/i.test(result)?result:fallback;
}

function clone(value){
  return value===undefined?undefined:JSON.parse(JSON.stringify(value));
}
