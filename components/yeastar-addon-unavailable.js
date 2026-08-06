import Link from 'next/link';

export default function YeastarAddonUnavailable({
  slug,
  canManage=false
}){
  return <section className="mt-panel">
    <div className="mt-empty">
      <b>إضافة Yeastar غير مفعّلة لهذه المنشأة</b>
      <p>
        تقارير المكالمات وإعدادات السنترال وحدة مدفوعة مستقلة،
        ولا تظهر أو تعمل إلا مع اشتراك Yeastar نشط.
      </p>
      {canManage&&<Link
        className="mt-button primary"
        href={`/tenant/${encodeURIComponent(slug)}/settings?tab=addons`}
      >
        فتح مركز الإضافات
      </Link>}
    </div>
  </section>;
}
