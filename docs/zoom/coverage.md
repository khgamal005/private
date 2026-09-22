# مصفوفة التنفيذ والتحقق — سجل عمل، وليس شهادة اكتمال

المرجع الملزم: [المواصفة كاملة](scope-ar-v1.md). «محلي» يعني بيانات اصطناعية وقاعدة منفصلة. «عقد» يعني adapter مزود اختباري ينفذ طلبات المسار الحقيقي. **لا شيء اختُبر حيًا مع Zoom أو نُشر أو فُعّل.**

| المتطلب | التنفيذ الحالي ومصدره | الدليل المتاح | العمل الباقي |
|---|---|---|---|
| ZM-01 | migrations accounts_resources؛ zoom-client؛ OAuth callback | zoom-accounts + provider؛ حسابان وإعادة ربط وعزل | إعداد General OAuth وتجربة مأذونة؛ لا إنتاج |
| ZM-02 | hosts/host_instructors؛ resource_syncs؛ تحقق البريد وهوية المزود؛ تحديث دوري | accounts/advanced/scheduling؛ إثبات خانتين من Concurrent add-on بحد محافظ | تحقق خطط Business الأساسية غير المثبتة؛ مرجع 1 عند غياب الدليل |
| ZM-03 | reservations/candidates؛ أقفال منشأة ومدرب؛ teacher/provider slot | PostgreSQL اتصالان حقيقيان، scheduling، UI→SQL | توسيع قبول DST والانشغال الخارجي؛ لا زعم منع انشغال غير مرئي |
| ZM-04 | assign/update/cancel/import/batch/replace + outbox | scheduling/advanced + UI→worker→SQL | اختبارات قبول تفصيلية للاستيراد والتعديل والدفعة الجزئية |
| ZM-05 | occurrence_id/UUID، استيراد وقعة ثابتة، map_instance؛ restart union | completion/advanced؛ نهاية قديمة لا تقلب restart | إنشاء سلسلة اختيارية، واختبار قبول استيراد عدة وقائع |
| ZM-06 | canonical identity/finance + access grants + registrants | lifecycle؛ HTTP رفض role/asHost | تجربة إبطال رابط فعلي، تسجيل غير مؤكد يحتاج مراجعة |
| ZM-07 | intervals؛ نوافذ/استراحات؛ union؛ مطابقة/override مستقل | evidence/completion؛ 90/120 و70 دقيقة | مراجعة التاريخ بعد نقل الدفعة؛ تنبيه تداخل الطالب؛ تدقيق انتظار نهائي |
| ZM-08 | attendance_records + canonical weighted eligibility + certificate guards | completion؛ وزن 1h/3h؛ لا اختراع خروج | قبول إصدار الشهادة القديمة/الجديدة بكل مساراته؛ سياسة التعويض/نقص الساعات |
| ZM-09 | provider recordings Vault؛ نشر بشري؛ استحقاق حديث؛ opened_only | lifecycle/evidence | أصل المزود لا يلغى بنسخ الرابط؛ معالجة مشتقات النشر/النسخ الاحتياطية |
| ZM-10 | training_automation_jobs الحالية؛ مراجعة revision والمتلقي؛ work_core.tasks | lifecycle/advanced + رفض legacy fallback للمنشآت الجديدة في الكود | اختبار الرسائل الفعلية يحتاج إعدادًا وإذنًا؛ إعداد المالك والـcron |
| ZM-11 | داخل learner-operations؛ standalone training portal؛ ZoomLecture | UI desktop/mobile/learner + SQL | مراجعة تكامل الجزء القديم؛ تفاصيل متابعة الوقائع في الواجهة |
| ZM-12 | snapshot 50/93 يوم؛ reports + insights؛ CSV مع حماية الصيغ | advanced + HTTP تصدير مخوّل | تصدير كبير في خلفية؛ تفاصيل حضور موزونة/فلاتر إضافية |
| ZM-13 | HMAC durable inbox؛ refresh rotation؛ leases/fences؛ cooldown | provider/accounts/Postgres race/load | تجارب HTTP حية وزمن webhook الشبكي؛ قبول أعطال إضافي |
| ZM-14 | RLS لا قراءة مباشرة؛ composite FKs؛ ACL؛ Vault؛ audit | tenant/learner denial, signed raw body, no host URL | مراجعة شاملة نهائية للصلاحيات والتدقيق والخطط |
| ZM-15 | addon.integration.zoom مستقل؛ portal يعيد auth الموجود | accounts/lifecycle + UI learner | تفويض التفعيل الخارجي فقط؛ لا توسيع LMS pilot |
| ZM-16 | secure meeting defaults؛ alternative_host متحقق؛ polls حقيقية؛ breakout capability | advanced/provider | استكمال إعدادات متقدمة وغرف فرعية؛ اختبار التراخيص |
| ZM-17 | SDK 5.1.4؛ role token server-side؛ own identity/ZAK؛ fallback | provider SDK contracts | Zoom app review، اختبار صوت/فيديو/جوال حي مأذون T55 |
| ZM-18 | ندوات مرخصة؛ canonical CRM dedupe/owner/consent/campaign؛ evidence union | advanced؛ لا عميل/دفع/تسجيل أكاديمي مضاعف | رحلة تسجيل عامة وتسليم رابط إن اعتمد استخدامها؛ تجربة Zoom Webinar |
| ZM-19 | real Odeiry budget/generation/finalization؛ source-bound drafts؛ read-only analytics tool | advanced/provider + aggregate ACL | اختبار حي مأذون/ميزانية؛ تجربة apply مع محرر المسودات؛ حذف مشتقات منشورة |
| ZM-20 | pause/reconnect/uncertainty؛ cross-account replacement؛ tasks | accounts/advanced/lifecycle | حسم إلغاء قديم عند فقد الاستجابة؛ مراجعة تاريخ النقل |
| ZM-21 | RTL/responsive/keyboard؛ no-preview authorization | ui-http-sql.json + screenshots | إعادة الفحص بعد آخر التعديلات؛ ليست مراجعة وصول شاملة |
| ZM-22 | additive migrations؛ isolated CI، gate، disabled flags | branch CI + build/type/lint/regression checkpoints | دليل إعداد/تشغيل/حذف/تراجع كامل، مصفوفة T دقيقة، final SHA checks؛ إذن نشر منفصل |

## حدود الإثبات

- [حمل a1d47d2](evidence/load-a1d47d2.json): 3,000 منشأة اصطناعية، عاملان، p95 لقراءة الحسابات واستقبال الأحداث في DB، صفر أخطاء/اختلاط. لا يثبت 3,000 محاضرة متزامنة أو أداء Zoom والشبكة.
- [UI/HTTP/SQL](evidence/ui-http-sql.json): الهوية الاصطناعية عند حد المصادقة؛ تفويض SQL والمال والحجز والعامل حقيقي في قاعدة منفصلة؛ Zoom adapter اختباري.
- عناوين بعض اختبارات الوحدة تجمع عدة حالات T؛ لا يعني ذلك أن كل تفاصيلها اجتازت. تُحدّث مصفوفة T لكل سيناريو قبل التسليم.
- لا تستهدف migrations بيانات ريف. لم تُقرأ بياناتها التشغيلية ولم تُجرَ مقارنة تشغيلية تسمح بادعاء سلامة إنتاجها بعد نشر لم يحدث.
