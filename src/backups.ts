import JSZip from 'jszip';
import type { AppData, Statement } from './model';
import { migrateData, sameMerchantRuleMatch } from './transactions';

export function statementPdfPath(statement:Pick<Statement,'cardId'|'periodEnd'|'id'>){
 return `statements/${statement.cardId}/${statement.periodEnd||statement.id}.pdf`;
}

export async function createBackup(data:AppData){
 const zip=new JSZip();
 zip.file('cardvault.json',JSON.stringify({version:1,exportedAt:new Date().toISOString(),data:{...data,statements:data.statements.map(({pdf,...statement})=>statement)}},null,2));
 for(const statement of data.statements)if(statement.pdf instanceof Blob&&statement.pdf.size>0)zip.file(statementPdfPath(statement),statement.pdf);
 return zip.generateAsync({type:'blob'});
}

export async function readBackup(file:Blob){
 const zip=await JSZip.loadAsync(file);const raw=zip.file('cardvault.json');
 if(!raw)throw new Error('Backup is missing cardvault.json');
 const payload=JSON.parse(await raw.async('text'));
 if(payload.version!==1||!payload.data?.cards||!payload.data?.statements)throw new Error('Unsupported or invalid CardVault backup.');
 const data=migrateData(payload.data as Partial<AppData>&Pick<AppData,'cards'|'statements'>);let missingPdfCount=0;
 const statements=await Promise.all(data.statements.map(async statement=>{
  const entry=zip.file(statementPdfPath(statement));const pdf=entry?await entry.async('blob'):new Blob([],{type:'application/pdf'});
  if(statement.fileName!=='Manual statement summary'&&pdf.size===0)missingPdfCount++;
  return {...statement,pdf};
 }));
 return {data:{...data,statements},missingPdfCount};
}

export function mergeBackupData(current:AppData,incoming:AppData):AppData{
 const statements=[...current.statements.map(saved=>{
  const source=incoming.statements.find(statement=>statement.hash===saved.hash);
  return source&&!(saved.pdf instanceof Blob&&saved.pdf.size>0)&&source.pdf instanceof Blob&&source.pdf.size>0?{...saved,pdf:source.pdf,pdfId:saved.pdfId??source.pdfId}:saved;
 }),...incoming.statements.filter(statement=>!current.statements.some(saved=>saved.hash===statement.hash))];
 return {...current,
  cards:[...current.cards,...incoming.cards.filter(card=>!current.cards.some(saved=>saved.id===card.id))],
  statements,
  categories:[...new Set([...current.categories,...incoming.categories])],
  merchantRules:[...current.merchantRules,...incoming.merchantRules.filter(rule=>!current.merchantRules.some(saved=>saved.id===rule.id||sameMerchantRuleMatch(saved,rule)))],
  changeHistory:[...(current.changeHistory??[]),...(incoming.changeHistory??[]).filter(entry=>!current.changeHistory?.some(saved=>saved.id===entry.id))].slice(-100),
  merchantGroups:[...(current.merchantGroups??[]),...(incoming.merchantGroups??[]).filter(group=>!current.merchantGroups?.some(saved=>saved.id===group.id))],
  priceAlertDecisions:{...(incoming.priceAlertDecisions??{}),...(current.priceAlertDecisions??{})},
  recurringAmountOverrides:{...(incoming.recurringAmountOverrides??{}),...(current.recurringAmountOverrides??{})},
  recurringDecisions:{...(incoming.recurringDecisions??{}),...(current.recurringDecisions??{})},
  dataVersion:2,
 };
}
