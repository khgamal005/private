# دليل تشغيل Paymob لمتجر ODEIR

هذا الدليل هو عقد التشغيل والقبول لربط Paymob في متجر الخدمات والإضافات. يدعم
مسارين محكومين في إقليم KSA: **Intention + Unified Checkout** للتوافق الحالي،
و**QuickLink** لإظهار البطاقات/مدى وApple Pay كخيارات مستقلة. لا يستخدم سلسلة
`order / payment key / iframe` القديمة.

> الحالة: تجهيز واختبار فقط. لا يتضمن هذا المستند نشرًا، أو تفعيلًا على الإنتاج،
> أو أي مفاتيح فعلية. يظل Paymob مخفيًا عن العملاء حتى اكتمال أدلة الجاهزية
> واعتماد شخصين مختلفين.

المراجع الرسمية:

- [مسار الربط عبر APIs](https://developers.paymob.com/paymob-docs/integration-paths/apis)
- [إنشاء Intention](https://developers.paymob.com/paymob-docs/intention-apis/create-intention)
- [التحويل إلى Unified Checkout](https://developers.paymob.com/paymob-docs/developers/checkout-experiences/unified-checkout-redirection)
- [إصدار Auth Token](https://developers.paymob.com/paymob-docs/developers/authentication-request-generate-auth-token-1)
- [إنشاء QuickLink](https://developers.paymob.com/paymob-docs/developers/quicklink-apis/create-quicklink)
- [Transaction callbacks](https://developers.paymob.com/paymob-docs/manage-callback/transaction-callbacks)
- [التحقق من HMAC](https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback)
- [الاستعلام بمعرف العملية](https://developers.paymob.com/paymob-docs/developers/transaction-inquiry-apis/by-transaction-id)
- [الاستعلام بالطلب أو المرجع](https://developers.paymob.com/paymob-docs/developers/transaction-inquiry-apis/transaction-inquiry/by-order-id-or-reference)
- [Refund](https://developers.paymob.com/paymob-docs/developers/manage-payment-apis/refund)
- [Void](https://developers.paymob.com/paymob-docs/developers/manage-payment-apis/void)

## 1. ملكية الإعدادات والأسرار

| القيمة | مكان الحفظ | الاستخدام | مسموحة للمتصفح؟ |
|---|---|---|---|
| `secretKey` | Supabase Vault، نسخة مستقلة لكل بيئة | `Authorization: Token …` عند إنشاء Intention. لا تستخدمه هذه النسخة لبدء Refund/Void | لا |
| `apiKey` | Supabase Vault، نسخة مستقلة لكل بيئة | إصدار Auth Token لإنشاء QuickLink وللاستعلام والمطابقة | لا |
| `hmacSecret` | Supabase Vault، نسخة مستقلة لكل بيئة | التحقق من callback بتوقيع SHA-512 | لا |
| `publicKey` | Supabase Vault ضمن نسخة الاعتماد الكاملة | فتح Unified Checkout | نعم، داخل رابط Checkout الصادر لهذه المحاولة فقط |
| `integrationPath` | إعداد عام: `intention` أو `quicklink` | اختيار مسار Checkout الخادمي | لا |
| `integrationId` | إعداد عام، عدد صحيح | بطاقة/مدى الأساسية في `payment_methods` وربط callback | لا حاجة لعرضه |
| `applePayIntegrationId` | إعداد عام اختياري مع QuickLink | إظهار Apple Pay وربط callback الخاص به | لا حاجة لعرضه |
| `merchantAccountId` | إعداد عام، عدد صحيح | مطابقة `owner` ومنع الربط بحساب آخر | لا حاجة لعرضه |
| `region` | إعداد ثابت بقيمة `ksa` | تثبيت المضيف ومنع اختيار URL من الطلب | لا |

ينشئ النظام أيضًا مفتاح HMAC داخليًا وعشوائيًا لكل نسخة اعتماد داخل Vault
لبصمة بيانات الفوترة المنقحة. لا يأتي هذا المفتاح من Paymob، ولا يدخل حزمة
المزود ذات المفاتيح الأربعة، ولا يعاد من أي RPC، ولا يعاد استخدام `hmacSecret`
الخاص بتوقيع callback لهذا الغرض.

- لا تحفظ الأسرار أو رابط Checkout الكامل في logs أو snapshots أو exports أو
  support bundles. يحفظ `client_secret` مؤقتًا في Vault فقط، ويكون غير قابل
  للاسترجاع بعد انتهاء المحاولة أو وصولها إلى حالة نهائية.
- لا تعاد قيمة سر بعد حفظها؛ تعرض الواجهة فقط حالة الضبط، والبصمة غير القابلة
  للعكس، ووقت التدوير، ومن نفّذ التغيير.
- يجب تطابق بيئة config وبيئة credentials. الانتقال من Sandbox إلى Live يتطلب
  مجموعة أسرار وربط merchant/integration كاملة للبيئة الجديدة.
- المضيفون والمسارات ثابتة في الخادم: إنشاء Intention عبر
  `https://ksa.paymob.com/v1/intention/`، وUnified Checkout عبر
  `https://ksa.checkout.paymob.com/`، وإنشاء QuickLink عبر
  `https://ksa.paymob.com/api/ecommerce/payment-links`. لا يقبل النظام host أو
  callback URL أو Integration ID من المتصفح.

### اختيار الأرقام التي يرسلها دعم Paymob

| المسار في أودير | Integration ID الأساسي | Apple Pay الاختياري |
|---|---|---|
| `QuickLink` (الموصى به لخيارات دفع ظاهرة) | الرقم المسمى `PL` | الرقم المسمى `Apay PL` |
| `Intention / Unified Checkout` | الرقم المسمى `Web` | غير مستخدم كخيار مستقل في هذا الإصدار |

لا تُدخل رقم `Web` في حقل QuickLink ولا رقم `PL` في Intention. راجع أن الأرقام
تخص نفس حساب Paymob ونفس البيئة (Test أو Live) قبل الحفظ. لا تُكتب هذه الأرقام
في الكود؛ تحفظ كإعدادات نسخة اعتماد، وتغييرها يعيد الجاهزية إلى المراجعة ويُمنع
إذا كانت هناك محاولة دفع مفتوحة.

### إعداد Callback للـQuickLink

لكل Integration مستخدم في QuickLink (`PL` و`Apay PL`) اضبط من لوحة Paymob:

- `Integration Processed Callback URL`: عنوان Webhook الظاهر في إعداد التشغيل؛
  ويظل `notification_url` المرسل عند إنشاء الرابط هو المرجع المتوقع نفسه.
- `Integration Response Callback URL`:
  `https://odeir.com/api/payments/paymob/return` من دون أي query parameters.

يعيد Paymob المتصفح إلى العنوان الثابت ويضيف `order_id`. تستخدمه ODEIR كدليل
بحث فقط داخل RPC للقراءة بصلاحية جلسة المستخدم والمنشأة، ثم تحذف كل حقول Paymob
من العنوان قبل عرض صفحة الحالة. لا تعتمد صفحة الرجوع نجاح الدفع مطلقًا. كما
يتحقق خادم الإنشاء أن `redirection_url` الذي أعاده QuickLink يساوي هذا العنوان
بالضبط؛ لذلك يؤدي نسيان إعداد Callback أو ضبطه على نطاق آخر إلى إيقاف Checkout
بأمان بدل إرسال العميل إلى وجهة غير محكومة.

## 2. رحلة العميل ومصدر الحقيقة

1. ينشئ الخادم الطلب idempotently ويحسب السعر والضريبة و`SAR` بوحدات الهللة؛
   لا يقبل المبلغ من المتصفح. الخدمة ذات سعر «يبدأ من» لا تنتقل للدفع قبل تثبيت
   عرض سعر نهائي.
2. يختار العميل اسم الوسيلة فقط (`card` أو `apple_pay`)؛ يختار الخادم Integration
   ID المقابل ويثبته داخل محاولة دفع غير قابلة للتغيير مع tenant/order/item/
   amount/currency/term/environment. لا يصل المعرّف إلى المتصفح.
3. في مسار Intention يرسل الخادم Intention واحدة بالعناصر وبيانات الفوترة و
   `notification_url` و`redirection_url`. وفي QuickLink يصدر Auth Token ثم ينشئ
   رابطًا واحدًا بـ`reference_id` يساوي UUID المحاولة و`payment_methods` المحدد
   خادميًا. قيمة `items[].amount` في Intention هي إجمالي السطر ولا تضرب في
   `quantity` مرة أخرى.
4. يتحقق الخادم من المبلغ والعملة والمرجع والبيئة وعنواني callback وانتهاء الصلاحية
   في رد Paymob، ثم يحفظ الربط والرابط المؤقت في Vault قبل إعادته. النقر المكرر
   أو إعادة التحميل يستأنفان نفس المحاولة؛ وبعد نتيجة شبكة غامضة لا يحدث إنشاء
   أعمى ثانٍ قبل inquiry.
5. **مصدر الحقيقة المالي هو POST callback الموقّع أو Transaction Inquiry
   موثّق من Paymob.** صفحة الرجوع GET للعرض والاستعلام عن حالة المحاولة فقط،
   ولا تسدد طلبًا ولا تفعل إضافة.
6. بعد callback ناجح ونهائي ومطابق، يحدّث التطبيق الطلب مرة واحدة داخل معاملة
   قاعدة بيانات: شراء الإضافة يضيف مصدر استحقاق `paid_order`، أما شراء الخدمة
   فيحدّث حالة طلب الخدمة فقط ولا يمنح أي صلاحية إضافة.

نصوص الحالة المقترحة للعميل:

- قبل callback: «تم استلام محاولة الدفع وننتظر تأكيد Paymob.»
- بعد النجاح: «تم تأكيد الدفع بنجاح.»
- عند عدم التطابق/الغموض: «تعذر تأكيد الدفع تلقائيًا. لن نكرر الخصم، وسنراجع
  العملية.»
- عند فشل نهائي: «لم يكتمل الدفع. يمكنك المحاولة مجددًا بمحاولة جديدة.»

## 3. ضوابط Webhook

- يقرأ endpoint Paymob الأصلي فقط؛ لا يمرره عبر webhook الداخلي العام ولا يقبل
  `provider` أو `signature_verified` من body.
- يعاد بناء HMAC بالترتيب والقواعد المنشورة لحقول Transaction Processed، ثم
  يقارن SHA-512 مقارنة timing-safe. تستخدم حقول PAN اللازمة مؤقتًا للحساب فقط
  ولا تسجل أو تحفظ.
- بعد صحة التوقيع، يجب تطابق environment و`integration_id` و`owner` ومعرف طلب
  Paymob/المعاملة والمبلغ والعملة مع المحاولة المحفوظة.
- `special_reference` فحص إضافي فقط؛ لا يستخدم للبحث عن محاولة من callback لأنه
  ليس ضمن حقول HMAC المنشورة. تعالج محاولة إنشاء Intention الغامضة بواسطة
  Transaction Inquiry موثّق باستخدام `merchant_order_id`.
- النجاح القابل للتطبيق هو دفعة ناجحة، غير pending، بلا error، وغير voided أو
  refunded أو auth-only أو capture-child، وتكون standalone بلا parent. الحالات
  الأخرى لا تفعل اشتراكًا.
- قد تفشل معاملة أولى ثم تنجح معاملة أخرى داخل Intention نفسها. لذلك لا يغلق
  فشل معاملة واحدة المحاولة قبل انتهاء نافذتها؛ تُسجل المعاملة المرصودة وتبقى
  المطابقة مرتبطة بمعرف Intention حتى نجاح نهائي أو إغلاق موثّق بعد المهلة.
- يسجل receipt مُنقحًا مع payload hash ومفتاح حدث دلالي فريد. تكرار callback
  يعيد 2xx بلا event أو entitlement إضافي. نجاح ثانٍ مختلف للطلب نفسه يُحجر
  للمراجعة ولا يمنح استحقاقًا ثانيًا.
- فشل التوقيع يعيد 400/401؛ العطل المؤقت في قاعدة البيانات أو التحقق يعيد 503؛
  duplicate/ignored/applied يعيد ردًا 2xx مختصرًا بلا بيانات طلب أو tenant.
- لا يطبق حد الخمس دقائق الخاص بالـwebhook الداخلي؛ replay يمنع بالتوقيع
  والمفاتيح الفريدة وحالة receipt.
- يجب تعطيل تسجيل query string أو تنقيحه قبل الحفظ في كل طبقات
  CDN/WAF/Vercel/Supabase لكل من webhook الذي يحمل `?hmac=` وصفحة الهبوط
  الأولى لرجوع Paymob. تحويل التطبيق 303 إلى رابط نظيف يمنع انتشار الحقول إلى
  الصفحة وReferer اللاحق فقط؛ ولا يمنع طبقة edge السابقة للتطبيق من رؤية الطلب
  الأول. يمنع Live حتى يوجد دليل تحقق موثق من إعدادات logs الفعلية.

## 4. مصفوفة قبول Sandbox

يبدأ Bootstrap بحفظ حزمة Sandbox مكتملة؛ يشتق النظام منها دليل `credentials`
ولا يعدها دليل دفع. يعتمد شخصان مختلفان انتقال المزود إلى `sandbox` ثم تمكين
tenant canary واحد فقط. تنفذ المصفوفة التالية على ذلك الـtenant، وتُربط النتائج
الفعلية بالمحاولة وreceipt ونتيجة inquiry. لا يمكن طلب الانتقال إلى Live قبل
اكتمال cohort واحد متماسك من نفس نسخة اعتماد Sandbox؛ لا تجمع أدلة من إصدارات
مفاتيح مختلفة.

| الاختبار | النتيجة الإلزامية |
|---|---|
| دفع إضافة ناجح | طلب paid مرة واحدة، receipt applied، ومصدر استحقاق واحد |
| دفع خدمة ناجح | طلب الخدمة paid/confirmed فقط، بلا entitlement لإضافة |
| بطاقة/مدى عبر QuickLink | يستخدم Integration `PL` المثبت للمحاولة ويظهر callback مطابقًا |
| Apple Pay عبر QuickLink | لا يظهر إلا عند ضبط `Apay PL` ويستخدم معرّفه المثبت للمحاولة |
| تغيير خيار الدفع بنفس idempotency key | يرفض التعارض ولا ينشئ رابطًا أو محاولة ثانية |
| الرجوع قبل وصول callback | تظهر pending ثم تتحدث بعد callback؛ الرجوع لا يغير المال |
| callback مكرر أو متزامن | 2xx، بلا تكرار event أو مدة الاشتراك أو notification |
| HMAC تالف | 400/401، بلا تعديل مالي، مع alert مُنقح |
| اختلاف amount/currency/order/integration/owner | receipt quarantined، بلا تفعيل، وتنبيه فوري |
| pending/auth-only/failed/error/void/refunded | لا تفعيل، والحالة الصحيحة ظاهرة للعميل/المشغل |
| timeout غامض أثناء إنشاء Intention | الحالة unknown، لا retry أعمى؛ inquiry يحسم نفس المحاولة |
| توقف العامل قبل استدعاء Paymob | المحاولة prepared المنتهية تُغلق failed دون استعلام أو انتظار عودة العميل |
| توقف العامل بعد حجز إنشاء Intention | المحاولة creating_intention المنتهية تتحول unknown وتدخل inquiry بالـmerchant_order_id دون إعادة دفع |
| إغلاق العميل أو انتهاء الصلاحية | الطلب يبقى غير مدفوع ويمكن بدء محاولة جديدة بعد الحسم |
| نجاحان مختلفان للطلب نفسه | الثاني quarantined، بلا استحقاق إضافي، وتنبيه حرج |
| دفع طلبين متزامنين لنفس الإضافة | تُسلسل مدة الاشتراك لكل tenant/product ولا تضيع مدة أو لقطة عكس أي طلب |
| Refund كامل لإضافة | إلغاء مصدر `paid_order` وحده مع بقاء بيانات tenant وباقي المنح |
| Refund جزئي | `partially_refunded` ومراجعة بشرية؛ لا تعطيل تلقائي للإضافة |
| فشل notification غير المالي | الدفع يبقى صحيحًا ويسجل outbox لإعادة الإرسال |
| تنقيح query في البنية التحتية | لا يظهر HMAC أو حقول رجوع Paymob في CDN/WAF/Vercel/Supabase access logs |
| فشل معاملة ثم نجاح أخرى لنفس Intention | تبقى المحاولة واحدة، وتطبّق الدفعة الناجحة مرة واحدة بلا Intention ثانية |

يشمل سجل الاختبار: المتصفح→Checkout→callback→قاعدة البيانات→حالة الواجهة، مع
إثبات عدم ظهور Authorization/HMAC/PAN/هاتف/بريد أو رابط Checkout الكامل في
السجلات.

## 5. المطابقة والاسترداد والإلغاء

- تنفذ دورة reconciler صيانة محدودة للمحاولات قبل التقاط jobs: تغلق `prepared`
  المنتهية التي لم تبدأ استدعاء المزود، وتحول `creating_intention` الغامضة إلى
  `unknown` مع inquiry بالمرجع. ثم تفحص `unknown/pending` المتأخرة وcallbacks
  المفقودة وعمليات refund غير النهائية، باستخدام inquiry الرسمي بالمرجع أو
  معرف الطلب. تمر النتيجة عبر receipt/applicator نفسها؛ لا يوجد مسار إداري
  يضع `paid=true` مباشرة.
- إذا أُوقف المزود أو سُحب الاعتماد أو أُغلق rollout بعد استدعاء Create
  Intention وقبل تسجيل نتيجته، تعيد خطوة التسجيل فحص كل البوابات تحت الأقفال.
  تحفظ المحاولة `unknown` بلا Client Secret أو رابط استئناف، وتدخل inquiry
  بالمرجع نفسه؛ لا يُعرض Checkout ولا يُعاد استدعاء Create تلقائيًا.
- تسوية إضافة أو عكسها تأخذ قفلًا حتميًا مشتركًا لكل
  `(tenant_id, addon_product_id)` بعد قفل الطلب وقبل قراءة الاشتراك، وبترتيب
  ثابت عند تعدد المنتجات. يمنع ذلك فقد مدة تجديد أو بناء لقطة عكس قديمة عند
  دفع أو استرداد طلبات متزامنة.
- لا تمسك التسوية صف المنتج أو الموديول الأب أثناء `INSERT` في الصف الابن.
  عند غياب الاشتراك/الموديول تستخدم `ON CONFLICT DO NOTHING`؛ وإذا سبقها كاتب
  منصة متزامن تتحول للمراجعة بلا overwrite. وعند وجود الصف تقفله وتكتب فقط
  بشرط تطابق اللقطة السابقة كاملة، فتتجنب أيضًا دورة deadlock مع فحص الـFK.
- الإعداد التشغيلي المبدئي: يشغّل العامل كل دقيقة، ولا يلتقط إلا jobs المستحقة
  وفق مهلة وتأخير متدرج محدود في قاعدة البيانات، ثم يحولها لمراجعة بشرية بدل
  retry غير محدود. تراجع المجاميع المالية يوميًا مقابل Paymob.
- تبقى المحاولة مرتبطة بنسخة الاعتماد التي أنشأتها لأغراض التوقيع والتدقيق، لكن
  inquiry يستخدم `apiKey` من النسخة النشطة الحالية لنفس environment و
  Integration ID وmerchant owner. يسجل job معرّفي نسخة الإنشاء ونسخة الاستعلام
  منفصلين، وينفذ استعلام مزود واحدًا فقط في كل claim.
- هذه النسخة لا ترسل Refund/Void من التطبيق. ينفذ الطلب من لوحة Paymob بواسطة
  مشغل مخول بعد مراجعة مستقلة، ثم يثبت التطبيق النتيجة فقط عبر callback/inquiry.
  إضافة استدعاء API لاحقًا تتطلب سببًا، مبلغًا بوحدات صغرى، معرف المعاملة،
  idempotency محليًا، وworkflow maker/checker ذريًا قبل أي mutation لدى المزود.
- حقل `amount_cents` الموقّع في callback هو مبلغ المعاملة الأصلية، ولا يثبت مبلغ
  الاسترداد التراكمي؛ لذلك لا يُعامل `is_refunded=true` كإثبات Refund كامل. يلزم
  Transaction Inquiry موثوق قبل عكس حالة الطلب أو مصدر الاستحقاق.
- `Void` مسموح فقط لعملية authorized غير captured. Refund لا يتجاوز الرصيد
  القابل للاسترداد. الاسترداد الجزئي لخدمة أو إضافة ينتقل للمراجعة البشرية.
- إذا أظهر inquiry أن للطلب مبلغًا مدفوعًا موجبًا بينما آخر child transaction
  فاشل أو غير نهائي، يوضع الطلب كله في review hold؛ لا تُنشأ محاولة جديدة ولا
  يطبق الاستحقاق تلقائيًا حتى تطابق Billing العملية الصحيحة. لا تُثبّت هوية
  transaction غير نهائية كممثل دائم للدفعة.
- قبل أي تفعيل حي يجب توثيق مراجعين مختلفين لتمرين Refund في Paymob وربط دليله
  بنتيجة inquiry. لا تدّعي هذه النسخة أن فصل maker/checker للاسترداد منفذ داخل
  التطبيق؛ ولذلك تبقى بوابة Live محجوبة حتى يسجل هذا الدليل التشغيلي.
- لا يحذف refund/void بيانات العميل أو CRM أو integrations أو audit history.
  الاسترداد الكامل لإضافة يسحب مصدر الدفع الخاص بهذا الطلب فقط؛ تبقى منحة plan
  أو trial أو platform grant فعالة إن وجدت.

## 6. المراقبة والتنبيهات

تنبه Billing/SRE فورًا عند: فشل HMAC المتكرر، receipt محجور، callback ناجح بلا
محاولة، نجاح ثانٍ لطلب واحد، اختلاف merchant/integration/amount/currency، محاولة
unknown تجاوزت مهلة المطابقة، backlog callbacks، أو refund عالق. تراقب أيضًا
معدل نجاح Checkout وزمن callback→applied ونسبة pending/failed لكل integration.

التنبيه يحتوي على IDs داخلية وreason code فقط، ولا يحتوي payload خامًا أو أسرارًا
أو PAN أو بيانات فاتورة. يجب أن يكون لكل تنبيه owner وSLA ومسار تصعيد، مع ربطه
بسجل audit غير قابل للتعديل.

يجب وضع endpoint العام للـWebhook خلف WAF وحد طلبات قبل تفعيل Live؛ التحقق
البنيوي وHMAC داخل الوظيفة لا يغنيان عن حماية الاستنزاف من طلبات عامة متكررة.

## 7. Canary والعزل عن Reef Skills

- يبدأ الاختبار في Sandbox على tenant داخلي جديد ومخصص للدفع، بمنتج إضافة
  وخدمة اختباريين، وبمستخدمين لا يملكون وصولًا لبيانات عملاء.
- **لا تستخدم Reef Skills كـcanary، ولا تعدل طلباتها أو اشتراكاتها أو إعداداتها.**
  يمنع allowlist التشغيل أي tenant إنتاجي قبل اعتماد الاختبارات.
- اختبار Live منخفض القيمة، إن اعتمد لاحقًا، يتم على tenant canary مستقل وبمبلغ
  يسمح به Paymob، ثم refund موثق. لا يعاد استخدام طلب أو attempt من Sandbox.
- تبقى receipts والأحداث وسجل الموافقات لأغراض التدقيق؛ يعطل المنتج الاختباري
  بعد القبول بدل حذف السجل.

## 8. بوابة Go-live ومراجعة مستقلة

حفظ الأسرار لا يعتمد انتقال البيئة ولا يظهر Paymob. يعتمد reviewer مستقل الحزمة
التالية قبل إجراء الانتقال الإداري المنفصل:

- Vault refs موجودة لكل secrets ولا توجد قيمة صريحة في DB/client/logs.
- `region=ksa` وبيئة credentials وpublic key وIntegration/Merchant IDs متطابقة.
- callback HTTPS عام ومسجل في Paymob، وfixture HMAC الرسمي والاختبارات السلبية
  ناجحة، مع WAF وحد طلبات مفعلين أمامه.
- Integration ID الحي هو Card Integration يدعم `notification_url` وفق إعداد
  لوحة Paymob، ودليل الإعداد مربوط بنسخة الاعتماد والـmerchant/integration
  الحاليين واعتمده شخصان مختلفان.
- مصفوفة Sandbox كاملة وموقعة، وتشمل الإضافة والخدمة والتكرار والtimeout وrefund.
- inquiry/reconciliation وoutbox والتنبيهات تعمل، وrunbook التصعيد وأسماء owners
  محددة. تشمل الأدلة جدولة reconciler الفعلية، وعامل outbox فعليًا مع
  claim/lease/ack وتسليم اختباري؛ وجود صف queue وحده لا يكفي.
- اختبار canary معزول عن Reef Skills، وفحص RLS/tenancy وعدم تسرب بيانات ناجح.
- مراجعة logs وsupport/export تثبت redaction، ومراجعة صلاحيات admin تثبت أقل
  امتياز. يشمل الدليل صراحة query string للـWebhook وصفحة هبوط الرجوع في جميع
  طبقات CDN/WAF/Vercel/Supabase، لا سجلات التطبيق وحدها.
- تجربة rollback موثقة، وموافقة Billing وSecurity ومالك المنتج مسجلة.

الأدلة التشغيلية الستة التي لا يمكن اشتقاقها من ledger هي:
`refund_initiation` و`live_credentials` و`live_card_integration_callback` و
`edge_query_redaction_waf` و`reconciler_schedule` و`outbox_delivery`. يسجل
المشغل بصمة SHA-256 فقط، ويعتمدها مراجع مختلف بعبارة تأكيد مرتبطة بمعرف الطلب؛
لا يرفع النظام artifact خامًا. صلاحية `live_credentials` هي 24 ساعة، وبقية
الأدلة 30 يومًا، وتُعاد الجاهزية في كل Checkout بدل الاعتماد على snapshot قديم.

يظل Live محجوبًا في هذه النسخة حتى يوجد عامل outbox مجدول ومختبر، وجدولة فعلية
للـreconciler، وتنقيح query strings في طبقات البنية، وCard Integration حي مضبوط
لـcallback، وتمرين Refund من لوحة Paymob متبوعًا بـinquiry موثق. وجود الكود أو
صف queue أو توقيع ذاتي لا يحقق أيًا من هذه الأدلة.

بعد ذلك فقط ينتقل `rollout_mode` تدريجيًا من `observe_only` إلى `sandbox` ثم
`live`، مع allowlist منفصلة لكل بيئة ومنشأة. نجاح API ping وحده لا يعني «متصل»
ولا يظهر وسيلة الدفع للعملاء.

## 9. الإيقاف والرجوع الآمن

عند حادث أو فشل بوابة القبول:

1. غيّر المزود إلى `disabled/degraded` وأخف Paymob عن checkout الجديد، مع إبقاء
   التحويل البنكي المتاح كبديل.
2. لا تحذف config أو Vault refs أو attempts أو receipts، ولا تتراجع عن migrations
   الإضافية. أبقِ webhook والمطابقة قيد التشغيل لتسوية الدفعات التي بدأت بالفعل.
3. اجعل صفحة الرجوع والاستعلام متاحة للعميل، وأوقف retries لإنشاء Intention عند
   الاشتباه في خصم مزدوج.
4. عند التدوير العادي، تحفظ نسخة الاعتماد الكاملة الجديدة وتبقى النسخة السابقة
   `retiring` لمدة سبعة أيام لمعالجة callbacks والمطابقة المفتوحة. عند تسرب سر،
   عطل القبول واستخدم emergency revoke ولا تنتظر فترة التداخل، ثم طابق كل
   المحاولات المتأثرة قبل الاستعادة.
5. لا تعد التفعيل حتى إغلاق incident، ومطابقة كل المحاولات المفتوحة، وتكرار
   اختبارات HMAC/duplicate/happy path، وتوثيق موافقة الاستعادة.
