import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  DATA_PAGE_SIZES,
  DEFAULT_DATA_PAGE_SIZE,
  dataPageRange,
  dataPaginationTokens,
  normalizeDataPageSize
} from '../lib/data-pagination.mjs';

const root=new URL('../',import.meta.url);

async function source(path){
  return readFile(new URL(path,root),'utf8');
}

test('data pagination defaults to 25 rows and clamps the final page',()=>{
  assert.equal(DEFAULT_DATA_PAGE_SIZE,25);
  assert.deepEqual(DATA_PAGE_SIZES,[25,50,100]);
  assert.equal(normalizeDataPageSize('50'),50);
  assert.equal(normalizeDataPageSize('13'),25);

  assert.deepEqual(dataPageRange(591,1,25),{
    total:591,
    totalPages:24,
    page:1,
    pageSize:25,
    start:0,
    end:25,
    from:1,
    to:25,
    hasPrevious:false,
    hasNext:true
  });

  assert.deepEqual(dataPageRange(591,99,25),{
    total:591,
    totalPages:24,
    page:24,
    pageSize:25,
    start:575,
    end:591,
    from:576,
    to:591,
    hasPrevious:true,
    hasNext:false
  });
});

test('page number window remains compact for long datasets',()=>{
  assert.deepEqual(dataPaginationTokens(1,4),[1,2,3,4]);
  assert.deepEqual(dataPaginationTokens(6,12),[
    1,
    'ellipsis-1-5',
    5,
    6,
    7,
    'ellipsis-7-12',
    12
  ]);
});

test('the root layout enables one reusable paginator for current and future data tables',async()=>{
  const [layout,component,css]=await Promise.all([
    source('app/layout.js'),
    source('components/system-data-pagination.js'),
    source('app/data-pagination.css')
  ]);

  assert.match(layout,/SystemDataPagination/);
  assert.match(layout,/data-pagination\.css/);
  assert.match(component,/table\.mt-table/);
  assert.match(component,/MutationObserver/);
  assert.match(component,/عرض \$\{arabicNumber\(range\.from\)\}/);
  assert.match(component,/textContent='السابق'/);
  assert.match(component,/textContent='التالي'/);
  assert.match(component,/beforeprint/);
  assert.match(component,/afterprint/);
  assert.match(css,/\.mt-data-pagination/);
  assert.match(css,/@media print/);
});
