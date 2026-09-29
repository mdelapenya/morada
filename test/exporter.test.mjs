import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportToday, expressions, parseActivityDate, resolveMessages, projectPeriodMessages } from '../scripts/exporter.mjs';
import { fingerprintMessageHistory } from '../scripts/message-history.mjs';

const card=(id,date='12:30')=>({id,name:`Persona ${id}`,date,ad:'825 €/mes - Piso de prueba'});
const snapshot=(id,properties=[{url:'https://www.idealista.com/inmueble/13579135/',text:'Anuncio'}],rawText='Hola')=>({activeId:id,name:`Persona ${id}`,messages:[{sequence:1,dateLabel:'Hoy',time:'12:30',author:'Persona',direction:'received',text:rawText,embeddedProfile:null,rawText,attachments:[],media:[],domClass:''}],historyText:rawText,properties,scroll:{top:0,height:100,total:100},historyButtons:[],profileAvailable:false});
function fake({pages=[[card('1'),card('2')],[card('3'),{id:'0',date:'Ayer',ad:'otro'}]],draft=false,readyAfter=0,day='2026-09-23',propertyById={},messageById={},messagesById={},unstableHistoryIds=[],dateLoadingReads=0,loadingReads=0,loadingAfterOpens=Infinity,appendPageAfterReads=Infinity,appendPage=null,transientHistorySnapshot=false,switchedHistoryId=null,moveHeadAfterOpens=Infinity,moveHeadAgainAfterOpens=Infinity,failIfTailAfterOpens=Infinity}={}){
  let page=0,active=null,reloaded=false,readyCalls=0,historyReads=0,cardReads=0,historyTopCalls=0,pendingSnapshot=null,opens=0;const calls=[];
  const ev=expression=>{
    calls.push(expression);
    if(expression===expressions.draft)return {draft,blocked:false};
    if(expression===expressions.visibility)return 'visible';
    if(expression===expressions.reload){reloaded=true;return true;}
    if(expression===expressions.ready)return {ready:reloaded&&readyCalls++>=readyAfter,login:false,blocked:false};
    if(expression===expressions.selectAll)return true;
    if(expression===expressions.day)return day;
    if(expression===expressions.closeProfile)return true;
    if(expression===expressions.listTop){page=0;return true;}
    if(expression===expressions.listStep){if(opens>=failIfTailAfterOpens)throw new Error('Scanned the tail after the unchanged streak');page=Math.min(page+1,pages.length-1);return true;}
    if(expression===expressions.cards){
      cardReads++;
      if(cardReads===appendPageAfterReads && appendPage)pages.push(appendPage);
      return {referenceDay:day,cards:cardReads<=dateLoadingReads?pages[page].map((c,i)=>i?c:{...c,date:''}):pages[page],loading:cardReads<=loadingReads||opens>=loadingAfterOpens,scroll:{top:page*80,height:100,total:pages.length*80+20}};
    }
    if(expression.includes('button[data-testid="list-card-test-id"]')){const id=expression.match(/dataset.conversationId==="(\d+)"/)?.[1];assert.ok(pages[page].some(c=>c.id===id));active=id;opens++;if(opens===moveHeadAfterOpens)pages[0].unshift(card('8','12:31'));if(opens===moveHeadAgainAfterOpens)pages[0].unshift(card('9','12:32'));return true;}
    if(expression===expressions.snapshot){
      if(pendingSnapshot){const kind=pendingSnapshot;pendingSnapshot=null;return kind==='missing'?null:{...snapshot(active,propertyById[active],messageById[active]),activeId:kind};}
      const current=snapshot(active,propertyById[active],unstableHistoryIds.includes(active)?`Update ${++historyReads}`:messageById[active]);
      return {...current,referenceDay:day,messages:messagesById[active]??current.messages};
    }
    if(expression===expressions.historyTop){
      if(++historyTopCalls===1)pendingSnapshot=switchedHistoryId??(transientHistorySnapshot?'missing':null);
      return true;
    }
    if(expression===expressions.historyBottom)return true;
    throw new Error(`Unexpected browser command: ${expression}`);
  };
  return {ev,calls};
}
async function inTemp(t,fn){const root=await mkdtemp(path.join(os.tmpdir(),'idealista-export-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return fn(root);}
const instant=async()=>{};

test('reloads before delayed fresh discovery, scans virtualized cards, and exports only unknown IDs sharing the same minute',async t=>inTemp(t,async root=>{
  const browser=fake({readyAfter:3});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,knownIds:['1','3']});
  assert.equal(result.discovered,3);
  assert.equal(result.candidates,1);
  assert.equal(result.exported,1);
  assert.deepEqual(result.files,[path.join(root,'exports','2026-09-23','2.json')]);
  assert.ok(browser.calls.indexOf(expressions.reload)<browser.calls.indexOf(expressions.cards));
  assert.equal(browser.calls.filter(x=>x===expressions.reload).length,1);
  assert.ok(browser.calls.filter(x=>x===expressions.ready).length>=4);
  assert.ok(browser.calls.indexOf(expressions.selectAll)<browser.calls.indexOf(expressions.cards));
  assert.equal(JSON.parse(await readFile(result.files[0],'utf8')).id,'2');
  assert.deepEqual((await readdir(path.dirname(result.files[0]))).filter(n=>/^\d+\.json$/.test(n)),['2.json']);
}));

test('returns a successful empty result when all IDs are known',async t=>inTemp(t,async root=>{
  const browser=fake();
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,knownIds:['1','2','3']});
  assert.deepEqual({candidates:result.candidates,exported:result.exported,files:result.files},{candidates:0,exported:0,files:[]});
  assert.ok(!browser.calls.includes(expressions.snapshot));
}));

test('draft prevents reload and releases extraction lock',async t=>inTemp(t,async root=>{
  const browser=fake({draft:true});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true}),/mensaje sin enviar/);
  assert.ok(!browser.calls.includes(expressions.reload));
  assert.ok(!(await readdir(root)).includes('extraction.lock'));
  const retry=fake();
  const result=await exportToday({root,connectBrowser:()=>retry.ev,wait:instant,sync:true,knownIds:['1','2','3']});
  assert.equal(result.exported,0);
}));

test('uncertain list limit fails instead of declaring success and releases lock',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1')],[card('2')],[card('3')]]});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,maxListSteps:2}),/No se pudo comprobar/);
  assert.ok(!(await readdir(root)).includes('extraction.lock'));
}));

test('concurrent extractor cannot control the same tab',async t=>inTemp(t,async root=>{
  let unblock;const waiting=new Promise(resolve=>unblock=resolve);
  let reachedWait;const entered=new Promise(resolve=>reachedWait=resolve);
  const browser=fake();
  const first=exportToday({root,connectBrowser:()=>browser.ev,wait:()=>{reachedWait();return waiting;},sync:true,knownIds:['1','2','3']});
  await entered;
  await assert.rejects(exportToday({root,connectBrowser:()=>fake().ev,wait:instant,sync:true}),/otra extracción/);
  unblock();await first;
}));

test('anchored range includes today and yesterday across virtualized snapshots, stops before older date',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',pages:[[card('1','09:42')],[card('2','Ayer')],[card('3','22/09/2026'),card('4','01/01/2025')]]});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,sinceDate:'2026-09-23'});
  assert.equal(result.date,'2026-09-24');
  assert.equal(result.discovered,2);
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json','2.json']);
  assert.equal(JSON.parse(await readFile(result.files[0],'utf8')).activityDate,'2026-09-24');
  assert.equal(JSON.parse(await readFile(result.files[1],'utf8')).activityDate,'2026-09-23');
  const index=JSON.parse(await readFile(path.join(root,'exports','2026-09-24','index.json'),'utf8'));
  assert.equal(index.sinceDate,'2026-09-23');
  assert.equal(index.conversations[1].activityDate,'2026-09-23');
}));

test('button-day window stays exact when Chrome reads the list after midnight',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',pages:[[card('1','00:05')],[card('2','Ayer')],[card('3','22/09/2026')]]});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,sinceDate:'2026-09-23',untilDate:'2026-09-23'});
  assert.deepEqual({date:result.date,sinceDate:result.sinceDate,untilDate:result.untilDate,discovered:result.discovered},
    {date:'2026-09-24',sinceDate:'2026-09-23',untilDate:'2026-09-23',discovered:1});
  assert.deepEqual(result.files.map(file=>path.basename(file)),['2.json']);
  assert.equal(JSON.parse(await readFile(result.files[0],'utf8')).activityDate,'2026-09-23');
}));

test('manual default still stops at yesterday on rollover',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',pages:[[card('1','09:42'),card('2','Ayer')]]});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant});
  assert.equal(result.discovered,1);
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json']);
}));

test('explicit previous-year date remains outside the anchored range',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',pages:[[card('1','09:42'),card('2','31/12/2025')]]});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,sinceDate:'2026-09-23'});
  assert.equal(result.discovered,1);
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json']);
}));

test('calendar parser handles new year and rejects invalid or unfamiliar labels',()=>{
  assert.equal(parseActivityDate('Ayer','2026-01-01'),'2025-12-31');
  assert.equal(parseActivityDate('31 dic.','2026-01-01'),'2025-12-31');
  assert.equal(parseActivityDate('30 sept.','2026-10-01'),'2026-09-30');
  assert.equal(parseActivityDate('23 sept.','2026-09-24'),'2026-09-23');
  assert.equal(parseActivityDate(' 23 sept. ','2026-09-24'),'2026-09-23');
  assert.equal(parseActivityDate('23 sept','2026-09-24'),'2026-09-23');
  assert.equal(parseActivityDate('23 sept. 2025','2026-09-24'),'2025-09-23');
  assert.equal(parseActivityDate('31/12/2025','2026-01-01'),'2025-12-31');
  assert.equal(parseActivityDate('23:59','2026-01-01'),'2026-01-01');
  for(const label of ['31/02/2026','31 feb.','31 feb. 2024','viernes','24:00','12:60'])assert.throws(()=>parseActivityDate(label,'2026-09-24'),/no se puede interpretar/);
  assert.throws(()=>parseActivityDate('viernes','2026-09-24'),/"viernes"/);
});

test('observed 23 sept. label is accepted after midnight and an empty loading label is retried',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',dateLoadingReads:2,pages:[[card('1','00:07')],[card('2','23 sept.')],[card('3','22 sept.')]]});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,sinceDate:'2026-09-23',untilDate:'2026-09-24',propertyId:'13579135',refreshExisting:true});
  assert.equal(result.discovered,2);
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json','2.json']);
  assert.equal(JSON.parse(await readFile(result.files[1],'utf8')).activityDate,'2026-09-23');
}));

test('late lazy page is collected beyond three bottom checks',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',pages:[[card('1','00:07')]],appendPageAfterReads:5,appendPage:[card('2','23 sept.'),card('3','22 sept.')]});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,sinceDate:'2026-09-23',untilDate:'2026-09-24',propertyId:'13579135',refreshExisting:true});
  assert.equal(result.discovered,2);
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json','2.json']);
}));

test('property refresh accepts a verified one-page list entirely within the rental period',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',pages:[[card('1','00:07')]]});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,sinceDate:'2026-09-23',untilDate:'2026-09-24',propertyId:'13579135',refreshExisting:true});
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json']);
  assert.equal(result.fullCoverage,true);
  assert.match(JSON.parse(await readFile(path.join(result.directory,'index.json'),'utf8')).listIntegrity,/dos recorridos/);
}));

test('an unfinished or changing property list never claims full coverage',async t=>inTemp(t,async root=>{
  const loading=fake({pages:[[card('1')]],loadingReads:Infinity});
  await assert.rejects(exportToday({root:path.join(root,'loading'),connectBrowser:()=>loading.ev,wait:instant,
    sync:true,propertyId:'13579135',refreshExisting:true}),/no terminó de cargar/);
  const changing=fake({pages:[[card('1')]],appendPageAfterReads:12,appendPage:[card('2')]});
  const previous=path.join(root,'changing','exports','2026-09-23','property-13579135','1.json');
  await mkdir(path.dirname(previous),{recursive:true});
  await writeFile(previous,'{"previous":"complete"}');
  await assert.rejects(exportToday({root:path.join(root,'changing'),connectBrowser:()=>changing.ev,wait:instant,
    sync:true,propertyId:'13579135',refreshExisting:true}),/listado de chats cambió/);
  assert.equal(await readFile(previous,'utf8'),'{"previous":"complete"}');
}));

test('a transient missing detail is retried while keeping the same conversation ID',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1')],[card('2','Ayer')]],transientHistorySnapshot:true});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,propertyId:'13579135',refreshExisting:true});
  assert.equal(result.exported,1);
}));

test('a different selected conversation ID aborts before saving',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1')],[card('2','Ayer')]],switchedHistoryId:'999'});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,propertyId:'13579135',refreshExisting:true}),/chat 1 \(selección visible: 999\)/);
  assert.ok(!(await readdir(path.join(root,'exports','2026-09-23','property-13579135'))).includes('1.json'));
}));

test('the existing browser tab is activated before reload when supported',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1')],[card('2','Ayer')]]});
  browser.ev.activate=()=>browser.calls.push('activate');
  await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,knownIds:['1']});
  assert.ok(browser.calls.indexOf('activate')<browser.calls.indexOf(expressions.reload));
}));

test('unknown list date fails rather than truncating results and releases lock',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',pages:[[card('1','09:42'),card('2','lunes')]]});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,sinceDate:'2026-09-23'}),/no se puede interpretar/);
  assert.ok(!(await readdir(root)).includes('extraction.lock'));
}));

test('refresh mode rereads a known ID and replaces a same-minute file with new messages',async t=>inTemp(t,async root=>{
  const dir=path.join(root,'exports','2026-09-24','property-13579135');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'1.json'),JSON.stringify({id:'1',listedDate:'10:20',messages:[{rawText:'Old'}],integrity:{history:'completo',profile:'completo'}}));
  const browser=fake({day:'2026-09-24',pages:[[card('1','10:20')],[card('2','22/09/2026')]],messageById:{'1':'New message'}});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,knownIds:['1'],sinceDate:'2026-09-23',untilDate:'2026-09-24',propertyId:'13579135',refreshExisting:true});
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json']);
  assert.equal(JSON.parse(await readFile(result.files[0],'utf8')).messages[0].rawText,'New message');
  assert.ok(browser.calls.includes(expressions.snapshot));
}));

test('refresh verifies property URL, ignores price changes, and skips other property without saving',async t=>inTemp(t,async root=>{
  const changed={...card('1'),ad:'900 €/mes - Piso de prueba'};
  const other=card('2');
  const browser=fake({pages:[[changed,other,card('1')],[card('3','Ayer')]],propertyById:{'2':[{url:'https://www.idealista.com/inmueble/12345678/',text:'Otro anuncio'}]}});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,propertyId:'13579135',refreshExisting:true});
  assert.equal(result.candidates,2);
  assert.equal(result.exported,1);
  assert.equal(result.skippedProperty,1);
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json']);
  const dir=path.dirname(result.files[0]);
  assert.ok(!(await readdir(dir)).includes('2.json'));
  const index=JSON.parse(await readFile(path.join(dir,'index.json'),'utf8'));
  assert.ok(!index.conversations.some(c=>c.id==='2'));
}));

test('two property refreshes use isolated namespaces and each validates its own listing ID',async t=>inTemp(t,async root=>{
  const cards=[[{...card('1'),ad:'Cambió el precio'},card('2')],[card('3','Ayer')]];
  const propertyById={
    '1':[{url:'https://www.idealista.com/inmueble/13579135/',text:'A'}],
    '2':[{url:'https://www.idealista.com/inmueble/12345678/',text:'B'}],
  };
  const first=fake({pages:cards.map(p=>p.map(c=>({...c}))),propertyById});
  const firstResult=await exportToday({root,connectBrowser:()=>first.ev,wait:instant,sync:true,knownIds:['1'],propertyId:'13579135',refreshExisting:true});
  const second=fake({pages:cards.map(p=>p.map(c=>({...c}))),propertyById});
  const secondResult=await exportToday({root,connectBrowser:()=>second.ev,wait:instant,sync:true,knownIds:['2'],propertyId:'12345678',refreshExisting:true});
  assert.equal(firstResult.propertyId,'13579135');
  assert.equal(secondResult.propertyId,'12345678');
  assert.deepEqual(firstResult.files,[path.join(root,'exports','2026-09-23','property-13579135','1.json')]);
  assert.deepEqual(secondResult.files,[path.join(root,'exports','2026-09-23','property-12345678','2.json')]);
  assert.equal(JSON.parse(await readFile(path.join(firstResult.directory,'index.json'),'utf8')).property,'https://www.idealista.com/inmueble/13579135/');
  assert.equal(JSON.parse(await readFile(path.join(secondResult.directory,'index.json'),'utf8')).property,'https://www.idealista.com/inmueble/12345678/');
  assert.ok(!(await readdir(firstResult.directory)).includes('2.json'));
  assert.ok(!(await readdir(secondResult.directory)).includes('1.json'));
}));

test('refresh fails when property cannot be verified after history load',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1')],[card('2','Ayer')]],propertyById:{'1':[]}});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,propertyId:'13579135',refreshExisting:true}),/No se pudo comprobar el anuncio/);
  assert.ok(!(await readdir(root)).includes('extraction.lock'));
}));

test('unstable history has an explicit integrity note distinct from attachments',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1')],[card('2','Ayer')]],unstableHistoryIds:['1']});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,sync:true,propertyId:'13579135',refreshExisting:true});
  const data=JSON.parse(await readFile(result.files[0],'utf8'));
  assert.equal(data.integrity.history,'parcial');
  assert.ok(data.integrity.notes.some(note=>note.includes('no se estabilizó')));
}));

test('Apple Events timeout is reported as Chrome timeout, not permission denial',async t=>inTemp(t,async root=>{
  const raw=Object.assign(new Error('spawnSync osascript ETIMEDOUT'),{code:'ETIMEDOUT',signal:'SIGTERM'});
  await assert.rejects(exportToday({root,connectBrowser:()=>{throw raw;},wait:instant}),error=>{
    assert.equal(error.code,'CHROME_TIMEOUT');
    assert.match(error.message,/no respondió a tiempo/);
    assert.doesNotMatch(error.message,/permite JavaScript|osascript|SIGTERM/);
    return true;
  });
}));

test('specific Chrome JavaScript denial remains permission guidance',async t=>inTemp(t,async root=>{
  await assert.rejects(exportToday({root,connectBrowser:()=>{throw new Error('Executing JavaScript through AppleScript is turned off');},wait:instant}),error=>{
    assert.equal(error.code,'CHROME_PERMISSION');
    assert.match(error.message,/Actívalo en Ver/);
    return true;
  });
}));

test('generic osascript failure does not imply revoked permission or reveal diagnostics',async t=>inTemp(t,async root=>{
  await assert.rejects(exportToday({root,connectBrowser:()=>{throw new Error('osascript failed with private detail');},wait:instant}),error=>{
    assert.match(error.message,/La extracción se interrumpió/);
    assert.doesNotMatch(error.message,/permission|permite JavaScript|private detail/);
    return true;
  });
}));

const periodId='5e7e9db2-610d-4955-9969-8d8bd53b23dd';
const periodOptions={periodId,propertyId:'13579135',sinceDate:'2026-09-23',untilDate:'2026-09-23',activityStartsAt:'2026-09-22T22:00:00.000Z',includeLegacyHistory:false,refreshExisting:true,sync:true};
const message=(dateLabel,time,rawText)=>({sequence:1,dateLabel,time,author:'Persona',direction:'received',text:rawText,embeddedProfile:null,rawText,attachments:[],media:[],domClass:''});

test('hidden listing refresh uses only known IDs in a period and keeps the observed properties empty',async t=>inTemp(t,async root=>{
  for(const scanMode of ['full','incremental']){
    const browser=fake({pages:[[card('1')]],propertyById:{'1':[]},messageById:{'1':'Mensaje nuevo'}});
    const result=await exportToday({root:path.join(root,scanMode),connectBrowser:()=>browser.ev,wait:instant,
      ...periodOptions,knownIds:['1'],scanMode,canEarlyStop:scanMode==='incremental'});
    assert.equal(result.exported,1);
    assert.equal(result.fullCoverage,true);
    const data=JSON.parse(await readFile(result.files[0],'utf8'));
    assert.deepEqual(data.properties,[]);
    assert.equal(data.periodMessages[0].text,'Mensaje nuevo');
    assert.ok(data.integrity.notes.some(note=>note.includes('vinculación previamente guardada')));
  }
}));

test('missing listing cannot use an unknown ID or unscoped known ID',async t=>inTemp(t,async root=>{
  for(const options of [periodOptions,{sync:true,refreshExisting:true,propertyId:'13579135',knownIds:['1']}]){
    const browser=fake({pages:[[card('1')]],propertyById:{'1':[]}});
    await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...options}),/No se pudo comprobar el anuncio/);
  }
}));

test('known hidden chats still require the selected chat and never override a conflicting link',async t=>inTemp(t,async root=>{
  const switched=fake({pages:[[card('1')]],propertyById:{'1':[]},switchedHistoryId:'999'});
  await assert.rejects(exportToday({root,connectBrowser:()=>switched.ev,wait:instant,
    ...periodOptions,knownIds:['1']}),/La conversación cambió/);
  const other=fake({pages:[[card('1')]],propertyById:{'1':[{url:'https://www.idealista.com/inmueble/12345678/'}]}});
  const result=await exportToday({root,connectBrowser:()=>other.ev,wait:instant,...periodOptions,knownIds:['1']});
  assert.equal(result.skippedProperty,1);
  assert.deepEqual(result.files,[]);
}));

test('first period sync finishes a multi-page list with no older chat and excludes another listing',async t=>inTemp(t,async root=>{
  const other={url:'https://www.idealista.com/inmueble/12345678/',text:'Otro anuncio'};
  const browser=fake({pages:[[card('1')],[card('2')],[card('3')]],propertyById:{'2':[other]}});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,
    ...periodOptions,scanMode:'incremental',canEarlyStop:false});
  assert.equal(result.effectiveMode,'full');
  assert.equal(result.fullCoverage,true);
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json','3.json']);
  assert.equal(result.skippedProperty,1);
}));

test('period export projects only verified new messages from a reused chat and isolates its files',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1','12:31')],[card('2','Ayer')]],messagesById:{'1':[message('01/02/2022','20:14','Old'),message('HOY','12:31','New')]}});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,knownIds:['1'],...periodOptions});
  assert.equal(result.exported,1);
  assert.equal(result.skippedNoPeriodActivity,0);
  assert.equal(result.files[0],path.join(root,'exports','2026-09-23','property-13579135',`period-${periodId}`,'1.json'));
  const data=JSON.parse(await readFile(result.files[0],'utf8'));
  assert.deepEqual({periodId:data.periodId,propertyId:data.propertyId,sinceDate:data.sinceDate,untilDate:data.untilDate,activityStartsAt:data.activityStartsAt},
    {periodId,propertyId:'13579135',sinceDate:'2026-09-23',untilDate:'2026-09-23',activityStartsAt:'2026-09-22T22:00:00.000Z'});
  assert.deepEqual(data.messages.map(m=>m.messageDate),['2022-02-01','2026-09-23']);
  assert.deepEqual(data.periodMessages.map(m=>m.rawText),['New']);
  assert.equal(data.periodMessages[0].occurredAt,'2026-09-23T10:31:00.000Z');
  const index=JSON.parse(await readFile(path.join(result.directory,'index.json'),'utf8'));
  assert.equal(index.periodId,periodId);
}));

test('period export skips a candidate with only old messages, even when its list card is recent',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1','12:31')],[card('2','Ayer')]],messagesById:{'1':[message('01/02/2022','20:14','Old')]}});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...periodOptions});
  assert.equal(result.exported,0);
  assert.equal(result.skippedNoPeriodActivity,1);
  assert.deepEqual(result.files,[]);
  assert.ok(!(await readdir(result.directory)).includes('1.json'));
}));

test('period export stops when the loaded history is unstable',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[card('1','12:31')],[card('2','Ayer')]],unstableHistoryIds:['1']});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...periodOptions}),/historial completo/);
  const dir=path.join(root,'exports','2026-09-23','property-13579135',`period-${periodId}`);
  assert.ok(!(await readdir(dir)).includes('1.json'));
}));

test('relative message labels use the snapshot Madrid day after midnight',async t=>inTemp(t,async root=>{
  const browser=fake({day:'2026-09-24',pages:[[card('1','Ayer')],[card('2','22 sept.')]],messagesById:{'1':[message('AYER','23:50','Yesterday')]}});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...periodOptions});
  assert.equal(result.exported,1);
  const data=JSON.parse(await readFile(result.files[0],'utf8'));
  assert.equal(data.referenceDay,'2026-09-24');
  assert.equal(data.periodMessages[0].messageDate,'2026-09-23');
  assert.equal(data.periodMessages[0].occurredAt,'2026-09-23T21:50:00.000Z');
}));

test('period projection rejects a message in the same minute as a same-day closure',()=>{
  const messages=resolveMessages([message('HOY','12:30','Uncertain')],'2026-09-23','2026-09-23');
  assert.throws(()=>projectPeriodMessages(messages,{sinceDate:'2026-09-23',untilDate:'2026-09-23',activityStartsAt:'2026-09-23T10:30:30.000Z'}),/mismo minuto/);
  assert.deepEqual(projectPeriodMessages(messages,{sinceDate:'2026-09-23',untilDate:'2026-09-23',activityStartsAt:'2026-09-23T10:31:00.000Z'}),[]);
  const later=resolveMessages([message('HOY','12:31','Later')],'2026-09-23','2026-09-23');
  assert.equal(projectPeriodMessages(later,{sinceDate:'2026-09-23',untilDate:'2026-09-23',activityStartsAt:'2026-09-23T10:30:30.000Z'}).length,1);
});

test('message date resolution covers New Year, leap day, and Madrid DST ambiguity',()=>{
  assert.equal(resolveMessages([message('AYER','23:59','x')],'2026-01-01','2025-12-31')[0].messageDate,'2025-12-31');
  assert.equal(resolveMessages([message('29 feb. 2024','12:00','x')],'2024-03-01','2024-02-29')[0].messageDate,'2024-02-29');
  assert.equal(resolveMessages([message('31 dic.','23:59','x')],'2026-01-01','2025-12-31')[0].messageDate,'2025-12-31');
  const fallback=resolveMessages([message('HOY','02:30','x')],'2026-10-25','2026-10-25')[0];
  assert.equal(fallback.occurredAt,null);
  assert.equal(fallback.timePrecision,'uncertain');
  assert.equal(resolveMessages([message('HOY','03:30','x')],'2026-03-29','2026-03-29')[0].occurredAt,'2026-03-29T01:30:00.000Z');
});

test('stale HOY after midnight cannot become future activity',()=>{
  assert.throws(()=>resolveMessages([message('HOY','23:50','x')],'2026-09-24','2026-09-24','2026-09-23T22:01:00.000Z'),/futuro/);
});

test('period IDs are validated before Chrome and migrated IDs stay inside their own namespace',async t=>inTemp(t,async root=>{
  let connected=false;
  await assert.rejects(exportToday({root,connectBrowser:()=>{connected=true;throw new Error('unexpected');},...periodOptions,periodId:'../other'}),/periodo/);
  assert.equal(connected,false);
  const browser=fake({pages:[[card('1','12:31')],[card('2','Ayer')]],messagesById:{'1':[message('01/02/2022','20:14','Old')]}});
  const localHousingId='bb7f0b13-849b-47c6-8e64-801991492b43';
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...periodOptions,periodId:`initial:${localHousingId}`,includeLegacyHistory:true});
  assert.equal(result.exported,1);
  assert.equal(result.files[0],path.join(root,'exports','2026-09-23','property-13579135',`period-initial%3A${localHousingId}`,'1.json'));
  assert.equal(JSON.parse(await readFile(result.files[0],'utf8')).periodMessages.length,1);
}));

const baselineMessage=(text='Hola',direction='received')=>resolveMessages([
  {...message('HOY','12:30',text),direction}], '2026-09-23','2026-09-23')[0];
const baselineHash=(text='Hola',direction='received')=>fingerprintMessageHistory([baselineMessage(text,direction)]);
const sevenCards=()=>[[...Array.from({length:7},(_,i)=>card(String(i+1)))],[card('99','Ayer')]];
const sevenBaselines=()=>Object.fromEntries(Array.from({length:7},(_,i)=>[String(i+1),baselineHash()]));
const incremental={...periodOptions,scanMode:'incremental',canEarlyStop:true,unchangedThreshold:5};

test('ordered semantic fingerprint ignores profile/display noise but detects outgoing and duplicate turns',()=>{
  const first=baselineMessage();
  assert.equal(fingerprintMessageHistory([{...first,author:'Renamed',dateLabel:'Ayer',rawText:'10:30 changed profile',embeddedProfile:{text:'New details'}}]),baselineHash());
  assert.notEqual(fingerprintMessageHistory([first,{...first,sequence:2}]),baselineHash());
  assert.notEqual(fingerprintMessageHistory([first,baselineMessage('Respuesta','sent')]),baselineHash());
  assert.notEqual(fingerprintMessageHistory([baselineMessage('Respuesta','sent'),first]),
    fingerprintMessageHistory([first,baselineMessage('Respuesta','sent')]));
  assert.equal(fingerprintMessageHistory([{...first,messageDate:undefined}]),null);
  assert.equal(fingerprintMessageHistory([{...first,occurredAt:null}]),null);
  assert.equal(fingerprintMessageHistory([first,{...first,text:null,embeddedProfile:{text:'Updated'},
    media:[{tag:'IMG',alt:'New avatar'}]}]),baselineHash());
  assert.equal(fingerprintMessageHistory([{...first,messageDate:'2026-09-24'}]),null);
  assert.equal(fingerprintMessageHistory([{...first,time:'12:31'}]),null);
});

test('incremental mode stops after five unchanged known target chats and records partial coverage',async t=>inTemp(t,async root=>{
  const browser=fake({pages:[[...Array.from({length:5},(_,i)=>card(String(i+1)))],[card('6'),card('7')],[card('99','Ayer')]],failIfTailAfterOpens:5});
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...incremental,
    knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines()});
  assert.deepEqual({candidates:result.candidates,examined:result.examined,exported:result.exported,earlyStopped:result.earlyStopped,
    stopReason:result.stopReason,fullCoverage:result.fullCoverage,headRechecked:result.headRechecked},
  {candidates:5,examined:5,exported:5,earlyStopped:true,stopReason:'unchanged_streak',fullCoverage:false,headRechecked:true});
  const index=JSON.parse(await readFile(path.join(result.directory,'index.json'),'utf8'));
  assert.equal(index.fullCoverage,false);
  assert.match(index.listIntegrity,/final del listado no comprobado/);
  assert.deepEqual(result.files.map(file=>path.basename(file)),['1.json','2.json','3.json','4.json','5.json']);
}));

test('one through four unchanged chats cannot trigger early stop',async t=>inTemp(t,async root=>{
  for(let count=1;count<=4;count++){
    const browser=fake({pages:[[...Array.from({length:count},(_,i)=>card(String(i+1)))],[card('99','Ayer')]]});
    const result=await exportToday({root:path.join(root,String(count)),connectBrowser:()=>browser.ev,wait:instant,
      ...incremental,knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines()});
    assert.equal(result.examined,count);assert.equal(result.earlyStopped,false);assert.equal(result.fullCoverage,true);
  }
}));

test('new chat, outgoing message, duplicate, and missing baseline reset the unchanged streak',async t=>inTemp(t,async root=>{
  const scenarios=[
    {name:'new',knownIds:Object.keys(sevenBaselines()).filter(id=>id!=='3'),baselineById:sevenBaselines()},
    {name:'outgoing',knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines(),messagesById:{'3':[message('HOY','12:30','Hola'),{...message('HOY','12:31','Respuesta'),direction:'sent'}]}},
    {name:'duplicate',knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines(),messagesById:{'3':[message('HOY','12:30','Hola'),message('HOY','12:30','Hola')]}},
    {name:'uncertain',knownIds:Object.keys(sevenBaselines()),baselineById:{...sevenBaselines(),'3':null}}
  ];
  for(const scenario of scenarios){
    const browser=fake({pages:sevenCards(),messagesById:scenario.messagesById});
    const result=await exportToday({root:path.join(root,scenario.name),connectBrowser:()=>browser.ev,wait:instant,
      ...incremental,knownIds:scenario.knownIds,baselineById:scenario.baselineById});
    assert.equal(result.examined,7,scenario.name);assert.equal(result.earlyStopped,false,scenario.name);
    assert.equal(result.fullCoverage,true,scenario.name);
  }
}));

test('wrong-listing chats do not advance the streak and full or first modes traverse all candidates',async t=>inTemp(t,async root=>{
  const other={url:'https://www.idealista.com/inmueble/12345678/',text:'Otro'};
  const browser=fake({pages:sevenCards(),propertyById:{'3':[other]}});
  const fast=await exportToday({root:path.join(root,'other'),connectBrowser:()=>browser.ev,wait:instant,
    ...incremental,knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines()});
  assert.equal(fast.examined,6);assert.equal(fast.skippedProperty,1);assert.equal(fast.earlyStopped,true);
  assert.equal(fast.exported,5);
  for(const [name,options] of [['full',{scanMode:'full',canEarlyStop:false}],['first',{scanMode:'incremental',canEarlyStop:false}]]){
    const next=fake({pages:sevenCards()});
    const result=await exportToday({root:path.join(root,name),connectBrowser:()=>next.ev,wait:instant,
      ...incremental,...options,knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines()});
    assert.equal(result.examined,7);assert.equal(result.fullCoverage,true);assert.equal(result.earlyStopped,false);
    assert.equal(result.effectiveMode,'full');
  }
}));

test('a moving head forces one full rediscovery and rereads visited chats',async t=>inTemp(t,async root=>{
  const browser=fake({pages:sevenCards(),moveHeadAfterOpens:5});
  const progress=[];
  const result=await exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...incremental,
    knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines(),onProgress:event=>progress.push(event)});
  assert.equal(result.effectiveMode,'full');assert.equal(result.earlyStopped,false);
  assert.equal(result.fullCoverage,true);assert.equal(result.headRechecked,true);
  assert.equal(result.candidates,8);assert.equal(result.exported,8);assert.equal(result.files.length,8);
  assert.equal(result.examined,13);
  assert.equal(progress.filter(event=>event.phase==='exporting').at(-1).examined,13);
  assert.equal(JSON.parse(await readFile(path.join(result.directory,'index.json'),'utf8')).scanStatus,'complete');
  assert.ok(browser.calls.filter(command=>command.includes('dataset.conversationId==="1"')).length>=2);
}));

test('a second moving head fails instead of accepting a changing full pass',async t=>inTemp(t,async root=>{
  const browser=fake({pages:sevenCards(),moveHeadAfterOpens:5,moveHeadAgainAfterOpens:13});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...incremental,
    knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines()}),/listado de chats cambió/);
  const index=JSON.parse(await readFile(path.join(root,'exports','2026-09-23','property-13579135',`period-${periodId}`,'index.json'),'utf8'));
  assert.equal(index.scanStatus,'in_progress');assert.equal(index.fullCoverage,false);
}));

test('a loader at head recheck cannot certify an incremental stop',async t=>inTemp(t,async root=>{
  const browser=fake({pages:sevenCards(),loadingAfterOpens:5});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...incremental,
    knownIds:Object.keys(sevenBaselines()),baselineById:sevenBaselines()}),/no terminó de cargar/);
}));

test('a changed head during full extraction cannot claim complete coverage',async t=>inTemp(t,async root=>{
  const browser=fake({pages:sevenCards(),moveHeadAfterOpens:2});
  await assert.rejects(exportToday({root,connectBrowser:()=>browser.ev,wait:instant,...incremental,
    scanMode:'full',canEarlyStop:false}),/listado de chats cambió/);
}));
