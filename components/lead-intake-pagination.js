import {LEAD_INTAKE_PAGE_SIZE} from '../lib/lead-intake-page-contract.mjs';

const number=value=>Number(value).toLocaleString('ar-SA');
export default function LeadIntakePagination({page,section}){
  const unit=section==='assignments'?'عملية إسناد':section==='batches'?'دفعة':'صف';
  const first=page.records.length?page.pageIndex*LEAD_INTAKE_PAGE_SIZE+1:0;
  const last=page.records.length?first+page.records.length-1:0;
  return <div className="mt-data-pagination" aria-label="صفحات السجل">
    <div className="mt-data-pagination__summary" aria-live="polite" role="status">
      {page.loading?'جارٍ تحميل النتائج…':page.error?'تعذر تحميل النتائج':
        `${number(first)}–${number(last)} من ${number(page.total||0)} ${unit}`}
    </div>
    <div className="mt-data-pagination__actions">
      <button type="button" className="mt-data-pagination__nav" disabled={page.loading||Boolean(page.error)||page.pageIndex===0}
        onClick={page.previous}>السابق</button>
      <span>صفحة {number(page.pageIndex+1)}</span>
      <button type="button" className="mt-data-pagination__nav" disabled={page.loading||Boolean(page.error)||!page.hasMore}
        onClick={page.next}>التالي</button>
    </div>
  </div>;
}
