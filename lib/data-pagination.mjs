export const DEFAULT_DATA_PAGE_SIZE=25;
export const DATA_PAGE_SIZES=Object.freeze([25,50,100]);

function safeInteger(value,fallback=0){
  const parsed=Number(value);
  return Number.isFinite(parsed)
    ?Math.max(0,Math.floor(parsed))
    :fallback;
}

export function normalizeDataPageSize(value){
  const parsed=safeInteger(value,DEFAULT_DATA_PAGE_SIZE);
  return DATA_PAGE_SIZES.includes(parsed)
    ?parsed
    :DEFAULT_DATA_PAGE_SIZE;
}

export function dataPageRange(total,page=1,pageSize=DEFAULT_DATA_PAGE_SIZE){
  const safeTotal=safeInteger(total,0);
  const safePageSize=normalizeDataPageSize(pageSize);
  const totalPages=Math.max(1,Math.ceil(safeTotal/safePageSize));
  const requestedPage=Math.max(1,safeInteger(page,1));
  const currentPage=Math.min(requestedPage,totalPages);
  const start=safeTotal===0?0:(currentPage-1)*safePageSize;
  const end=Math.min(start+safePageSize,safeTotal);

  return {
    total:safeTotal,
    totalPages,
    page:currentPage,
    pageSize:safePageSize,
    start,
    end,
    from:safeTotal===0?0:start+1,
    to:end,
    hasPrevious:currentPage>1,
    hasNext:currentPage<totalPages
  };
}

export function dataPaginationTokens(page,totalPages){
  const safeTotalPages=Math.max(1,safeInteger(totalPages,1));
  const safePage=Math.min(
    Math.max(1,safeInteger(page,1)),
    safeTotalPages
  );

  if(safeTotalPages<=7){
    return Array.from({length:safeTotalPages},(_,index)=>index+1);
  }

  const pages=new Set([1,safeTotalPages,safePage-1,safePage,safePage+1]);

  if(safePage<=3){
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if(safePage>=safeTotalPages-2){
    pages.add(safeTotalPages-1);
    pages.add(safeTotalPages-2);
    pages.add(safeTotalPages-3);
  }

  const ordered=[...pages]
    .filter(value=>value>=1&&value<=safeTotalPages)
    .sort((left,right)=>left-right);
  const tokens=[];

  ordered.forEach((value,index)=>{
    const previous=ordered[index-1];
    if(index>0&&value-previous>1){
      tokens.push(`ellipsis-${previous}-${value}`);
    }
    tokens.push(value);
  });

  return tokens;
}
