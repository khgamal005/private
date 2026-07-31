-- Applied migration version: 20260731040100
begin;

create or replace function public.v2_commerce_hub_store_batch(
  p_connection_id uuid,
  p_run_id uuid,
  p_entity_type text,
  p_items jsonb,
  p_cursor jsonb default '{}'::jsonb,
  p_has_more boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_hub.connections%rowtype;
  v_run commerce_hub.sync_runs%rowtype;
  v_item jsonb;
  v_normalized jsonb;
  v_entity_type text;
  v_external_id text;
  v_external_parent_id text;
  v_remote_updated_at timestamptz;
  v_remote_hash text;
  v_archived boolean;
  v_local_course_id uuid;
  v_course academy.courses%rowtype;
  v_course_is_linked boolean;
  v_candidate_ids uuid[];
  v_course_code text;
  v_resolved_course_code text;
  v_title_ar text;
  v_title_en text;
  v_category text;
  v_description text;
  v_delivery_mode text;
  v_duration_hours numeric;
  v_duration_days bigint;
  v_regular_price bigint;
  v_sale_price bigint;
  v_current_price bigint;
  v_sale_starts_at timestamptz;
  v_sale_ends_at timestamptz;
  v_currency text;
  v_currency_minor_digits bigint;
  v_external_url text;
  v_primary_image_url text;
  v_gallery_urls text[];
  v_stock_status text;
  v_stock_quantity numeric;
  v_product_type text;
  v_virtual boolean;
  v_downloadable boolean;
  v_course_status text;
  v_fetched bigint := 0;
  v_stored bigint := 0;
  v_created bigint := 0;
  v_updated bigint := 0;
  v_archived_count bigint := 0;
  v_failed bigint := 0;
begin
  v_entity_type := lower(trim(coalesce(p_entity_type, '')));
  if v_entity_type not in (
    'products','categories','attributes','collections','variations',
    'variants','coupons','discounts','orders','customers','webhooks'
  ) then
    raise exception 'commerce_invalid_entity_type';
  end if;
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 500 then
    raise exception 'commerce_invalid_batch';
  end if;

  select * into v_connection
  from commerce_hub.connections connection
  where connection.id = p_connection_id
    and connection.status in ('active','degraded')
  limit 1;
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select * into v_run
  from commerce_hub.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
  for update;
  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then raise exception 'sync_run_not_running'; end if;
  if not (v_entity_type = any(v_run.scope)) then
    raise exception 'commerce_entity_outside_run_scope';
  end if;

  for v_item in select item.value from jsonb_array_elements(p_items) item(value)
  loop
    v_fetched := v_fetched + 1;
    if jsonb_typeof(v_item) <> 'object' then
      v_failed := v_failed + 1;
      continue;
    end if;

    v_normalized := case
      when jsonb_typeof(v_item -> '_marktone') = 'object'
        then v_item -> '_marktone'
      else '{}'::jsonb
    end;
    v_external_id := nullif(trim(coalesce(
      v_normalized ->> 'externalId',
      v_item ->> 'id'
    )), '');
    if v_external_id is null or length(v_external_id) > 255 then
      v_failed := v_failed + 1;
      continue;
    end if;

    v_external_parent_id := nullif(trim(coalesce(
      v_normalized ->> 'externalParentId',
      v_item ->> 'parent_id'
    )), '');
    v_remote_updated_at := private_app.commerce_hub_try_timestamptz(
      coalesce(
        v_normalized ->> 'externalUpdatedAt',
        v_item ->> 'updated_at',
        v_item ->> 'date_modified'
      )
    );
    v_remote_hash := coalesce(
      nullif(v_normalized ->> 'remoteHash', ''),
      md5(v_item::text)
    );
    v_archived := lower(coalesce(v_normalized ->> 'archived','false'))
      in ('true','1','yes')
      or lower(coalesce(v_normalized ->> 'status',v_item ->> 'status',''))
      in ('archived','trash','deleted');

    insert into commerce_hub.external_entities (
      tenant_id, connection_id, provider_key, entity_type, external_id,
      external_parent_id, raw_payload, normalized_payload,
      remote_updated_at, remote_hash, sync_state, last_seen_run_id,
      last_synced_at, archived_at, last_error
    ) values (
      v_connection.tenant_id, v_connection.id, v_connection.provider_key,
      v_entity_type, v_external_id, v_external_parent_id, v_item,
      v_normalized, v_remote_updated_at, v_remote_hash,
      case when v_archived then 'archived' else 'active' end,
      v_run.id, now(), case when v_archived then now() else null end, null
    )
    on conflict (connection_id, entity_type, external_id) do update
    set external_parent_id = excluded.external_parent_id,
        raw_payload = excluded.raw_payload,
        normalized_payload = excluded.normalized_payload,
        remote_updated_at = excluded.remote_updated_at,
        remote_hash = excluded.remote_hash,
        sync_state = excluded.sync_state,
        last_seen_run_id = excluded.last_seen_run_id,
        last_synced_at = excluded.last_synced_at,
        archived_at = excluded.archived_at,
        last_error = null
    returning local_course_id into v_local_course_id;

    v_stored := v_stored + 1;
    if v_entity_type <> 'products' then continue; end if;

    begin
      v_course := null;
      v_candidate_ids := null;
      v_course_code := nullif(trim(coalesce(
        v_normalized ->> 'courseCode',
        v_normalized ->> 'sku',
        v_item ->> 'sku'
      )), '');
      if v_course_code is not null then v_course_code := left(v_course_code,180); end if;

      v_title_ar := nullif(trim(coalesce(
        v_normalized ->> 'titleAr',
        v_normalized ->> 'title',
        v_item ->> 'name',
        v_item ->> 'title'
      )), '');
      if v_title_ar is null or length(v_title_ar) < 2 then
        v_title_ar := upper(v_connection.provider_key) || ' ' || v_external_id;
      end if;
      v_title_en := nullif(trim(v_normalized ->> 'titleEn'),'');
      v_category := nullif(trim(coalesce(
        v_normalized ->> 'category',
        v_normalized #>> '{primaryCategory,name}',
        v_normalized #>> '{categoryNames,0}'
      )), '');
      v_description := coalesce(
        v_normalized ->> 'description',
        v_normalized ->> 'plainDescription',
        v_item ->> 'description'
      );
      v_delivery_mode := lower(coalesce(v_normalized ->> 'deliveryMode',''));
      if v_delivery_mode not in ('online','onsite','hybrid') then
        v_delivery_mode := null;
      end if;
      v_duration_hours := private_app.commerce_hub_try_numeric(
        v_normalized ->> 'durationHours'
      );
      if v_duration_hours is not null and v_duration_hours <= 0 then
        v_duration_hours := null;
      end if;
      v_duration_days := private_app.commerce_hub_try_bigint(
        v_normalized ->> 'durationDays'
      );
      if v_duration_days is not null and (v_duration_days = 0 or v_duration_days > 2147483647) then
        v_duration_days := null;
      end if;
      v_regular_price := private_app.commerce_hub_try_bigint(
        v_normalized ->> 'regularPriceMinor'
      );
      v_sale_price := private_app.commerce_hub_try_bigint(
        v_normalized ->> 'salePriceMinor'
      );
      v_current_price := private_app.commerce_hub_try_bigint(
        v_normalized ->> 'priceMinor'
      );
      v_sale_starts_at := private_app.commerce_hub_try_timestamptz(
        v_normalized ->> 'saleStartsAt'
      );
      v_sale_ends_at := private_app.commerce_hub_try_timestamptz(
        v_normalized ->> 'saleEndsAt'
      );
      if v_sale_starts_at is not null and v_sale_ends_at is not null
         and v_sale_ends_at <= v_sale_starts_at then
        v_sale_ends_at := null;
      end if;
      v_currency := upper(coalesce(nullif(trim(v_normalized ->> 'currency'),''),'SAR'));
      if v_currency !~ '^[A-Z]{3}$' then v_currency := 'SAR'; end if;
      v_currency_minor_digits := private_app.commerce_hub_try_bigint(
        v_normalized ->> 'currencyMinorDigits'
      );
      if v_currency_minor_digits is null or v_currency_minor_digits > 4 then
        v_currency_minor_digits := 2;
      end if;
      v_external_url := nullif(trim(v_normalized ->> 'externalUrl'),'');
      if v_external_url is not null and v_external_url !~* '^https://[^[:space:]]+$' then
        v_external_url := null;
      end if;
      v_primary_image_url := nullif(trim(v_normalized ->> 'primaryImageUrl'),'');
      if v_primary_image_url is not null and v_primary_image_url !~* '^https://[^[:space:]]+$' then
        v_primary_image_url := null;
      end if;
      v_gallery_urls := '{}'::text[];
      if jsonb_typeof(v_normalized -> 'galleryUrls') = 'array' then
        select coalesce(array_agg(image.value order by image.position),'{}'::text[])
        into v_gallery_urls
        from jsonb_array_elements_text(v_normalized -> 'galleryUrls')
          with ordinality image(value, position)
        where image.value ~* '^https://[^[:space:]]+$';
      end if;
      v_stock_status := lower(coalesce(v_normalized ->> 'stockStatus',''));
      if v_stock_status not in ('instock','outofstock','onbackorder') then
        v_stock_status := null;
      end if;
      v_stock_quantity := private_app.commerce_hub_try_numeric(
        v_normalized ->> 'stockQuantity'
      );
      if v_stock_quantity is not null and v_stock_quantity > 99999999999.999 then
        v_stock_quantity := null;
      end if;
      v_product_type := lower(coalesce(nullif(trim(v_normalized ->> 'productType'),''),'simple'));
      if v_product_type !~ '^[a-z][a-z0-9_-]{0,40}$' then v_product_type := 'simple'; end if;
      v_virtual := lower(coalesce(v_normalized ->> 'virtual','false')) in ('true','1','yes');
      v_downloadable := lower(coalesce(v_normalized ->> 'downloadable','false')) in ('true','1','yes');
      v_course_status := case
        when v_archived then 'archived'
        when lower(coalesce(v_normalized ->> 'status','active'))
          in ('active','publish','published') then 'active'
        else 'draft'
      end;

      if v_local_course_id is not null then
        select * into v_course from academy.courses course
        where course.id = v_local_course_id
          and course.tenant_id = v_connection.tenant_id
        limit 1;
      end if;
      if v_course.id is null then
        select * into v_course from academy.courses course
        where course.tenant_id = v_connection.tenant_id
          and course.external_source = v_connection.provider_key
          and course.external_id = v_external_id
        limit 1;
      end if;
      if v_course.id is null and v_connection.match_by_sku
         and v_course_code is not null then
        select array_agg(course.id order by course.created_at)
        into v_candidate_ids
        from academy.courses course
        where course.tenant_id = v_connection.tenant_id
          and lower(course.course_code) = lower(v_course_code)
          and (
            course.external_source is null
            or (
              course.external_source = v_connection.provider_key
              and course.external_id = v_external_id
            )
          )
          and not exists (
            select 1 from commerce_hub.external_entities mapped
            where mapped.connection_id = v_connection.id
              and mapped.entity_type = 'products'
              and mapped.local_course_id = course.id
              and mapped.external_id <> v_external_id
          );
        if cardinality(v_candidate_ids) = 1 then
          select * into v_course from academy.courses course
          where course.id = v_candidate_ids[1];
        end if;
      end if;

      v_course_is_linked := v_course.id is not null and (
        v_course.external_source is null
        or coalesce(v_course.metadata #>> '{commerce,origin}','') = 'linked'
      );

      if v_course.id is null then
        v_resolved_course_code := v_course_code;
        if v_resolved_course_code is null or exists (
          select 1 from academy.courses course
          where course.tenant_id = v_connection.tenant_id
            and lower(course.course_code) = lower(v_resolved_course_code)
        ) then
          v_resolved_course_code := upper(left(v_connection.provider_key,4))
            || '-' || substr(replace(v_connection.id::text,'-',''),1,8)
            || '-' || substr(md5(v_external_id),1,16);
        end if;

        insert into academy.courses (
          tenant_id, course_code, title_ar, title_en, category, description,
          delivery_mode, duration_hours, duration_days, price_minor,
          regular_price_minor, sale_price_minor, sale_starts_at, sale_ends_at,
          currency, currency_minor_digits, status, external_source, external_id,
          external_url, external_updated_at, primary_image_url, gallery_urls,
          stock_status, stock_quantity, product_type, "virtual", downloadable,
          metadata
        ) values (
          v_connection.tenant_id, v_resolved_course_code, v_title_ar, v_title_en,
          coalesce(v_category, v_connection.provider_key), v_description,
          coalesce(v_delivery_mode,'online'), v_duration_hours,
          v_duration_days::integer, coalesce(v_current_price,v_sale_price,v_regular_price),
          v_regular_price, v_sale_price, v_sale_starts_at, v_sale_ends_at,
          v_currency, v_currency_minor_digits::smallint, v_course_status,
          v_connection.provider_key, v_external_id, v_external_url,
          v_remote_updated_at, v_primary_image_url, v_gallery_urls,
          v_stock_status, v_stock_quantity, v_product_type, v_virtual,
          v_downloadable, jsonb_build_object('commerce',jsonb_build_object(
            'connectionId',v_connection.id,'providerKey',v_connection.provider_key,
            'origin','imported','sku',v_course_code,'lastSyncedAt',now()
          ))
        ) returning * into v_course;
        v_created := v_created + 1;
      else
        update academy.courses course
        set title_ar = case when v_course_is_linked then course.title_ar else v_title_ar end,
            title_en = case when v_course_is_linked then course.title_en else coalesce(v_title_en,course.title_en) end,
            category = case when v_course_is_linked then course.category else coalesce(v_category,course.category) end,
            description = case when v_course_is_linked then course.description else coalesce(v_description,course.description) end,
            delivery_mode = case when v_course_is_linked then course.delivery_mode else coalesce(v_delivery_mode,course.delivery_mode) end,
            duration_hours = case when v_course_is_linked then course.duration_hours else coalesce(v_duration_hours,course.duration_hours) end,
            duration_days = case when v_course_is_linked then course.duration_days else coalesce(v_duration_days::integer,course.duration_days) end,
            price_minor = coalesce(v_current_price,v_sale_price,v_regular_price,course.price_minor),
            regular_price_minor = v_regular_price,
            sale_price_minor = v_sale_price,
            sale_starts_at = v_sale_starts_at,
            sale_ends_at = v_sale_ends_at,
            currency = v_currency,
            currency_minor_digits = v_currency_minor_digits::smallint,
            status = case when v_course_is_linked and not v_archived then course.status else v_course_status end,
            external_source = v_connection.provider_key,
            external_id = v_external_id,
            external_url = v_external_url,
            external_updated_at = v_remote_updated_at,
            primary_image_url = v_primary_image_url,
            gallery_urls = v_gallery_urls,
            stock_status = v_stock_status,
            stock_quantity = v_stock_quantity,
            product_type = v_product_type,
            "virtual" = v_virtual,
            downloadable = v_downloadable,
            metadata = jsonb_set(
              coalesce(course.metadata,'{}'::jsonb),
              '{commerce}',
              jsonb_build_object(
                'connectionId',v_connection.id,
                'providerKey',v_connection.provider_key,
                'origin',case when v_course_is_linked then 'linked' else 'imported' end,
                'sku',v_course_code,
                'lastSyncedAt',now()
              ),
              true
            )
        where course.id = v_course.id
        returning * into v_course;
        v_updated := v_updated + 1;
      end if;

      update commerce_hub.external_entities entity
      set local_course_id = v_course.id,
          last_error = null
      where entity.connection_id = v_connection.id
        and entity.entity_type = 'products'
        and entity.external_id = v_external_id;
    exception when others then
      v_failed := v_failed + 1;
      update commerce_hub.external_entities entity
      set sync_state = 'error',
          last_error = left(sqlerrm,1000)
      where entity.connection_id = v_connection.id
        and entity.entity_type = 'products'
        and entity.external_id = v_external_id;
    end;
  end loop;

  if not coalesce(p_has_more,false) then
    update commerce_hub.external_entities entity
    set sync_state = 'archived',
        archived_at = now(),
        last_synced_at = now()
    where entity.connection_id = v_connection.id
      and entity.entity_type = v_entity_type
      and entity.sync_state <> 'archived'
      and entity.last_seen_run_id is distinct from v_run.id;
    get diagnostics v_archived_count = row_count;

    if v_entity_type = 'products' then
      update academy.courses course
      set status = 'archived',
          external_updated_at = now()
      where course.tenant_id = v_connection.tenant_id
        and course.external_source = v_connection.provider_key
        and coalesce(course.metadata #>> '{commerce,origin}','imported') = 'imported'
        and exists (
          select 1 from commerce_hub.external_entities entity
          where entity.connection_id = v_connection.id
            and entity.entity_type = 'products'
            and entity.local_course_id = course.id
            and entity.sync_state = 'archived'
        );
    end if;
  end if;

  update commerce_hub.sync_runs
  set fetched_count = fetched_count + v_fetched,
      stored_count = stored_count + v_stored,
      created_count = created_count + v_created,
      updated_count = updated_count + v_updated,
      archived_count = archived_count + v_archived_count,
      failed_count = failed_count + v_failed,
      cursor = coalesce(p_cursor,'{}'::jsonb),
      stats = jsonb_set(
        coalesce(stats,'{}'::jsonb),
        array[v_entity_type],
        jsonb_build_object(
          'fetched',v_fetched,'stored',v_stored,'created',v_created,
          'updated',v_updated,'archived',v_archived_count,'failed',v_failed,
          'hasMore',coalesce(p_has_more,false)
        ),
        true
      )
  where id = v_run.id;

  return jsonb_build_object(
    'fetchedCount',v_fetched,
    'storedCount',v_stored,
    'createdCount',v_created,
    'updatedCount',v_updated,
    'archivedCount',v_archived_count,
    'failedCount',v_failed,
    'hasMore',coalesce(p_has_more,false)
  );
end;
$$;

revoke all on function public.v2_commerce_hub_store_batch(uuid,uuid,text,jsonb,jsonb,boolean)
from public, anon, authenticated;
grant execute on function public.v2_commerce_hub_store_batch(uuid,uuid,text,jsonb,jsonb,boolean)
to service_role;

commit;
