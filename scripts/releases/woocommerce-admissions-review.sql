-- Read-only cohort review. No automatic link based solely on customer identity.
begin read only;
with orders as (
 select w.*,e.raw_payload from sales_core.commerce_order_work_items w
 join core.tenants t on t.id=w.tenant_id and t.slug='reef-skills'
 join work_core.tasks task on task.id=w.task_id and task.tenant_id=w.tenant_id
 join commerce_sync.external_entities e on e.id=w.external_entity_id and e.tenant_id=w.tenant_id
 where w.payment_state='paid' and task.status in ('todo','in_progress')
), items as (
 select o.id,li->>'id' line_id,(li->>'quantity')::numeric quantity,o.amount_minor,
  greatest(0,coalesce((li->>'total')::numeric,0)+coalesce((li->>'total_tax')::numeric,0)) weight
 from orders o cross join lateral jsonb_array_elements(o.raw_payload->'line_items') li
), weighted as (
 select *,case when sum(weight) over(partition by id)>0 then amount_minor*weight/sum(weight) over(partition by id)
  else amount_minor::numeric/count(*) over(partition by id) end exact from items
), allocated as (
 select *,floor(exact)::bigint+case when row_number() over(partition by id order by exact-floor(exact) desc,line_id)
  <=amount_minor-sum(floor(exact)) over(partition by id) then 1 else 0 end allocation from weighted
), inspected as (
 select o.order_number,o.id work_item_id,o.task_id,o.amount_minor,o.paid_at,
  (select count(*) from allocated a where a.id=o.id) lines,
  exists(select 1 from allocated a where a.id=o.id and a.quantity<>1) needs_beneficiaries,
  (select count(*) from academy.registration_handoffs h where h.tenant_id=o.tenant_id and h.contact_id=o.contact_id) candidates,
  (select count(*) from academy.registration_handoffs h where h.tenant_id=o.tenant_id and h.contact_id=o.contact_id
   and h.payment_status='verified' and h.payment_reference in(o.order_number,'WooCommerce #'||o.order_number)) exact_references,
  exists(select 1 from academy.registration_handoffs h where h.tenant_id=o.tenant_id and h.contact_id=o.contact_id
   and h.payment_status='verified' and h.payment_reference in(o.order_number,'WooCommerce #'||o.order_number)
   and not exists(select 1 from allocated a where a.id=o.id and a.allocation=h.payment_amount_minor)) mismatched_reference_amount,
  (select count(*) from academy.registration_handoffs h where h.tenant_id=o.tenant_id and h.contact_id=o.contact_id
    and h.status='completed') completed_admissions,
  (select count(*) from allocated a where a.id=o.id and
   (select count(*) from academy.registration_handoffs h where h.tenant_id=o.tenant_id and h.contact_id=o.contact_id
     and h.payment_status='verified' and h.payment_reference in(o.order_number,'WooCommerce #'||o.order_number)
     and h.payment_amount_minor=a.allocation)>1) ambiguous_lines
 from orders o
)
select *,case when needs_beneficiaries then 'beneficiaries_required'
 when mismatched_reference_amount then 'payment_amount_review'
 when ambiguous_lines>0 then 'ambiguous_link_review'
 when exact_references>0 then 'reference_and_amount_candidates'
 when candidates>0 then 'manual_link_review'
 else 'new_order_course_review' end review_class
from inspected order by paid_at,order_number;
commit;
