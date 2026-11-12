import { openDB } from 'idb';
import { emptyData } from './model';
import { migrateData } from './transactions';
import type { AppData } from './model';
const DB='cardvault-local', VERSION=1;
// Schema changes must increment VERSION and extend this upgrade callback. Never
// clear existing stores during an upgrade: users' local records are the database.
const dbPromise=openDB(DB,VERSION,{upgrade(db,oldVersion){if(oldVersion<1){if(!db.objectStoreNames.contains('app'))db.createObjectStore('app');if(!db.objectStoreNames.contains('files'))db.createObjectStore('files');}}});
export async function loadData():Promise<AppData>{const db=await dbPromise;const saved=await db.get('app','data');return saved?migrateData(saved):emptyData;}
export async function saveData(data:AppData){const db=await dbPromise;await db.put('app',data,'data');}
