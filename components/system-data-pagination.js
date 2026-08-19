'use client';

import {useEffect} from 'react';
import {
  DATA_PAGE_SIZES,
  DEFAULT_DATA_PAGE_SIZE,
  dataPageRange,
  dataPaginationTokens,
  normalizeDataPageSize
} from '../lib/data-pagination.mjs';

const TARGET_SELECTOR='table.mt-table,[data-pagination="list"]';
const TABLE_SELECTOR='table.mt-table';
const CONTROL_CLASS='mt-data-pagination';
const OWNED_HIDDEN_ATTRIBUTE='data-mt-pagination-hidden';
const PREFERENCE_KEY='marktone:data-page-size:v1';

function arabicNumber(value){
  return Number(value||0).toLocaleString('ar-SA');
}

function readPreferredPageSize(){
  try{
    return normalizeDataPageSize(window.localStorage.getItem(PREFERENCE_KEY));
  }catch{
    return DEFAULT_DATA_PAGE_SIZE;
  }
}

function savePreferredPageSize(value){
  try{
    window.localStorage.setItem(PREFERENCE_KEY,String(value));
  }catch{
    // Storage can be disabled without affecting pagination.
  }
}

function targetItems(target){
  if(target.matches(TABLE_SELECTOR)){
    return Array.from(target.tBodies)
      .flatMap(body=>Array.from(body.rows))
      .filter(row=>!row.hasAttribute('data-pagination-ignore'));
  }

  const selector=target.getAttribute('data-pagination-item-selector');
  if(selector){
    try{
      return Array.from(target.querySelectorAll(selector)).filter(item=>
        item.closest('[data-pagination="list"]')===target
        &&!item.hasAttribute('data-pagination-ignore')
      );
    }catch{
      // Fall back to direct children when a custom selector is invalid.
    }
  }

  return Array.from(target.children).filter(item=>
    !item.hasAttribute('data-pagination-ignore')
    &&!item.classList.contains(CONTROL_CLASS)
  );
}

function managedItems(target){
  return targetItems(target).filter(item=>
    !item.hidden||item.hasAttribute(OWNED_HIDDEN_ATTRIBUTE)
  );
}

function restoreOwnedItems(items){
  items.forEach(item=>{
    if(!item.hasAttribute(OWNED_HIDDEN_ATTRIBUTE))return;
    item.hidden=false;
    item.removeAttribute(OWNED_HIDDEN_ATTRIBUTE);
  });
}

function itemIdentity(item){
  return item.getAttribute('data-pagination-key')
    ||item.getAttribute('data-row-id')
    ||item.id
    ||item.querySelector('[data-id]')?.getAttribute('data-id')
    ||item.querySelector('input[aria-label]')?.getAttribute('aria-label')
    ||String(item.textContent||'').replace(/\s+/g,' ').trim().slice(0,120);
}

function targetSignature(items){
  if(!items.length)return '0';
  const middle=items[Math.floor(items.length/2)];
  return [
    items.length,
    itemIdentity(items[0]),
    itemIdentity(middle),
    itemIdentity(items[items.length-1])
  ].join('|');
}

function shouldManage(target){
  if(target.matches('[data-pagination="off"],[data-no-pagination]'))return false;
  if(target.closest('[data-pagination-scope="off"],[data-no-pagination-scope]')){
    return false;
  }
  return true;
}

function scrollToTarget(target){
  const anchor=target.closest('.mt-panel,section,article')||target;
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  anchor.scrollIntoView({
    behavior:reduced?'auto':'smooth',
    block:'start'
  });
}

function createPageButton(page,currentPage){
  const button=document.createElement('button');
  button.type='button';
  button.className='mt-data-pagination__page';
  button.dataset.paginationPage=String(page);
  button.textContent=arabicNumber(page);
  button.setAttribute('aria-label',`الانتقال إلى الصفحة ${arabicNumber(page)}`);
  if(page===currentPage){
    button.classList.add('active');
    button.setAttribute('aria-current','page');
  }
  return button;
}

function createControl(target,record,renderTarget){
  const nav=document.createElement('nav');
  nav.className=CONTROL_CLASS;
  nav.setAttribute('aria-label','التنقل بين صفحات البيانات');

  const summary=document.createElement('div');
  summary.className='mt-data-pagination__summary';
  summary.setAttribute('aria-live','polite');

  const actions=document.createElement('div');
  actions.className='mt-data-pagination__actions';

  const previous=document.createElement('button');
  previous.type='button';
  previous.className='mt-data-pagination__nav';
  previous.dataset.paginationAction='previous';
  previous.textContent='السابق';

  const pages=document.createElement('div');
  pages.className='mt-data-pagination__pages';

  const next=document.createElement('button');
  next.type='button';
  next.className='mt-data-pagination__nav';
  next.dataset.paginationAction='next';
  next.textContent='التالي';

  actions.append(previous,pages,next);

  const pageSizeLabel=document.createElement('label');
  pageSizeLabel.className='mt-data-pagination__size';
  const labelText=document.createElement('span');
  labelText.textContent='عدد النتائج';
  const pageSize=document.createElement('select');
  pageSize.setAttribute('aria-label','عدد النتائج في الصفحة');
  DATA_PAGE_SIZES.forEach(value=>{
    const option=document.createElement('option');
    option.value=String(value);
    option.textContent=arabicNumber(value);
    pageSize.append(option);
  });
  pageSizeLabel.append(labelText,pageSize);

  nav.append(summary,actions,pageSizeLabel);

  nav.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button||!nav.contains(button)||button.disabled)return;

    const requestedPage=button.dataset.paginationPage;
    if(requestedPage){
      record.page=Number(requestedPage);
    }else if(button.dataset.paginationAction==='previous'){
      record.page-=1;
    }else if(button.dataset.paginationAction==='next'){
      record.page+=1;
    }else{
      return;
    }

    renderTarget(target,record);
    scrollToTarget(target);
  });

  pageSize.addEventListener('change',()=>{
    record.pageSize=normalizeDataPageSize(pageSize.value);
    record.page=1;
    savePreferredPageSize(record.pageSize);
    renderTarget(target,record);
    scrollToTarget(target);
  });

  return {nav,summary,actions,pages,previous,next,pageSize};
}

export default function SystemDataPagination(){
  useEffect(()=>{
    const records=new Map();
    let frame=null;

    function controlAnchor(target){
      return target.matches(TABLE_SELECTOR)
        ?target.closest('.mt-table-wrap')||target
        :target;
    }

    function ensureControl(target,record){
      if(!record.control){
        record.control=createControl(target,record,renderTarget);
      }
      if(!record.control.nav.isConnected){
        const anchor=controlAnchor(target);
        anchor.parentElement?.insertBefore(record.control.nav,anchor.nextSibling);
      }
      target.setAttribute('data-pagination-active','true');
    }

    function removeControl(target,record){
      record.control?.nav.remove();
      target.removeAttribute('data-pagination-active');
    }

    function renderPages(record,range){
      const nodes=dataPaginationTokens(range.page,range.totalPages).map(token=>{
        if(typeof token==='number')return createPageButton(token,range.page);
        const ellipsis=document.createElement('span');
        ellipsis.className='mt-data-pagination__ellipsis';
        ellipsis.textContent='…';
        ellipsis.setAttribute('aria-hidden','true');
        return ellipsis;
      });
      record.control.pages.replaceChildren(...nodes);
    }

    function renderTarget(target,record){
      const allItems=targetItems(target);
      const items=managedItems(target);

      if(record.printing){
        restoreOwnedItems(allItems);
        return;
      }

      const threshold=Math.max(
        1,
        Number(target.getAttribute('data-pagination-threshold'))
          ||DEFAULT_DATA_PAGE_SIZE
      );
      const signature=targetSignature(items);

      if(record.signature&&record.signature!==signature){
        record.page=1;
      }
      record.signature=signature;

      if(items.length<=threshold){
        restoreOwnedItems(allItems);
        record.page=1;
        removeControl(target,record);
        return;
      }

      ensureControl(target,record);
      const range=dataPageRange(items.length,record.page,record.pageSize);
      record.page=range.page;
      record.pageSize=range.pageSize;

      items.forEach((item,index)=>{
        const hidden=index<range.start||index>=range.end;
        if(hidden){
          if(!item.hidden){
            item.hidden=true;
            item.setAttribute(OWNED_HIDDEN_ATTRIBUTE,'true');
          }
          return;
        }
        if(item.hasAttribute(OWNED_HIDDEN_ATTRIBUTE)){
          item.hidden=false;
          item.removeAttribute(OWNED_HIDDEN_ATTRIBUTE);
        }
      });

      record.control.summary.textContent=
        `عرض ${arabicNumber(range.from)}–${arabicNumber(range.to)} من ${arabicNumber(range.total)}`;
      record.control.previous.disabled=!range.hasPrevious;
      record.control.next.disabled=!range.hasNext;
      record.control.previous.setAttribute(
        'aria-label',
        `الصفحة السابقة؛ الصفحة الحالية ${arabicNumber(range.page)} من ${arabicNumber(range.totalPages)}`
      );
      record.control.next.setAttribute(
        'aria-label',
        `الصفحة التالية؛ الصفحة الحالية ${arabicNumber(range.page)} من ${arabicNumber(range.totalPages)}`
      );
      record.control.pageSize.value=String(range.pageSize);
      renderPages(record,range);
    }

    function cleanupRecord(target,record){
      restoreOwnedItems(targetItems(target));
      removeControl(target,record);
      records.delete(target);
    }

    function scan(){
      frame=null;
      const targets=new Set(
        Array.from(document.querySelectorAll(TARGET_SELECTOR)).filter(shouldManage)
      );

      records.forEach((record,target)=>{
        if(!targets.has(target)||!target.isConnected){
          cleanupRecord(target,record);
        }
      });

      targets.forEach(target=>{
        let record=records.get(target);
        if(!record){
          const requested=target.getAttribute('data-page-size');
          record={
            page:1,
            pageSize:requested
              ?normalizeDataPageSize(requested)
              :readPreferredPageSize(),
            signature:'',
            printing:false,
            control:null
          };
          records.set(target,record);
        }
        renderTarget(target,record);
      });
    }

    function scheduleScan(){
      if(frame!==null)return;
      frame=window.requestAnimationFrame(scan);
    }

    function mutationNeedsScan(mutation){
      const target=mutation.target.nodeType===Node.ELEMENT_NODE
        ?mutation.target
        :mutation.target.parentElement;
      if(target?.closest(`.${CONTROL_CLASS}`))return false;
      if(target?.closest(TARGET_SELECTOR))return true;

      return [...mutation.addedNodes,...mutation.removedNodes].some(node=>{
        if(node.nodeType!==Node.ELEMENT_NODE)return false;
        return node.matches?.(TARGET_SELECTOR)
          ||Boolean(node.querySelector?.(TARGET_SELECTOR));
      });
    }

    const observer=new MutationObserver(mutations=>{
      if(mutations.some(mutationNeedsScan))scheduleScan();
    });
    observer.observe(document.body,{
      childList:true,
      subtree:true,
      characterData:true
    });

    function resetAfterFilter(event){
      const element=event.target;
      if(!(element instanceof HTMLElement))return;
      if(element.closest(`.${CONTROL_CLASS}`)||element.closest('tbody'))return;
      if(element instanceof HTMLInputElement
        &&['checkbox','radio','file','button','submit','reset'].includes(element.type)){
        return;
      }
      records.forEach(record=>{record.page=1});
      window.setTimeout(scheduleScan,0);
    }

    function beforePrint(){
      records.forEach((record,target)=>{
        record.printing=true;
        restoreOwnedItems(targetItems(target));
      });
    }

    function afterPrint(){
      records.forEach(record=>{record.printing=false});
      scheduleScan();
    }

    document.addEventListener('input',resetAfterFilter,true);
    document.addEventListener('change',resetAfterFilter,true);
    window.addEventListener('beforeprint',beforePrint);
    window.addEventListener('afterprint',afterPrint);
    scheduleScan();

    return ()=>{
      observer.disconnect();
      document.removeEventListener('input',resetAfterFilter,true);
      document.removeEventListener('change',resetAfterFilter,true);
      window.removeEventListener('beforeprint',beforePrint);
      window.removeEventListener('afterprint',afterPrint);
      if(frame!==null)window.cancelAnimationFrame(frame);
      records.forEach((record,target)=>cleanupRecord(target,record));
    };
  },[]);

  return null;
}
