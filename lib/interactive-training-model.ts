export type Role='admin'|'instructor'|'student';
export type Course={id:string;title:string;category:string;color:string;hours:number;mode:string;instructor:string;status:string;modules:string[];outcome:string;reviewed?:boolean;audience?:string;level?:string;references?:string};
export const coursesSeed:Course[]=[
{id:'data',title:'تحليل البيانات باستخدام Power BI',category:'البيانات والتحليل',color:'blue',hours:12,mode:'مدمج',instructor:'د. أحمد السالم',status:'متاحة للتجربة',modules:['من البيانات إلى القرار','تجهيز البيانات وتنظيفها','تصميم لوحة المؤشرات','الاختبار التطبيقي النهائي'],outcome:'يبني المتدرب لوحة مؤشرات ويختار المقياس المناسب لاتخاذ قرار موثّق.'},
{id:'ai',title:'الذكاء الاصطناعي في بيئة العمل',category:'الذكاء الاصطناعي',color:'',hours:8,mode:'ذاتي',instructor:'د. أحمد السالم',status:'متاحة للتجربة',modules:['أساسيات الذكاء الاصطناعي','صياغة الأوامر الفعّالة','أتمتة المهام اليومية','مشروع تطبيقي وتقييم'],outcome:'يصمم المتدرب أمرًا واضحًا ويقيّم المخرجات قبل استخدامها مع حماية البيانات.'},
{id:'project',title:'أساسيات إدارة المشاريع',category:'الإدارة والقيادة',color:'mint',hours:16,mode:'مباشر',instructor:'سارة العبدالله',status:'متاحة للتجربة',modules:['تحديد نطاق المشروع','التخطيط والجدولة','المخاطر وأصحاب المصلحة','تسليم المشروع'],outcome:'يعد المتدرب خطة مشروع ذات نطاق ومخرجات ومعايير قبول محددة.'},
{id:'excel',title:'Excel لاتخاذ قرارات أفضل',category:'البيانات والتحليل',color:'mint',hours:10,mode:'ذاتي',instructor:'د. أحمد السالم',status:'متاحة للتجربة',modules:['تنظيم البيانات','الدوال الأساسية','الجداول المحورية','التقييم النهائي'],outcome:'يحلل المتدرب مجموعة بيانات باستخدام الدوال والجداول المحورية.'},
{id:'lead',title:'مهارات القيادة وبناء الفريق',category:'الإدارة والقيادة',color:'amber',hours:8,mode:'مدمج',instructor:'سارة العبدالله',status:'مسودة',modules:['أنماط القيادة','التواصل الفعّال','التفويض','خطة تطوير الفريق'],outcome:'يعد المتدرب خطة تفويض مبنية على أدوار ومسؤوليات واضحة.'},
{id:'marketing',title:'استراتيجية التسويق الرقمي',category:'التسويق',color:'blue',hours:12,mode:'مدمج',instructor:'سارة العبدالله',status:'قيد المراجعة',modules:['فهم الجمهور','بناء خطة المحتوى','الحملات المدفوعة','قياس النتائج'],outcome:'يصمم المتدرب خطة حملة تتضمن أهدافًا ومقاييس قابلة للتحقق.'}
];
export const pathsSeed=[{id:'digital',title:'المهارات الرقمية للمستقبل',desc:'من فهم البيانات إلى تطبيق الذكاء الاصطناعي في العمل.',courses:['excel','data','ai'],color:'',tag:'الأكثر تقدمًا'},{id:'leader',title:'رحلة القائد الفعّال',desc:'تخطيط أفضل، قيادة واعية، وفرق تحقق نتائج.',courses:['project','lead'],color:'mint',tag:'مسار تخصصي'},{id:'growth',title:'التسويق المبني على البيانات',desc:'اربط التسويق بالتحليل لاتخاذ قرارات أوضح.',courses:['data','marketing'],color:'blue',tag:'مسار تخصصي'}];
export const learnersSeed=[{id:'l1',name:'محمد العتيبي',initial:'م ع',course:'data',progress:75,attendance:92,score:85},{id:'l2',name:'نورة الحربي',initial:'ن ح',course:'ai',progress:100,attendance:100,score:94},{id:'l3',name:'عبدالله القحطاني',initial:'ع ق',course:'project',progress:50,attendance:88,score:76},{id:'l4',name:'ريم الشهري',initial:'ر ش',course:'data',progress:25,attendance:65,score:58},{id:'l5',name:'خالد الدوسري',initial:'خ د',course:'excel',progress:100,attendance:100,score:91},{id:'l6',name:'سارة المالكي',initial:'س م',course:'ai',progress:50,attendance:90,score:82},{id:'l7',name:'فهد الغامدي',initial:'ف غ',course:'project',progress:25,attendance:60,score:55},{id:'l8',name:'هند الزهراني',initial:'ه ز',course:'excel',progress:75,attendance:96,score:88}];
export const sessions=[{id:'s1',day:'17',month:'سبتمبر',title:'ورشة تصميم لوحة المؤشرات',course:'data',time:'06:00 – 07:30 مساءً',instructor:'د. أحمد السالم',type:'ورشة مباشرة'},{id:'s2',day:'18',month:'سبتمبر',title:'تخطيط المشروع وإدارة الموارد',course:'project',time:'05:00 – 06:30 مساءً',instructor:'سارة العبدالله',type:'محاضرة مباشرة'},{id:'s3',day:'20',month:'سبتمبر',title:'عيادة الأوامر الذكية',course:'ai',time:'07:00 – 08:00 مساءً',instructor:'د. أحمد السالم',type:'جلسة إثرائية'}];
export const standardUrl='https://nelc.gov.sa/en/regulations-and-standards/elearning-standards';
export const complianceSeed=[
{id:'license',title:'الترخيص والتكامل',ref:'الترخيص النظامي',detail:'توثيق ترخيص البرنامج ومسار الجهة المختصة واستكمال الربط التقني المطلوب مع FutureX.',evidence:'ترخيص ساري + نتيجة تحقق التكامل مع FutureX',url:'https://nelc.gov.sa/en/media-center/news/unified-e-learning-licensing-private-sector-en'},
{id:'policy',title:'السياسات والحقوق',ref:'الحوكمة والسياسات',detail:'إتاحة النزاهة والخصوصية والملكية الفكرية والدعم والشكاوى بوضوح للمستفيد.',evidence:'سياسات منشورة وموافقات مؤرخة',url:standardUrl},
{id:'ai',title:'حوكمة الذكاء الاصطناعي',ref:'1.7 / 2.3',detail:'الإفصاح عن استخدام الذكاء الاصطناعي ومراجعة المحتوى بشريًا قبل نشره.',evidence:'سجل المصدر والمراجع البشري وإصدار المحتوى',url:standardUrl},
{id:'outcome',title:'تصميم ومخرجات التعلم',ref:'جودة التصميم',detail:'أهداف قابلة للقياس تتسق مع الدروس والأنشطة وأساليب التقييم.',evidence:'مصفوفة ربط المخرج بالنشاط والتقييم',url:standardUrl},
{id:'access',title:'سهولة الوصول والإتاحة',ref:'إتاحة المحتوى',detail:'تنقل بلوحة المفاتيح ونصوص بديلة للمحتوى المرئي ودعم الأجهزة المختلفة.',evidence:'تقرير اختبار إتاحة + نصوص الفيديو البديلة',url:standardUrl},
{id:'identity',title:'الهوية والنزاهة',ref:'5.6',detail:'التحقق من الهوية وإجراءات حماية الدخول بحسب المخاطر، وضبط المحاولات والتقييمات.',evidence:'اختبارات الهوية والصلاحيات ومحاضر النزاهة',url:standardUrl},
{id:'attendance',title:'توثيق الحضور والتفاعل',ref:'متابعة التعلم',detail:'تمييز وقت الاتصال عن التعلم الفعلي وتتبع الدروس والأنشطة والمحاضرات.',evidence:'سجل أحداث تعلم وحضور قابل للتدقيق',url:standardUrl},
{id:'assessment',title:'التقييم وقياس المخرجات',ref:'التقويم',detail:'اختبارات قبلية وتكوينية وختامية مع تغذية راجعة ومعايير تقدير واضحة.',evidence:'بنك أسئلة وخريطة مخرجات وسجل نتائج',url:standardUrl},
{id:'support',title:'الدعم والتواصل',ref:'دعم المستفيد',detail:'قنوات دعم فني وتعليمي، إرشاد للبدء، وسياسة معلنة لأزمنة الاستجابة.',evidence:'سجل تذاكر وإرشادات وتقارير استجابة',url:standardUrl},
{id:'analytics',title:'التحليلات والتحسين',ref:'5.5',detail:'تحليل تقدم المتدربين وقياس رضاهم وتوثيق قرارات التحسين والتحقق من الربط المطلوب.',evidence:'تقارير تحليلية وخطة تحسين وربط تقني',url:standardUrl},
{id:'security',title:'الأمن وحماية البيانات',ref:'موثوقية المنصة',detail:'صلاحيات حسب الدور وعزل المنشآت ونسخ احتياطية واختبار الاستعادة.',evidence:'اختبارات العزل والصلاحيات واستعادة النسخ',url:standardUrl},
{id:'team',title:'جاهزية المحاضرين',ref:'التأهيل والتدريب',detail:'تأهيل الفريق لتقديم التدريب الإلكتروني وتوثيق خبراته وإرشادات التشغيل.',evidence:'ملفات التأهيل وخطة تدريب الفريق',url:standardUrl}
];
export const lessonTexts:Record<string,string[]>={data:['القرار الجيد يبدأ بسؤال واضح. قبل تصميم أي رسم، حدّد من سيستخدمه وما القرار الذي يريد اتخاذه. مثال: هل نحتاج زيادة التسجيل أم تقليل التسرب؟','ابدأ بفحص القيم المفقودة والتكرار وأنواع الأعمدة. وثّق التعديلات ولا تستبدل البيانات الأصلية قبل التحقق من النتائج.','اختر مؤشرًا مرتبطًا بهدف. نسبة إكمال الدورة تساوي عدد المستكملين مقسومًا على عدد الملتحقين، مع إعلان الفترة والفئة المستخدمة.','قارن بين لوحة ممتلئة بالأرقام ولوحة تجيب عن سؤال واحد. سلّم تصميمًا موجزًا يوضح المقياس ومصدره وحدوده.'],ai:['النموذج اللغوي ينتج إجابات محتملة، ويحتاج مراجعة بشرية. استخدمه للمسودة والتحليل المبدئي، وتحقق من الحقائق قبل اعتماد المخرجات.','يتكون الأمر الفعّال من الهدف والسياق والقيود وشكل المخرج. تجنب تضمين بيانات شخصية أو أسرار عمل في أدوات غير مصرح بها.','اختر مهمة متكررة، وحدد مدخلاتها ومخرجاتها ونقطة المراجعة البشرية. اختبر النتيجة على أمثلة آمنة قبل التطبيق.','اكتب أمرًا لإنشاء ملخص تدريبي، ثم حدد ثلاث نقاط ستراجعها قبل استخدامه مع المتدربين.']};
export function emptyDemo(){return {courses:coursesSeed,completed:{} as Record<string,number[]>,quizPassed:{} as Record<string,boolean>,assignments:{} as Record<string,string>,grades:{} as Record<string,number>,notes:{} as Record<string,string>,discussions:[] as {name:string;text:string;course:string}[],survey:{} as Record<string,number>,surveySubmitted:false,evidence:{} as Record<string,string>,attendance:{} as Record<string,boolean>,pilot:true,waitlist:['أمل العنزي','عمر الشمري'],admitted:[] as string[],placement:null as number|null,aiAudit:[] as {title:string;reviewer:string;at:string}[]};}
export type Demo=ReturnType<typeof emptyDemo>;

export function isCourseComplete(d:Demo,id:string):boolean {
 const c=d.courses.find(c=>c.id===id);
 return !!c && c.modules.every((_,i)=>(d.completed[id]||[]).includes(i)) && !!d.quizPassed[id] && !!d.assignments[id] && d.grades[id]>=70;
}
export function restoreDemo(value:unknown):Demo {
 const seed=emptyDemo();
 if(!value||typeof value!=='object'||Array.isArray(value))return seed;
 const x=value as Record<string,unknown>;
 const record=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const mapOf=(v:unknown,check:(v:unknown)=>boolean)=>record(v)&&Object.values(v as object).every(check);
 const str=(v:unknown)=>typeof v==='string';
 const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
 const bool=(v:unknown)=>typeof v==='boolean';
 if(!Array.isArray(x.courses)||!x.courses.length||!x.courses.every(c=>record(c)&&['id','title','category','color','mode','instructor','status','outcome'].every(k=>str(c[k]))&&num(c.hours)&&Array.isArray(c.modules)&&c.modules.length>0&&c.modules.every(str)))return seed;
 if(!coursesSeed.every(c=>(x.courses as Course[]).some(p=>p.id===c.id)))return seed;
 if(new Set((x.courses as Course[]).map(c=>c.id)).size!==(x.courses as Course[]).length)return seed;
 if(!mapOf(x.completed,v=>Array.isArray(v)&&v.every(n=>Number.isInteger(n)&&n>=0)))return seed;
 if(!mapOf(x.quizPassed,bool)||!mapOf(x.assignments,str)||!mapOf(x.grades,num)||!mapOf(x.notes,str)||!mapOf(x.survey,num)||!mapOf(x.evidence,str)||!mapOf(x.attendance,bool))return seed;
 if(!Array.isArray(x.discussions)||!x.discussions.every(v=>record(v)&&['name','text','course'].every(k=>str(v[k]))))return seed;
 if(!Array.isArray(x.aiAudit)||!x.aiAudit.every(v=>record(v)&&['title','reviewer','at'].every(k=>str(v[k]))))return seed;
 if(!Array.isArray(x.waitlist)||!x.waitlist.every(str)||!Array.isArray(x.admitted)||!x.admitted.every(str)||!bool(x.pilot)||!bool(x.surveySubmitted)||!(x.placement===null||num(x.placement)))return seed;
 const result={...seed,...x} as Demo;
 result.completed=Object.fromEntries(Object.entries(result.completed).map(([id,ids])=>[id,[...new Set(ids)].filter(i=>i<(result.courses.find(c=>c.id===id)?.modules.length||0))]));
 return result;
}
