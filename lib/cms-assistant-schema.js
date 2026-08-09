import {z} from 'zod';

const SIMPLE_VALUE=z.union([z.string().max(5000),z.number(),z.boolean(),z.null()]);
const COLLECTION_ITEM=z.object({
  title:z.string().max(500).nullable(),description:z.string().max(1200).nullable(),
  label:z.string().max(500).nullable(),value:z.string().max(500).nullable(),
  icon:z.string().max(100).nullable(),href:z.string().max(800).nullable(),
  name:z.string().max(500).nullable(),role:z.string().max(500).nullable(),
  quote:z.string().max(1200).nullable()
});
const CONTENT_VALUE=z.union([
  SIMPLE_VALUE,
  z.array(SIMPLE_VALUE).max(24),
  z.array(COLLECTION_ITEM).max(24)
]);
const BLOCK_TARGET=z.object({kind:z.literal('block'),blockId:z.string().min(1).max(140)});
const ROW_TARGET=z.object({kind:z.literal('row'),rowId:z.string().min(1).max(140)});
const COLUMN_TARGET=z.object({kind:z.literal('column'),rowId:z.string().min(1).max(140),columnId:z.string().min(1).max(140)});
const MODULE_TARGET=z.object({kind:z.literal('module'),rowId:z.string().min(1).max(140),columnId:z.string().min(1).max(140),moduleId:z.string().min(1).max(140)});
const TARGET=z.discriminatedUnion('kind',[BLOCK_TARGET,ROW_TARGET,COLUMN_TARGET,MODULE_TARGET]);
const CONTENT_FIELD=z.enum([
  'eyebrow','title','body','content','label','primaryLabel','secondaryLabel','primaryHref',
  'secondaryHref','href','imageUrl','imageAlt','icon','accent','author','role','quote',
  'badge','name','value','suffix','description','items','features','bullets','logos','tabs',
  'steps','stats','testimonials'
]);
const STYLE_FIELD=z.enum([
  'variant','align','paddingY','maxWidth','background','color','borderColor','borderWidth',
  'borderRadius','shadow','animation','animationDelay','cssClass','gap','padding','minHeight','verticalAlign'
]);
const RESPONSIVE_FIELD=z.enum(['hideDesktop','hideTablet','hideMobile']);
const CONTENT_ENTRY=z.object({field:CONTENT_FIELD,value:CONTENT_VALUE});
const STYLE_ENTRY=z.object({field:STYLE_FIELD,value:SIMPLE_VALUE});
const RESPONSIVE_ENTRY=z.object({field:RESPONSIVE_FIELD,value:z.boolean()});
const MODULE_DEFINITION=z.object({
  columnIndex:z.number().int().min(0).max(5),
  moduleType:z.string().min(1).max(60),
  content:z.array(CONTENT_ENTRY).max(24),
  styles:z.array(STYLE_ENTRY).max(24),
  responsive:z.array(RESPONSIVE_ENTRY).max(3)
});
const OPERATION=z.discriminatedUnion('type',[
  z.object({type:z.literal('set_content'),target:TARGET,field:CONTENT_FIELD,value:CONTENT_VALUE}),
  z.object({type:z.literal('set_style'),target:TARGET,field:STYLE_FIELD,value:SIMPLE_VALUE}),
  z.object({type:z.literal('set_responsive'),target:TARGET,field:RESPONSIVE_FIELD,value:z.boolean()}),
  z.object({type:z.literal('set_page'),field:z.enum(['direction','theme','background','contentWidth','fontScale']),value:SIMPLE_VALUE}),
  z.object({
    type:z.literal('insert_module'),rowId:z.string().min(1).max(140),columnId:z.string().min(1).max(140),
    afterModuleId:z.string().max(140).nullable(),moduleType:z.string().min(1).max(60),
    content:z.array(CONTENT_ENTRY).max(24),styles:z.array(STYLE_ENTRY).max(24),
    responsive:z.array(RESPONSIVE_ENTRY).max(3)
  }),
  z.object({
    type:z.literal('insert_section'),layoutKey:z.string().min(1).max(30),afterRowId:z.string().max(140).nullable(),
    modules:z.array(MODULE_DEFINITION).min(1).max(8)
  }),
  z.object({type:z.literal('delete_node'),target:z.discriminatedUnion('kind',[BLOCK_TARGET,ROW_TARGET,MODULE_TARGET])})
]);

export const CMS_ASSISTANT_PROPOSAL_SCHEMA=z.object({
  summary:z.string().min(3).max(240),
  rationale:z.string().min(3).max(500),
  changes:z.array(z.string().min(2).max(220)).min(1).max(12),
  warnings:z.array(z.string().min(2).max(220)).max(6),
  operations:z.array(OPERATION).min(1).max(18)
});
