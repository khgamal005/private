begin;

-- Shared presentation layer for ODEIR public privacy and terms pages only.
do $$
declare
  v_site_id uuid;
  v_row record;
  v_document_id uuid;
  v_version integer;
  v_document jsonb;
  v_updated integer := 0;
  v_css text := $css$:root{--policy-navy:#06182e;--policy-navy-soft:#0b2949;--policy-cyan:#13c7d1;--policy-teal:#08b8b1;--policy-gold:#f0c534;--policy-paper:#f7f2e8;--policy-line:rgba(6,24,46,.11)}
.odeir-policy-hero{min-height:500px!important;background:radial-gradient(circle at 13% 20%,rgba(19,199,209,.22),transparent 31%),radial-gradient(circle at 89% 8%,rgba(240,197,52,.14),transparent 25%),linear-gradient(145deg,#020e1c 0%,#06182e 56%,#0b3554 100%)!important;position:relative;overflow:hidden}
.odeir-policy-hero:after{content:'◈';position:absolute;left:7%;top:50%;transform:translateY(-50%);font-size:clamp(150px,19vw,280px);line-height:1;color:rgba(255,255,255,.035);pointer-events:none}
.odeir-policy-hero h1{font-size:clamp(42px,5.5vw,72px)!important;line-height:1.12!important;max-width:900px!important;letter-spacing:-.035em}
.odeir-policy-hero p{max-width:820px!important}
.odeir-policy-hero a:first-of-type{background:var(--policy-gold)!important;border-color:var(--policy-gold)!important;color:var(--policy-navy)!important;border-radius:12px!important}
.odeir-policy-hero a:last-of-type{border-color:rgba(19,199,209,.55)!important;border-radius:12px!important}
.odeir-policy-principles{background:#fff!important}
.odeir-policy-principles article{border:1px solid var(--policy-line)!important;border-radius:18px!important;background:linear-gradient(180deg,#fff,#f8fbfd)!important;box-shadow:0 18px 55px rgba(6,24,46,.06)!important}
.odeir-policy-principles article strong{color:var(--policy-teal)!important;font-size:clamp(22px,3vw,34px)!important}
.odeir-policy-roles{background:#f4f8fb!important}
.odeir-policy-roles article,.odeir-policy-data article,.odeir-policy-bases article,.odeir-policy-rights article,.odeir-terms-free article,.odeir-terms-responsibility article,.odeir-terms-liability article,.odeir-terms-pricing article,.odeir-terms-exit article{border-radius:18px!important;border-color:var(--policy-line)!important;background:#fff!important;box-shadow:0 16px 50px rgba(6,24,46,.055)!important;transition:transform .2s ease,border-color .2s ease}
.odeir-policy-roles article:hover,.odeir-policy-data article:hover,.odeir-policy-bases article:hover,.odeir-policy-rights article:hover,.odeir-terms-free article:hover,.odeir-terms-responsibility article:hover,.odeir-terms-liability article:hover,.odeir-terms-pricing article:hover,.odeir-terms-exit article:hover{transform:translateY(-4px);border-color:rgba(19,199,209,.48)!important}
.odeir-policy-data{background:#fff!important}
.odeir-policy-bases{background:linear-gradient(180deg,#06182e,#0b2949)!important}
.odeir-policy-bases article{background:rgba(255,255,255,.065)!important;border-color:rgba(255,255,255,.12)!important;box-shadow:none!important}
.odeir-policy-bases article h3{color:#fff!important}.odeir-policy-bases article p{color:#c6d5e2!important}
.odeir-policy-lifecycle{background:var(--policy-paper)!important}
.odeir-policy-lifecycle article{border-radius:16px!important;background:#fff!important;border:1px solid rgba(6,24,46,.1)!important;padding:22px!important}
.odeir-policy-exit{background:linear-gradient(115deg,#e9fbf8,#fff8dc)!important}
.odeir-policy-exit>div,.odeir-policy-exit>a{border-radius:20px!important;border:1px solid rgba(8,184,177,.24)!important;box-shadow:0 20px 60px rgba(6,24,46,.07)!important}
.odeir-policy-rights{background:#f4f8fb!important}
.odeir-policy-faq{background:#fff!important}
.odeir-policy-faq details{border-radius:14px!important;border-color:var(--policy-line)!important}
.odeir-policy-cta{background:radial-gradient(circle at 12% 50%,rgba(19,199,209,.28),transparent 32%),linear-gradient(115deg,#06182e,#0b4161)!important}
.odeir-policy-cta a{background:var(--policy-gold)!important;color:var(--policy-navy)!important;border-radius:12px!important}
.odeir-terms-hero{min-height:500px!important;background:radial-gradient(circle at 14% 16%,rgba(19,199,209,.2),transparent 30%),radial-gradient(circle at 88% 8%,rgba(240,197,52,.13),transparent 24%),linear-gradient(145deg,#020e1c,#06182e 58%,#0c3b58)!important;position:relative;overflow:hidden}
.odeir-terms-hero:after{content:'§';position:absolute;left:8%;top:50%;transform:translateY(-52%);font-size:clamp(170px,22vw,320px);font-family:serif;color:rgba(255,255,255,.035);pointer-events:none}
.odeir-terms-hero h1{font-size:clamp(42px,5.2vw,70px)!important;line-height:1.12!important;letter-spacing:-.035em}
.odeir-terms-hero a:first-of-type{background:var(--policy-gold)!important;border-color:var(--policy-gold)!important;color:var(--policy-navy)!important;border-radius:12px!important}
.odeir-terms-hero a:last-of-type{border-color:rgba(19,199,209,.55)!important;border-radius:12px!important}
.odeir-terms-summary{background:#fff!important}
.odeir-terms-summary article{border-radius:18px!important;border:1px solid var(--policy-line)!important;background:linear-gradient(180deg,#fff,#f7fafc)!important;box-shadow:0 18px 50px rgba(6,24,46,.055)!important}
.odeir-terms-summary article strong{color:var(--policy-teal)!important;font-size:clamp(20px,2.7vw,32px)!important}
.odeir-terms-free{background:#f4f8fb!important}
.odeir-terms-notice{background:linear-gradient(110deg,#fff8db,#effcf9)!important}
.odeir-terms-notice>div{border:1px solid rgba(240,197,52,.38)!important;border-radius:18px!important;box-shadow:0 18px 55px rgba(6,24,46,.07)!important}
.odeir-terms-pricing{background:#fff!important}
.odeir-terms-lifecycle{background:linear-gradient(180deg,#06182e,#0b2949)!important}
.odeir-terms-lifecycle article{border-radius:16px!important;background:rgba(255,255,255,.065)!important;border:1px solid rgba(255,255,255,.12)!important;padding:22px!important}
.odeir-terms-lifecycle article h3{color:#fff!important}.odeir-terms-lifecycle article p{color:#c5d4e1!important}
.odeir-terms-exit{background:var(--policy-paper)!important}
.odeir-terms-responsibility{background:#fff!important}
.odeir-terms-liability{background:#f4f8fb!important}
.odeir-terms-use{background:#fff!important}
.odeir-terms-use details{border-radius:14px!important;border-color:var(--policy-line)!important}
.odeir-terms-law{background:linear-gradient(110deg,#eefbfa,#f9f2df)!important}
.odeir-terms-law>div,.odeir-terms-law>a{border-radius:18px!important;border:1px solid rgba(8,184,177,.23)!important}
.odeir-terms-cta{background:radial-gradient(circle at 12% 50%,rgba(19,199,209,.28),transparent 32%),linear-gradient(115deg,#06182e,#0b4161)!important}
.odeir-terms-cta a{background:var(--policy-gold)!important;color:var(--policy-navy)!important;border-radius:12px!important}
@media(max-width:720px){.odeir-policy-hero,.odeir-terms-hero{min-height:auto!important}.odeir-policy-hero:after,.odeir-terms-hero:after{opacity:.5;left:-14%}.odeir-policy-hero h1,.odeir-terms-hero h1{font-size:38px!important;line-height:1.2!important}}
.odeir-legal-toc{background:#fff!important;border-bottom:1px solid rgba(6,24,46,.08)!important;position:relative;z-index:3}
.odeir-legal-toc nav{max-width:1180px!important;margin:auto!important;padding:14px 18px!important;border:1px solid rgba(6,24,46,.1)!important;border-radius:16px!important;background:linear-gradient(180deg,#fff,#f7fafc)!important;box-shadow:0 14px 42px rgba(6,24,46,.06)!important}
.odeir-legal-toc nav>b{display:block!important;color:#06182e!important;margin-bottom:11px!important}
.odeir-legal-toc nav>div{display:flex!important;flex-wrap:wrap!important;gap:8px!important}
.odeir-legal-toc a{display:inline-flex!important;padding:8px 12px!important;border-radius:999px!important;border:1px solid rgba(6,24,46,.1)!important;background:#fff!important;color:#0b4161!important;text-decoration:none!important;font-size:12px!important;font-weight:800!important;transition:.18s ease!important}
.odeir-legal-toc a:hover{border-color:rgba(19,199,209,.55)!important;background:#effcfc!important;transform:translateY(-1px)}
.odeir-policy-hero>div:last-child,.odeir-terms-hero>div:last-child{min-height:300px!important;border:1px solid rgba(255,255,255,.13)!important;border-radius:28px!important;background:radial-gradient(circle at 50% 42%,rgba(19,199,209,.19),transparent 36%),linear-gradient(145deg,rgba(255,255,255,.08),rgba(255,255,255,.025))!important;box-shadow:inset 0 1px rgba(255,255,255,.12),0 34px 90px rgba(0,0,0,.23)!important;position:relative!important;overflow:hidden!important}
.odeir-policy-hero>div:last-child>*,.odeir-terms-hero>div:last-child>*{display:none!important}
.odeir-policy-hero>div:last-child:before,.odeir-terms-hero>div:last-child:before{display:grid!important;place-items:center!important;width:116px!important;height:116px!important;border-radius:34px!important;margin:auto!important;background:linear-gradient(145deg,#13c7d1,#087f7a)!important;color:#fff!important;font-size:62px!important;font-weight:900!important;box-shadow:0 24px 70px rgba(19,199,209,.28)!important;position:absolute!important;inset:50% auto auto 50%!important;transform:translate(-50%,-62%)!important}
.odeir-policy-hero>div:last-child:before{content:'⌾'!important}
.odeir-terms-hero>div:last-child:before{content:'§'!important;background:linear-gradient(145deg,#f0c534,#c89e12)!important;color:#06182e!important;box-shadow:0 24px 70px rgba(240,197,52,.22)!important}
.odeir-policy-hero>div:last-child:after,.odeir-terms-hero>div:last-child:after{position:absolute!important;left:50%!important;top:73%!important;transform:translateX(-50%)!important;color:rgba(255,255,255,.82)!important;font-size:13px!important;font-weight:900!important;letter-spacing:.02em!important;white-space:nowrap!important}
.odeir-policy-hero>div:last-child:after{content:'حوكمة البيانات والخصوصية'!important}
.odeir-terms-hero>div:last-child:after{content:'شروط واضحة وتشغيل مسؤول'!important}
.odeir-policy-exit>a,.odeir-terms-law>a{border-radius:20px!important;border:1px solid rgba(8,184,177,.24)!important;box-shadow:0 20px 60px rgba(6,24,46,.07)!important;text-decoration:none!important}

@media(max-width:900px){.odeir-policy-hero>div:last-child,.odeir-terms-hero>div:last-child{min-height:230px!important}.odeir-legal-toc nav>div{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important}.odeir-legal-toc a{justify-content:center!important;text-align:center!important}}
@media(max-width:560px){.odeir-legal-toc nav>div{grid-template-columns:1fr!important}.odeir-policy-hero>div:last-child,.odeir-terms-hero>div:last-child{display:none!important}}
$css$;
begin
  select id into v_site_id
  from website.sites
  where site_key='marktone-main'
  limit 1;

  if v_site_id is null then
    raise exception 'odeir_platform_site_not_found';
  end if;

  for v_row in
    select id,slug,content
    from website.pages
    where site_id=v_site_id
      and slug in ('privacy-policy','terms-of-use')
      and status<>'archived'
    order by slug
  loop
    v_document := private_app.website_builder_validate_document(
      jsonb_set(v_row.content,'{settings,customCss}',to_jsonb(v_css),true)
    );

    update website.pages
    set content=v_document,updated_at=now()
    where id=v_row.id;

    insert into website.content_documents(
      site_id,entity_type,entity_id,schema_version,draft_document,published_document,
      draft_updated_at,published_at
    ) values(
      v_site_id,'page',v_row.id,1,v_document,v_document,now(),now()
    )
    on conflict(site_id,entity_type,entity_id) do update set
      schema_version=1,
      draft_document=excluded.draft_document,
      published_document=excluded.published_document,
      draft_updated_at=now(),
      published_at=now(),
      updated_at=now()
    returning id into v_document_id;

    select coalesce(max(version_number),0)+1 into v_version
    from website.content_document_versions
    where content_document_id=v_document_id;

    insert into website.content_document_versions(
      content_document_id,version_number,version_kind,document,note
    ) values(
      v_document_id,v_version,'published',v_document,
      'اعتماد التصميم الاحترافي لصفحات الخصوصية والشروط'
    );

    v_updated := v_updated + 1;
  end loop;

  if v_updated <> 2 then
    raise exception 'odeir_legal_style_update_incomplete:%',v_updated;
  end if;
end
$$;

commit;
