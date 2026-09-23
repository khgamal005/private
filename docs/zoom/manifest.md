# Manifest الصلاحيات والقدرات والأحداث

مراجعة المراجع الرسمية: 2026-09-22. قائمة ضبط للتطبيق واختبار العقد؛ **ليست إثبات منح scopes أو رخص حساب فعلي**. المصدر: [Granular scopes](https://developers.zoom.us/docs/integrations/oauth-scopes-granular/)، [Meeting APIs](https://developers.zoom.us/docs/api/meetings/)، [الأحداث](https://developers.zoom.us/docs/api/meetings/events/)، [OAuth](https://developers.zoom.us/docs/integrations/oauth/)، [SDK](https://developers.zoom.us/docs/meeting-sdk/obf-faq/).

## REST

الاختيار الأساسي General OAuth من نوع Account/admin-managed لمضيفي حساب العميل. `:admin` أدناه يخص ذلك التفويض. منح User-managed لا يمنح إدارة بقية مضيفي الحساب، ولا يُستخدم لتجاوزها. ليست scopes Classic أو Master بديلًا تلقائيًا. بعد إضافة scope يلزم إعادة تفويض وفحص قدرة الوظيفة. الكود الفعلي في `_shared/zoom-client.mjs` و`zoom-connect/handler.mjs`.

| الوظيفة | Method + endpoint (بعد /v2) | Scope granular | متطلب القدرة |
|---|---|---|---|
| هوية التفويض/مدرب | GET /users/me، /users/{userId} | user:read:user:admin | هوية من الحساب نفسه |
| المضيفون | GET /users | user:read:list_users:admin | إدارة الحساب؛ صفحات منفصلة |
| السعة والإعدادات | GET /users/{userId}/settings | user:read:settings:admin | user نشط وLicensed وإعدادات قابلة للتحقق |
| الانشغال المعروف | GET /users/{userId}/meetings?type=scheduled | meeting:read:list_meetings:admin | تغطية معلنة؛ عدم رؤية اجتماع ليس ضمان فراغ |
| إنشاء اجتماع | POST /users/{userId}/meetings | meeting:write:meeting:admin | registration وحجم الاجتماع المطلوب |
| قراءة/تعديل/إلغاء | GET/PATCH/DELETE /meetings/{id} | meeting:read:meeting:admin / meeting:update:meeting:admin / meeting:delete:meeting:admin | مورد مملوك؛ occurrence_id للتعديل المحدد |
| تسجيل فردي | POST /meetings/{id}/registrants | meeting:write:registrant:admin | تسجيل بالموافقة التلقائية؛ occurrence_ids عند التكرار |
| استرداد تسجيل | GET /meetings/{id}/registrants | meeting:read:list_registrants:admin | قائمة مكتملة، هوية فريدة، occurrence_id |
| إبطال تسجيل | PUT /meetings/{id}/registrants/status | meeting:update:registrant_status:admin | التسجيل المحدد، occurrence_id |
| الوقائع | GET /past_meetings/{id}/instances | meeting:read:list_past_instances:admin | بيانات الماضي المتاحة للخطة |
| تفاصيل الماضي | GET /past_meetings/{uuid} | meeting:read:past_meeting:admin | UUID مشفر بحسب Zoom |
| فترات المشاركين | GET /past_meetings/{uuid}/participants | meeting:read:list_past_participants:admin | قد تتأخر معالجة المدد؛ جميع الصفحات المطلوبة |
| التسجيل والتفريغ | GET /meetings/{uuid}/recordings | cloud_recording:read:list_recording_files:admin | Cloud Recording وملف جاهز وسياسة مصرح بها |
| استطلاعات اجتماع | GET/POST /meetings/{id}/polls | meeting:read:list_polls:admin / meeting:write:poll:admin | polling مفعل؛ ليست درجة اختبار |
| إنشاء ندوة | POST /users/{userId}/webinars | webinar:write:webinar:admin | رخصة Webinar وسعتها |
| قراءة/تعديل/إلغاء ندوة | GET/PATCH/DELETE /webinars/{id} | webinar:read:webinar:admin / webinar:update:webinar:admin / webinar:delete:webinar:admin | مورد Webinar مؤهل |
| تسجيل/قائمة/إبطال ندوة | POST/GET /webinars/{id}/registrants؛ PUT .../status | webinar:write:registrant:admin / webinar:read:list_registrants:admin / webinar:update:registrant_status:admin | موافقة العميل وسجل CRM مخوّل |
| وقائع/مشاركو ندوة | GET /past_webinars/{id}/instances؛ GET /past_webinars/{uuid}/participants | webinar:read:list_past_instances:admin / webinar:read:list_past_participants:admin | Pro+ مع Webinar حسب المرجع الحالي |
| استطلاعات ندوة | GET/POST /webinars/{id}/polls | webinar:read:list_polls:admin / webinar:write:poll:admin | webinar polling |
| بدء/هوية SDK | GET /users/{userId}/token?type=zak | user:read:token:admin | هوية المستخدم المخوّل نفسه؛ تحقق التطبيق ومسار ZAK في الحساب التجريبي |

استبدال code وتجديد الرمز: POST `https://zoom.us/oauth/token` باستخدام سر التطبيق في الخادم. إلغاء التفويض الصريح يعبر مسار المزود المنفصل؛ لا حذف للاجتماعات/التسجيلات الأصلية كأثر جانبي للفصل. لا نطلب scopes حذف التسجيلات أو شراء/نقل الرخص أو RTMS. الغرف الفرعية تُدار من عميل Zoom عند توفرها؛ لا زر تحكم محلي مصطنع.

## صلاحيات أودير

`tenant.zoom.` مع لاحقات connections.manage، hosts.manage، sessions.manage، attendance.review، attendance.override، recordings.publish، reports.export، retention.manage، ai.generate، webinars.manage. الربط مع سجل ACL الحالي في migration الأولى. بعض الإدارة تستخدم تفويضات settings/manage أو academy/write القائمة **داخل عضوية منشأة فعلية**. لم تُمنح الأدوار صلاحيات عامة تلقائيًا. `platform.control.read` وحدها لا تفتح محتوى Zoom لمنشأة.

المدرب: إسناد active في الدفعة وهوية فعالة؛ البدء يتطلب كذلك host binding متحقق حديثًا. الطالب: training_learner_accounts وتسجيله فقط. العامل service-only يستدعي وظائف محكومة ويعيد التحقق من actor/tenant/version؛ لا يكفي امتلاكه service key. wrappers السابقة غير ممنوحة للعملاء. كل إصدار link/export وتغيير حضور/نشر/حساب مدقق دون أسرار.

## أحداث الاستقبال

المسار POST `<SUPABASE_URL>/functions/v1/zoom-connect/webhook`. تعطيل JWT verification لهذه Edge Function يُعوّض بضوابط مختلفة لكل مسار: Webhook HMAC خام، dispatch secret، JWT مستخدم لبقية الأفعال. لا تعرض service key في URL أو المتصفح.

| الحدث | أثر المعالجة |
|---|---|
| endpoint.url_validation | challenge بعد التحقق من توقيع الطلب |
| meeting.created / webinar.created | دليل مزود؛ لا إنشاء محاضرة أكاديمية تلقائية |
| meeting.updated / webinar.updated | تحقق GET ومقارنة desired/observed، حتى دون UUID |
| meeting.deleted / webinar.deleted | فحص عدم وجود الأصل/الوقعة، حالة اختلاف تحفظ التاريخ |
| meeting.started / webinar.started | انعقاد بوقت المصدر؛ لا يُرجع حدث قديم نهاية أحدث |
| meeting.ended / webinar.ended | إنهاء الانعقاد المحدد ثم جمع التقارير |
| meeting.participant_joined/left؛ webinar.participant_joined/left | دليل أولي؛ العدد مؤقت مع آخر حدث؛ لا غياب نهائي من غياب الحدث |
| recording.completed | جلب الملفات إلى المراجعة، دون نشر تلقائي |
| app_deauthorized | إيقاف الوصول، حذف أسرار، طلب تنظيف وفق المصفوفة |

نافذة التوقيع خمس دقائق، مقارنة ثابتة، حد الجسم، dedupe من projection للحدث/الحساب/UUID/المشارك/الوقت. ACK بعد الحفظ المتين. اختبارات محلية للتحريف والتكرار والترتيب؛ مهلة الشبكة وإعادة التحقق من Zoom تحتاج تجربة مأذونة. وثّق أسماء اشتراكات التطبيق الفعلية ورخصته قبل التفعيل؛ لا تفترض وصول أحداث غير مشتركة.
