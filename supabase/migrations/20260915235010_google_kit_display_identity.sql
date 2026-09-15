-- Display-only rename: preserve product/feature IDs, billing, licenses, routes and rollouts.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

update catalog.features
set name_ar='Google Kit',name_en='Google Kit'
where feature_key='addon.integrations.google_ads_connect';

update catalog.addon_products
set name_ar='Google Kit',name_en='Google Kit',
 description_ar='إعلانات جوجل وGA4 في إضافة واحدة، مع مطابقة الطلبات بالتسجيلات والتحصيل الفعلي داخل أودير.'
where product_key='google_ads_connect';

update catalog.addon_manifests m
set short_description_ar='Google Kit: إعلانات جوجل وGA4 ومطابقة الطلبات والتحصيل.',
 long_description_ar='قراءة الحملات والإنفاق، وربط GA4 اختياريًا بالمتجر، ومطابقة الطلبات بالمدفوعات والاستردادات المعتمدة في أودير دون تعديلها. تظل مطابقة مصادر العملاء اليدوية منفصلة.'
from catalog.addon_products p
where m.product_id=p.id and p.product_key='google_ads_connect';

update catalog.addon_surfaces s
set title_ar='Google Kit',
 description_ar='تقارير إعلانات جوجل وGA4 ومطابقة الطلبات والتحصيل داخل أودير.'
from catalog.addon_manifests m join catalog.addon_products p on p.id=m.product_id
where s.manifest_id=m.id and p.product_key='google_ads_connect' and s.surface_key='tenant.google_ads';

commit;
