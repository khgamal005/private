do $$
declare
  v_site_id uuid;
  v_menu_id uuid;
begin
  select s.id,m.id into v_site_id,v_menu_id
  from website.sites s
  join website.menus m on m.site_id=s.id and m.menu_key='footer'
  where s.site_key='marktone-main'
  limit 1;

  if v_menu_id is null then return; end if;

  update website.menu_items
  set status='archived',is_visible=false,updated_at=now()
  where menu_id=v_menu_id and href='/free-trial';

  update website.menu_items set sort_order=10,status='published',is_visible=true,updated_at=now() where menu_id=v_menu_id and href='/';
  update website.menu_items set sort_order=20,status='published',is_visible=true,updated_at=now() where menu_id=v_menu_id and href='/articles';
  update website.menu_items set sort_order=30,status='published',is_visible=true,updated_at=now() where menu_id=v_menu_id and href='/p/information-security';
  update website.menu_items set sort_order=40,status='published',is_visible=true,updated_at=now() where menu_id=v_menu_id and href='/p/privacy-policy';
  update website.menu_items set sort_order=50,status='published',is_visible=true,updated_at=now() where menu_id=v_menu_id and href='/p/terms-of-use';
  update website.menu_items set sort_order=60,status='published',is_visible=true,updated_at=now() where menu_id=v_menu_id and href='/p/cookie-policy';
  update website.menu_items set sort_order=70,status='published',is_visible=true,updated_at=now() where menu_id=v_menu_id and href='/p/data-rights';
  update website.menu_items set sort_order=90,status='published',is_visible=true,updated_at=now() where menu_id=v_menu_id and href='/login';

  insert into website.menu_items(site_id,menu_id,label,href,item_kind,sort_order,is_visible,status,created_at,updated_at)
  select v_site_id,v_menu_id,'تواصل معنا','/contact','page',80,true,'published',now(),now()
  where not exists(select 1 from website.menu_items where menu_id=v_menu_id and href='/contact');

  update website.menu_items
  set label='تواصل معنا',sort_order=80,status='published',is_visible=true,updated_at=now()
  where menu_id=v_menu_id and href='/contact';

  with ranked as (
    select id,row_number() over(partition by href order by created_at desc,id desc) rn
    from website.menu_items
    where menu_id=v_menu_id and href in ('/p/information-security','/p/privacy-policy','/p/terms-of-use','/p/cookie-policy','/p/data-rights')
  )
  update website.menu_items mi
  set status='archived',is_visible=false,updated_at=now()
  from ranked r where mi.id=r.id and r.rn>1;
end $$;
