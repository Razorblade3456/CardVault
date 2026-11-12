export function normalizeCategoryName(value:string){return value.trim().replace(/\s+/g,' ').toLocaleLowerCase()}

export function uniqueCategoryNames(values:string[],currentValue=''){
  const result:string[]=[];const seen=new Set<string>();
  for(const raw of [...values,currentValue,'Uncategorized']){const value=raw.trim().replace(/\s+/g,' ');const key=normalizeCategoryName(value);if(value&&key&&!seen.has(key)){seen.add(key);result.push(value)}}
  return result;
}

export function filterCategoryNames(values:string[],query:string){
  const needle=normalizeCategoryName(query);return needle?values.filter(value=>normalizeCategoryName(value).includes(needle)):values;
}

export function categoryNavigationIndex(current:number,movement:'up'|'down'|'first'|'last',count:number){
  if(count<=0)return -1;if(movement==='first')return 0;if(movement==='last')return count-1;
  return movement==='down'?Math.min(count-1,Math.max(0,current+1)):Math.max(0,Math.min(count-1,current-1));
}

export function categoryPopupPosition(rect:{left:number;top:number;bottom:number;width:number},viewport:{width:number;height:number},desiredHeight=280){
  const width=Math.min(Math.max(rect.width,220),Math.max(180,viewport.width-16));
  const left=Math.min(Math.max(8,rect.left),Math.max(8,viewport.width-width-8));
  const below=viewport.height-rect.bottom-8;const above=rect.top-8;const opensUp=below<Math.min(desiredHeight,180)&&above>below;
  const maxHeight=Math.max(100,Math.min(desiredHeight,opensUp?above:below));
  return {left,width,maxHeight,opensUp,top:opensUp?undefined:Math.max(8,Math.min(rect.bottom+6,viewport.height-maxHeight-8)),bottom:opensUp?Math.max(8,viewport.height-rect.top+6):undefined};
}
