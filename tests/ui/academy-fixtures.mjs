export const access={enabled:true,mode:'standalone',odeirAccess:false,
 tenant:{id:'3d185482-b916-49cc-b868-b6dfdb93eba8',slug:'marktone',name:'مركز ماركتون للتدريب',timezone:'Asia/Riyadh',currency:'SAR'},
 components:{website:true,store:true,lms:true},permissions:{manageWebsite:true,publishWebsite:true,manageStore:true,manageLearning:true,manageAdmissions:true,verifyPayments:true,manageTeam:true}};
export const offers=[
 {id:'offer-one',title:'إدارة المشاريع الاحترافية',description:'برنامج تطبيقي لفهم دورة حياة المشروع وإدارة الوقت والميزانية والفريق.',learningMode:'cohort',startsAt:'2026-10-20T15:00:00Z',totalMinor:115000,taxMinor:15000,currency:'SAR',published:true,learningReady:true,available:true,version:1},
 {id:'offer-two',title:'تحليل البيانات باستخدام Power BI',description:'تعلّم على وتيرتك وحوّل البيانات إلى تقارير تساعد على اتخاذ القرار.',learningMode:'self_paced',totalMinor:69000,taxMinor:9000,currency:'SAR',published:false,learningReady:true,available:true,version:1}
];
export const commerce={tenant:access.tenant,mode:'standalone',canManageStore:true,canConfigureStore:true,canVerifyPayments:true,canInviteLearners:true,
 offers,courses:[{id:'course-one',title:'إدارة المشاريع الاحترافية'}],runs:[{id:'run-one',courseId:'course-one',title:'دفعة أكتوبر'}],finance:{currency:'SAR',taxRegistered:true,taxRateBps:1500},
 settings:{bankName:'بنك تجريبي',accountName:'مركز التدريب التجريبي',iban:'SA0000000000000000000000',checkoutEnabled:true,refundPolicy:'سياسة تجريبية للتحقق من العرض فقط، وليست شروط بيع.'},
 orders:[{id:'order-one',reference:'QA-1001',status:'payment_review',title:offers[0].title,totalMinor:115000,currency:'SAR',learner:{name:'متدرب تجريبي',phone:'0500000000',email:'learner@example.test'},payer:{name:'جهة تجريبية',phone:'0510000000',email:'payer@example.test'},reportedReference:'QA-BANK-1'},
 {id:'order-two',reference:'QA-1002',status:'enrolled',title:offers[1].title,totalMinor:69000,currency:'SAR',learner:{name:'متدربة تجريبية',phone:'0520000000',email:'student@example.test'},payer:{name:'متدربة تجريبية',phone:'0520000000',email:'student@example.test'},studentId:'student-two'}],hasMore:false};
export const storefront={tenant:access.tenant,offers,checkoutEnabled:true,refundPolicy:commerce.settings.refundPolicy};
export const site={available:true,site:{key:'tenant:marktone',nameAr:access.tenant.name,theme:{},settings:{},academyNavigation:{slug:'marktone',lms:true,store:true}},menu:[{id:'home',label:'الرئيسية',href:'/',sortOrder:0,columnIndex:1}],footerMenu:[],articles:[],homePage:{content:{version:3,blocks:[]}}};
