import assert from 'node:assert/strict';
import test from 'node:test';
import {applyCmsAssistantOperations,compactCmsDocument} from '../lib/cms-assistant-operations.mjs';

function fixture(){
  return {
    settings:{direction:'rtl'},
    blocks:[{
      id:'row-1',type:'columns',props:{row:true,layoutKey:'1',items:[{
        id:'column-1',modules:[{id:'module-1',type:'heading',props:{title:'قديم'},style:{paddingY:20},responsive:{}}]
      }]},style:{},responsive:{}
    }]
  };
}
const helpers={
  createModule:(type,definition)=>({id:`module-${type}`,type,props:definition.props,style:definition.style,responsive:definition.responsive}),
  createRow:(layoutKey)=>({id:'row-new',type:'columns',props:{row:true,layoutKey,items:[{id:'column-new',modules:[]}]},style:{},responsive:{}})
};

test('assistant operations update content and design without mutating source',()=>{
  const source=fixture();
  const result=applyCmsAssistantOperations(source,[
    {type:'set_content',target:{kind:'module',rowId:'row-1',columnId:'column-1',moduleId:'module-1'},field:'title',value:'عنوان جديد'},
    {type:'set_style',target:{kind:'row',rowId:'row-1'},field:'background',value:'#071b30'}
  ],helpers);
  assert.equal(source.blocks[0].props.items[0].modules[0].props.title,'قديم');
  assert.equal(result.document.blocks[0].props.items[0].modules[0].props.title,'عنوان جديد');
  assert.equal(result.document.blocks[0].style.background,'#071b30');
  assert.deepEqual(result.applied,[0,1]);
});

test('assistant rejects raw html fields while preserving valid operations',()=>{
  const result=applyCmsAssistantOperations(fixture(),[
    {type:'set_content',target:{kind:'module',rowId:'row-1',columnId:'column-1',moduleId:'module-1'},field:'html',value:'<script>alert(1)</script>'},
    {type:'set_responsive',target:{kind:'module',rowId:'row-1',columnId:'column-1',moduleId:'module-1'},field:'hideMobile',value:true}
  ],helpers);
  assert.equal(result.rejected.length,1);
  assert.equal(result.document.blocks[0].props.items[0].modules[0].responsive.hideMobile,true);
  assert.equal(result.document.blocks[0].props.items[0].modules[0].props.html,undefined);
});

test('assistant can add an editable builder section',()=>{
  const result=applyCmsAssistantOperations(fixture(),[{
    type:'insert_section',layoutKey:'1',afterRowId:'row-1',modules:[
      {columnIndex:0,moduleType:'text',content:[{field:'content',value:'محتوى جديد'}],styles:[{field:'paddingY',value:30}],responsive:[]}
    ]
  }],helpers);
  assert.equal(result.document.blocks.length,2);
  assert.equal(result.document.blocks[1].props.items[0].modules[0].props.content,'محتوى جديد');
});

test('assistant context compaction limits untrusted page payloads',()=>{
  const compact=compactCmsDocument({body:'x'.repeat(5000),items:Array.from({length:100},(_,index)=>index)},{maxString:100,maxArray:10});
  assert.equal(compact.body.length,100);
  assert.equal(compact.items.length,10);
});
