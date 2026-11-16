import { openDB } from 'idb';
import { emptyData } from './model';
import { migrateData } from './transactions';
import type { AppData, Statement } from './model';

const DB='cardvault-local', VERSION=2;
type StoredStatement=Omit<Statement,'pdf'> & {pdf?:Blob;pdfId:string};
type StoredData=Omit<AppData,'statements'> & {statements:StoredStatement[]};

// The database name is intentionally stable so upgrades keep the user's data.
// IndexedDB is origin-scoped: another Netlify hostname has a separate database.
const dbPromise=openDB(DB,VERSION,{upgrade(db,oldVersion){if(oldVersion<1){if(!db.objectStoreNames.contains('app'))db.createObjectStore('app');if(!db.objectStoreNames.contains('files'))db.createObjectStore('files');}if(!db.objectStoreNames.contains('files'))db.createObjectStore('files');}});

function pdfKey(statement:Statement){return statement.pdfId||`statement-pdf:${statement.id}`}
function usableBlob(value:unknown):value is Blob{return typeof Blob!=='undefined'&&value instanceof Blob&&value.size>0}

export async function loadData():Promise<AppData>{
 const db=await dbPromise;const saved=await db.get('app','data') as AppData|undefined;if(!saved)return emptyData;
 const statements=await Promise.all((saved.statements??[]).map(async statement=>{
  const row=statement as Statement;let pdf:unknown;
  if(row.pdfId)pdf=await db.get('files',row.pdfId);
  if(!usableBlob(pdf)&&usableBlob(row.pdf))pdf=row.pdf;
  return {...row,pdf:usableBlob(pdf)?pdf:new Blob([],{type:'application/pdf'}),pdfId:row.pdfId||`statement-pdf:${row.id}`} as Statement;
 }));
 return migrateData({...saved,statements});
}

// Serialize writes so a slower save from an earlier React render cannot replace
// a newer archive snapshot. App data and PDF blobs are committed atomically.
let saveQueue:Promise<void>=Promise.resolve();
export function saveData(data:AppData):Promise<void>{
 const write=saveQueue.then(()=>saveSnapshot(data));
 saveQueue=write.catch(()=>{});
 return write;
}

async function saveSnapshot(data:AppData){
 const db=await dbPromise;const tx=db.transaction(['app','files'],'readwrite');const app=tx.objectStore('app');const files=tx.objectStore('files');
 try{
  const previous=await app.get('data') as StoredData|AppData|undefined;
  const storedStatements:StoredStatement[]=data.statements.map(statement=>{const {pdf,...rest}=statement;return {...rest,pdfId:pdfKey(statement)} as StoredStatement});
  const stored:StoredData={...data,statements:storedStatements};
  const activeKeys=new Set(storedStatements.map(statement=>statement.pdfId));
  for(const statement of data.statements){
   const key=pdfKey(statement);
   if(usableBlob(statement.pdf)){
    const old=previous?.statements.find(row=>row.id===statement.id) as StoredStatement|undefined;
    const existing=await files.get(key);
    if(!usableBlob(existing)||existing.size!==statement.pdf.size||old?.hash!==statement.hash||old?.pdfId!==key){
     await files.put(statement.pdf,key);
     const verified=await files.get(key);
     if(!usableBlob(verified)||verified.size!==statement.pdf.size)throw new Error(`PDF storage verification failed for ${statement.fileName}.`);
    }
   }
  }
  for(const old of previous?.statements??[]){const key=(old as StoredStatement).pdfId||`statement-pdf:${old.id}`;if(!activeKeys.has(key))await files.delete(key)}
  await app.put(stored,'data');
  await tx.done;
 }catch(error){try{tx.abort()}catch{};await tx.done.catch(()=>{});throw error}
}
