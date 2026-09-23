# مصفوفة التنفيذ والتحقق ZM-01–ZM-22

مرجع النطاق [المواصفة كاملة](scope-ar-v1.md). أدلة كل T وحدودها في [مصفوفة القبول](acceptance.md). **لا ميزة مختبرة مع Zoom حيًا أو مفعلة إنتاجيًا. حدثت معاينة Vercel تلقائية غير مقصودة للفرع؛ لا تمثل قبولًا أو إذنًا. انظر [تصحيح النشر](release.md).** «عقد» يصف مزودًا اصطناعيًا عند حد الشبكة مع تشغيل التطبيق وSQL الحقيقيين في بيئة منفصلة.

الدليل الحالي على `faf3b1d`: [CI كامل و50اختبارZoom](evidence/review-faf3b1d.json). [تهيئة هوستينجر وحدود الوصول](hostinger.md). القبول الخارجي يبقى معلقًا حتى إعداد المزود والبيئة والتحقق المأذون.

| المتطلب | المنفذ والكود | المختبر | غير المكتمل/المعلق |
|---|---|---|---|
| ZM-01 | [SQL01][m01]، [OAuth/worker][edge]، [adapter][client]؛ حسابات مستقلة وadd/reconnect | accounts/provider، حسابان، state، ACL، إعادة تفويض | General OAuth حي، حسابات اختبار ومراجعة Marketplace إن لزمت |
| ZM-02 | SQL01، [bridges][m05]، [sync][m10]، [الفروع][m22]؛ سعة مثبتة/ربط مدرب/فترات عدم توفر | accounts/advanced/acceptance؛ ثلاثة مضيفين، فرع آخر مرفوض | مزامنة رخص حية؛ السعة عند غياب دليل تبقى واحدة |
| ZM-03 | [الحجز][m02] وm22؛ ترتيب عادل، أقفال وخانات وهوامش ومدرب وقاعة hybrid قائمة | scheduling/acceptance/PostgreSQL اتصالان، حد اثنين ورفض الثالث، busy | تعارض غير مرئي للمزود خارج الضمان؛ تعارض قاعة hybrid مختبر عبر الجدولة القائمة |
| ZM-04 | m02، [دورة الحياة][m06]، [الاستبدال][m11]؛ batch/import/update/cancel/replace | scheduling/advanced/acceptance/UI→API→SQL→worker | قبول سلسلة مستوردة مع مزود حي؛ حسم إلغاء قديم غامض يحتاج مراجعة مزود |
| ZM-05 | [التكرار][m15]، m03/m10؛ meeting_id/occurrence_id/UUID، restart | series/provider/completion؛ DST وatomic mapping | لا سلسلة بلا وقت ثابت؛ قبول استيراد حي وتسجيلات كل وقعة ينتظر Zoom |
| ZM-06 | [استحقاق][m03]، [استرداد تسجيل][m18]، [حالة بوابة][m21]، [واجهة المحاضرة][lecture] | lifecycle/recovery/acceptance/HTTP؛ سياسة المال ودور مضيف | أثر إبطال رابط Zoom سبق كشفه يحتاج تجربة مزود؛ لا ضمان منع مشاركة مطلق |
| ZM-07 | m03، [التاريخ][m14]، [المتابعة][m19]؛ union/window/breaks/quality/manualSeconds | evidence/completion/acceptance؛35+55،جهازان،ناقص،تداخل،تاريخ | انتظار المزود للتقرير النهائي ومراجعة بشرية عند الغموض |
| ZM-08 | [إكمال موزون][m12]، m03/m17/m19؛ السلطة الأكاديمية القائمة | certificates؛RPC قديم/جديد/direct guard وقرار بعد شهادة | سياسات نقص الساعات/التعويض المعتمدة؛ لا تغيير قانوني أو شهادة تلقائية |
| ZM-09 | [تسجيلات][m04]، [حذف][m07]، m10؛ Vault ونشر/سحب وopened_only | lifecycle/advanced؛تنظيف محلي واستحقاق حديث | أصل Zoom وحدود الإبطال، مساحة/ملفات حية، سياسة backup والمشتقات المختلطة؛ [النسخ المعروفة والاستعادة المحلية](retention-implementation.md) منفذة |
| ZM-10 | m06، [رسائل ندوة][m17]، عامل الرسائل الحالي + zoom-message | lifecycle/acceptance/advanced؛version/recipient/consent/queue | قنوات وcron وإذن إرسال؛ قبول المزود ليس إثبات تسليم |
| ZM-11 | [workspace][ui] داخل learner-operations، lecture وtraining portal | UI/HTTP/SQL ومتدرب بلا LMS | SDK وسائط حية؛ قارئ شاشة شامل غير مختبر |
| ZM-12 | m04، [insights][m13]، [exports][m16]، m22؛فلاتر ومقارنة ودرجات وتكلفة معلومة المصدر | reports/acceptance/HTTP؛205صف/3chunks/TTL/سحب صلاحية | رأي الطلاب في المدرب لا مصدر قائم متحقق له؛ تكلفة Zoom/ROI غير متاحة دون مصدر |
| ZM-13 | m01/m02/m03/m07/m10/[drift][m20]/m21؛HMAC/leases/cooldown/sweep | provider/concurrency/recovery/acceptance/load | تأخيرات HTTP/أعطال فعلية واختبار rate limits حي يحتاج إذنًا |
| ZM-14 | ACL حقيقي داخل المنشأة، composite FKs، no direct grants، Vault/audit | SQL/HTTPعزل، platform-only denial، JWTrole tampering | مراجعة بنية تشفير/كاش/backup الفعلية وقت إعداد بيئة الإصدار |
| ZM-15 | addon.integration.zoom مستقل، canonical login/invitations، authoring gate | accounts/lifecycle/advanced/UI + regression | لا إذن بتوسيع LMS pilot أو تفعيل إنتاجي |
| ZM-16 | meetingOptions آمنة، binding بديل، polls حقيقية؛ الغرف من عميل Zoom عند دعمها | provider/advanced وواجهة إعداد فعلية | اختبار قدرات ورخص حية؛ Q&A/poll results ليست درجات معتمدة تلقائيًا |
| ZM-17 | [SDK browser][sdk] وedge؛قرار مراجعة/هوية ودور وتوقيع وفallback | provider عقد role/signature؛بدون anonymous external مضمون | T55 صوت/فيديو/مشاركة/جوال وموافقة التطبيق؛ لا تجربة حية |
| ZM-18 | [CRM webinar][m09] وm17؛عميل/مصدر/حملة/موافقة/إسناد/رابط شخصي | advanced؛dedupe، restart union، لا مال/طالب جديد | رخصة Webinar واختبار تسجيل وتسليم وحضور حي |
| ZM-19 | [Odeiry source drafts][m08] وm10/m13؛ميزانية فعلية وhuman apply وقراءة تحليلية | advanced/provider؛apply بمحرر المسودة مع gates مستقلة | مزود AI حي وميزانية وموافقة بيانات؛ حذف النسخ المعروفة وإعادة التطبيق وحجز الحجم في SQL23/24؛ المختلط يحتاج سياسة |
| ZM-20 | pause/disconnect/reauth/recovery/replace/followup | accounts/lifecycle/advanced/recovery/acceptance | حسم الحالات الغامضة لدى المزود والتشغيل الفعلي للمتابعة |
| ZM-21 | RTL/components/CSS الحالية،360/390/768،intro قابل للتخطي | UI/screenshots/HTTP/keyboard | فحص وصول شامل وقارئ شاشة وSDK media حي |
| ZM-22 |22ترحيلًا إضافيًا، CI مع PG17، docs/runbooks/matrices، rollout مغلق | lint/types/migrations/build/regression checkpoints، UI،load | بوابة التسليم الأخيرة، بيئة مطابقة كاملة/تجربة مزود،سياسة حذف،وجهة نشر وإذن منفصل |

## أدلة وحدودها

- [حمل a1d47d2](evidence/load-a1d47d2.json): 3000 منشأة صناعية، عاملان، p95 قراءات/إقرار DB، صفر أخطاء وعزل. ليس 3000 محاضرة متزامنة ولا قياس شبكة Zoom.
- [UI/HTTP/SQL](evidence/ui-http-sql.json): JWT/provider seams اصطناعية؛ التفويض/المال/الحجز/التصدير تنفذ SQL الفعلية. agent-browser daemon تعذر؛ Chromium/Playwright استُخدم وفُحصت الصور.
- SQL fixture يتضمن المخطط والدوال المرجعية اللازمة والـmigrations الجديدة، مع Vault/addon transport seams معلنة. لا تعادل هذه الأدلة إعادة تطبيق كل مخطط Supabase وتشفيره وCDN وscheduler على بيئة نشر حقيقية.
- الاختبارات استخدمت بيانات اصطناعية؛ لم ننفذ قراءة أو تعديلًا لبيانات ريف التشغيلية. وجهة بيانات معاينة Vercel التلقائية لم يمكن التحقق منها، ولا يثبت الانحدار الاصطناعي سلامتها أو سلامة الإنتاج.

[m01]: ../../supabase/migrations/20260922201432_zoom_accounts_resources_v1.sql
[m02]: ../../supabase/migrations/20260922202109_zoom_scheduling_operations_v1.sql
[m03]: ../../supabase/migrations/20260922202705_zoom_evidence_access_v1.sql
[m04]: ../../supabase/migrations/20260922203333_zoom_recordings_reports_v1.sql
[m05]: ../../supabase/migrations/20260922203937_zoom_provider_bridges_v1.sql
[m06]: ../../supabase/migrations/20260922205518_zoom_lifecycle_communications_v1.sql
[m07]: ../../supabase/migrations/20260922210150_zoom_recovery_retention_v1.sql
[m08]: ../../supabase/migrations/20260922210714_zoom_advanced_learning_v1.sql
[m09]: ../../supabase/migrations/20260922211521_zoom_webinar_crm_v1.sql
[m10]: ../../supabase/migrations/20260922213755_zoom_operational_completion_v1.sql
[m11]: ../../supabase/migrations/20260922215415_zoom_account_replacement_v1.sql
[m12]: ../../supabase/migrations/20260922221302_zoom_weighted_completion_v1.sql
[m13]: ../../supabase/migrations/20260922222039_zoom_insights_followup_v1.sql
[m14]: ../../supabase/migrations/20260922223516_zoom_historical_attendance_v1.sql
[m15]: ../../supabase/migrations/20260922224409_zoom_recurring_series_v1.sql
[m16]: ../../supabase/migrations/20260922225126_zoom_report_exports_v1.sql
[m17]: ../../supabase/migrations/20260922230226_zoom_webinar_delivery_review_v1.sql
[m18]: ../../supabase/migrations/20260922230604_zoom_registration_recovery_v1.sql
[m19]: ../../supabase/migrations/20260922231251_zoom_evidence_followup_v1.sql
[m20]: ../../supabase/migrations/20260922231639_zoom_external_schedule_observation_v1.sql
[m21]: ../../supabase/migrations/20260922232631_zoom_portal_and_drift_sweep_v1.sql
[m22]: ../../supabase/migrations/20260922233842_zoom_branch_reporting_v1.sql
[edge]: ../../supabase/functions/zoom-connect/handler.mjs
[client]: ../../supabase/functions/_shared/zoom-client.mjs
[ui]: ../../components/zoom-workspace.jsx
[lecture]: ../../components/zoom-lecture.jsx
[sdk]: ../../lib/zoom-sdk-browser.mjs

استكمال SQL23/24 وT56/57/62 وروابط الكود والأدلة وحدود الاستعادة في [المصفوفة التفصيلية](retention-implementation.md).
