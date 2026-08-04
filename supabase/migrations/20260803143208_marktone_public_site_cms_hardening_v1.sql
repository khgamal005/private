create or replace function private_app.website_sync_page_menu()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text;
  v_href text;
  v_old_href text;
begin
  v_href:='/p/'||new.slug;
  v_old_href:=case when tg_op='UPDATE' then '/p/'||old.slug else null end;
  v_label:=coalesce(nullif(trim(new.menu_label),''),new.title);

  if tg_op='UPDATE' and old.slug is distinct from new.slug then
    update website.menu_items
    set status='archived',is_visible=false
    where site_id=new.site_id
      and item_kind='page'
      and href=v_old_href;
  end if;

  if new.show_in_menu and new.status<>'archived' then
    update website.menu_items
    set label=v_label,
        href=v_href,
        sort_order=new.menu_order,
        is_visible=true,
        status=case when new.status='published' then 'published' else 'draft' end
    where id=(
      select m.id
      from website.menu_items m
      where m.site_id=new.site_id
        and m.item_kind='page'
        and m.href=v_href
      order by m.created_at
      limit 1
    );

    if not found then
      insert into website.menu_items(
        site_id,label,href,item_kind,sort_order,is_visible,status
      ) values (
        new.site_id,v_label,v_href,'page',new.menu_order,true,
        case when new.status='published' then 'published' else 'draft' end
      );
    end if;
  else
    update website.menu_items
    set status='archived',is_visible=false
    where site_id=new.site_id
      and item_kind='page'
      and href in (v_href,coalesce(v_old_href,v_href));
  end if;

  return new;
end;
$$;

revoke all on function private_app.website_sync_page_menu() from public,anon,authenticated;

drop trigger if exists website_sync_page_menu on website.pages;
create trigger website_sync_page_menu
after insert or update of slug,title,menu_label,menu_order,show_in_menu,status
on website.pages
for each row execute function private_app.website_sync_page_menu();

comment on function private_app.website_sync_page_menu()
is 'Keeps page menu links synchronized when a page is renamed, moved, unpublished, or hidden.';
