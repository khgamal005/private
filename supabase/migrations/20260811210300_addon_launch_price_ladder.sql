begin;

update catalog.addon_price_versions price
set valid_to=date '2026-08-11'
from catalog.addon_products product
where product.id=price.product_id
  and product.product_key='zoom'
  and price.valid_to is null
  and price.valid_from<date '2026-08-11';

insert into catalog.addon_price_versions(
  product_id,pricing_mode,amount_minor,currency,billing_interval,
  valid_from,valid_to,tax_inclusive,tax_rate_bps,change_note
)
select product.id,'fixed',40000,'SAR','year',date '2026-08-11',null,false,1500,
       'Founding launch annual price tier: SAR 400 before VAT.'
from catalog.addon_products product
where product.product_key='zoom'
on conflict(product_id,currency,valid_from) do update
set pricing_mode=excluded.pricing_mode,
    amount_minor=excluded.amount_minor,
    billing_interval=excluded.billing_interval,
    valid_to=excluded.valid_to,
    tax_inclusive=excluded.tax_inclusive,
    tax_rate_bps=excluded.tax_rate_bps,
    change_note=excluded.change_note;

update catalog.addon_products
set pricing_mode='fixed',amount_minor=40000,currency='SAR',interval='year',updated_at=now()
where product_key='zoom';

commit;

