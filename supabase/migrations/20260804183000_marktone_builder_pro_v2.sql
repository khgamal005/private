begin;

-- Marktone Builder Pro keeps schemaVersion=1 for backwards compatibility,
-- while allowing professional row/column documents and the expanded module catalog.
create or replace function private_app.website_builder_validate_document(
  p_document jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_document jsonb:=coalesce(p_document,'{}'::jsonb);
  v_blocks jsonb;
  v_block jsonb;
  v_type text;
  v_id text;
  v_columns jsonb;
  v_column jsonb;
  v_modules jsonb;
  v_module jsonb;
  v_module_type text;
  v_nested_count integer:=0;
  v_allowed constant text[]:=array[
    'hero','heading','fancyHeading','text','box','alert','accordion','code','callout',
    'button','buttons','divider','spacer','copyright','icon','image','gallery','mosaic',
    'feature','linkBlock','layoutPart','map','lottie','login','overlay','optin','menu',
    'serviceMenu','post','html','socialShare','slider','signup','table','tabs','rating',
    'toc','testimonials','widgetArea','widget','video','cards','stats','columns','quote',
    'faq','cta','contact','productCategories','timeline','products'
  ];
  v_nested_allowed constant text[]:=array[
    'hero','heading','fancyHeading','text','box','alert','accordion','code','callout',
    'button','buttons','divider','spacer','copyright','icon','image','gallery','mosaic',
    'feature','linkBlock','layoutPart','map','lottie','login','overlay','optin','menu',
    'serviceMenu','post','html','socialShare','slider','signup','table','tabs','rating',
    'toc','testimonials','widgetArea','widget','video','cards','stats','quote','faq',
    'cta','contact','productCategories','timeline','products'
  ];
begin
  if jsonb_typeof(v_document)<>'object' then
    raise exception 'builder_document_invalid';
  end if;
  if coalesce(v_document->>'schemaVersion','') !~ '^[0-9]+$'
     or (v_document->>'schemaVersion')::integer<>1 then
    raise exception 'builder_document_invalid';
  end if;
  if octet_length(v_document::text)>1500000 then
    raise exception 'builder_document_too_large';
  end if;

  v_blocks:=v_document->'blocks';
  if jsonb_typeof(v_blocks)<>'array' then
    raise exception 'builder_document_invalid';
  end if;
  if jsonb_array_length(v_blocks)>80 then
    raise exception 'builder_blocks_limit';
  end if;

  for v_block in select value from jsonb_array_elements(v_blocks) as block(value) loop
    if jsonb_typeof(v_block)<>'object' then
      raise exception 'builder_block_invalid';
    end if;
    v_id:=trim(coalesce(v_block->>'id',''));
    v_type:=trim(coalesce(v_block->>'type',''));
    if v_id !~ '^[A-Za-z0-9_-]{6,80}$' then
      raise exception 'builder_block_invalid';
    end if;
    if not (v_type=any(v_allowed)) then
      raise exception 'builder_block_type_invalid';
    end if;
    if jsonb_typeof(coalesce(v_block->'props','{}'::jsonb))<>'object'
       or jsonb_typeof(coalesce(v_block->'style','{}'::jsonb))<>'object'
       or jsonb_typeof(coalesce(v_block->'responsive','{}'::jsonb))<>'object' then
      raise exception 'builder_block_invalid';
    end if;
    if octet_length(v_block::text)>300000 then
      raise exception 'builder_block_invalid';
    end if;

    -- Professional rows are represented as a backwards-compatible columns block.
    if v_type='columns'
       and lower(coalesce(v_block->'props'->>'row','false'))='true' then
      if coalesce(v_block->'props'->>'layoutKey','') not in (
        '1','1-1','1-2','2-1','1-3','3-1','1-1-1','1-2-1',
        '1-1-1-1','1-1-1-1-1','1-1-1-1-1-1'
      ) then
        raise exception 'builder_row_layout_invalid';
      end if;
      v_columns:=v_block->'props'->'items';
      if jsonb_typeof(v_columns)<>'array'
         or jsonb_array_length(v_columns)<1
         or jsonb_array_length(v_columns)>6 then
        raise exception 'builder_row_columns_invalid';
      end if;

      for v_column in select value from jsonb_array_elements(v_columns) as column_item(value) loop
        if jsonb_typeof(v_column)<>'object'
           or trim(coalesce(v_column->>'id','')) !~ '^[A-Za-z0-9_-]{6,80}$'
           or jsonb_typeof(coalesce(v_column->'style','{}'::jsonb))<>'object'
           or jsonb_typeof(coalesce(v_column->'responsive','{}'::jsonb))<>'object' then
          raise exception 'builder_column_invalid';
        end if;
        v_modules:=v_column->'modules';
        if jsonb_typeof(v_modules)<>'array' or jsonb_array_length(v_modules)>60 then
          raise exception 'builder_column_modules_invalid';
        end if;

        for v_module in select value from jsonb_array_elements(v_modules) as module_item(value) loop
          v_nested_count:=v_nested_count+1;
          if v_nested_count>240 then
            raise exception 'builder_modules_limit';
          end if;
          if jsonb_typeof(v_module)<>'object'
             or trim(coalesce(v_module->>'id','')) !~ '^[A-Za-z0-9_-]{6,80}$' then
            raise exception 'builder_module_invalid';
          end if;
          v_module_type:=trim(coalesce(v_module->>'type',''));
          if not (v_module_type=any(v_nested_allowed)) then
            raise exception 'builder_module_type_invalid';
          end if;
          if jsonb_typeof(coalesce(v_module->'props','{}'::jsonb))<>'object'
             or jsonb_typeof(coalesce(v_module->'style','{}'::jsonb))<>'object'
             or jsonb_typeof(coalesce(v_module->'responsive','{}'::jsonb))<>'object'
             or octet_length(v_module::text)>180000 then
            raise exception 'builder_module_invalid';
          end if;
        end loop;
      end loop;
    end if;
  end loop;

  return jsonb_build_object(
    'schemaVersion',1,
    'settings',case
      when jsonb_typeof(v_document->'settings')='object'
      then v_document->'settings'
      else jsonb_build_object('contentWidth','wide','background','#ffffff','customCss','')
    end,
    'blocks',v_blocks
  );
end;
$$;

revoke all on function private_app.website_builder_validate_document(jsonb)
from public,anon,authenticated;

commit;
