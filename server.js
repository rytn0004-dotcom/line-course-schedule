require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');

for (const key of ['GOOGLE_SHEET_ID','GOOGLE_SERVICE_ACCOUNT_JSON']) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const RETRIES = Number(process.env.GOOGLE_API_MAX_RETRIES || 4);
const PORT = Number(process.env.PORT || 10000);
const DEFAULT_DAYS = Math.max(1, Number(process.env.SCHEDULE_BUILD_DAYS || 30));
const AUTO_CREATE_REMINDERS = ['1','true','yes','是','啟用'].includes(normValue(process.env.SCHEDULE_AUTO_CREATE_REMINDERS || '是'));

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({version:'v4', auth});
const app = express();
app.use(express.json());

const WEEKDAYS = ['日','一','二','三','四','五','六'];
const REMINDER_HEADERS = ['提醒ID','課程日期','上課時間','發送日期','發送時間','身分','收件人','學生/學生成員','課程','老師','校區','訊息內容','確認發送'];
function normValue(v){ return String(v ?? '').trim().toLowerCase(); }

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function retryable(e){
  const s = Number(e?.code || e?.response?.status || 0);
  return [429,500,502,503,504].includes(s) || /quota exceeded|rate limit|temporarily unavailable/i.test(String(e?.message||''));
}
async function retry(label, fn){
  let last;
  for(let i=0;i<=RETRIES;i++){
    try { return await fn(); }
    catch(e){
      last=e;
      if(!retryable(e)||i>=RETRIES) throw e;
      const w=Math.min(10000,600*(2**i))+Math.floor(Math.random()*300);
      console.warn(`${label}: retry ${i+1}/${RETRIES} after ${w}ms`);
      await sleep(w);
    }
  }
  throw last;
}
function qsheet(name){ return `'${String(name).replace(/'/g,"''")}'`; }
function str(v){ return String(v ?? '').trim(); }
function norm(v){ return str(v).replace(/\s+/g,''); }
function split(v){ return str(v).split(/[、,，\/]/).map(s=>s.trim()).filter(Boolean); }
function normHeader(v){
  return str(v)
    .replace(/[\s\u3000]+/g,'')
    .replace(/[（(][^）)]*[）)]/g,'')
    .replace(/[【\[][^】\]]*[】\]]/g,'')
    .replace(/[\/／\\]/g,'');
}
function hmap(h){
  const out={};
  for(const [i,x] of (h||[]).entries()){
    const raw=str(x);
    if(raw) out[raw]=i;
    const normalized=normHeader(raw);
    if(normalized && out[normalized]===undefined) out[normalized]=i;
  }
  return out;
}
function findHeaderRow(rows, required){
  const wanted=(required||[]).map(normHeader);
  return (rows||[]).findIndex(r=>{
    if(!Array.isArray(r)) return false;
    const got=new Set(r.map(normHeader).filter(Boolean));
    return wanted.every(k=>got.has(k));
  });
}
function dateKey(v){
  if (typeof v === 'number') {
    const ms = Math.round(v*86400000);
    const d = new Date(Date.UTC(1899,11,30) + ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  const s=str(v);
  const m=s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  return m ? `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}` : s.slice(0,10);
}
function timeKey(v){
  if (typeof v === 'number') {
    const mins = Math.round((v % 1) * 24 * 60);
    return `${String(Math.floor(mins/60)%24).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
  }
  const s=str(v);
  const m=s.match(/^(\d{1,2}):([0-5]\d)/);
  return m ? `${String(+m[1]).padStart(2,'0')}:${m[2]}` : '';
}
function todayKey(){
  const p=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const g=t=>p.find(x=>x.type===t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function addDays(dateStr, delta){
  const [y,m,d]=dateStr.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()+delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}
function weekdayLabel(dateStr){
  const [y,m,d]=dateStr.split('-').map(Number); return WEEKDAYS[new Date(Date.UTC(y,m-1,d)).getUTCDay()];
}
function compact(v){ return norm(v).replace(/[()（）\[\]【】]/g,''); }
function includesStudent(related, student){
  const names = split(related);
  const target = compact(student);
  return names.some(n => compact(n) === target);
}
function previousReminderSlot(courseDate, settings){
  let sendDate = addDays(courseDate, -1);
  let sendWd = weekdayLabel(sendDate);
  // Sunday is configured as a no-send day. For a Monday course we intentionally
  // use Saturday's slot; for a Sunday course we also move back to Saturday.
  if (sendWd === '日') sendDate = addDays(sendDate, -1), sendWd = weekdayLabel(sendDate);
  const key = `send_${sendWd}`;
  const sendTime = settings[key] || '';
  return {sendDate, sendTime};
}
function safeReplaceTemplate(t, values){
  let out = str(t);
  for (const [k,v] of Object.entries(values)) out = out.replaceAll(`{{${k}}}`, str(v));
  return out;
}

async function ensureSheet(title){
  const r = await retry('get spreadsheet metadata', ()=>sheets.spreadsheets.get({spreadsheetId:SHEET_ID,fields:'sheets.properties'}));
  const exists = (r.data.sheets||[]).some(s=>s.properties?.title===title);
  if(exists) return;
  await retry(`create sheet ${title}`, ()=>sheets.spreadsheets.batchUpdate({
    spreadsheetId:SHEET_ID,
    requestBody:{requests:[{addSheet:{properties:{title}}}]}
  }));
}

async function readSheets(){
  return retry('schedule batchGet', async()=>{
    const ranges=[
      `${qsheet('系統設定')}!A:Z`,
      `${qsheet('固定課表')}!A:K`,
      `${qsheet('調課課程')}!A:M`,
      `${qsheet('實際課程')}!A:M`,
      `${qsheet('聯絡人')}!A:K`,
      `${qsheet('訊息模板')}!A:D`,
      `${qsheet('課程提醒')}!A:M`
    ];
    const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:SHEET_ID,ranges,majorDimension:'ROWS'});
    return (r.data.valueRanges||[]).map(v=>v.values||[]);
  });
}

function parseSettings(rows){
  const hr=findHeaderRow(rows,['設定項目','目前值']);
  if(hr<0) return {};
  const h=hmap(rows[hr]); const out={};
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const key=str(r[h['設定項目']]); if(!key) continue;
    out[key]=str(r[h['目前值']]);
  }
  return {
    enabled:str(out['課程提醒啟用']) || '否',
    parentNotify:str(out['家長通知']) || '是',
    teacherNotify:str(out['老師通知']) || '是',
    requireConfirm:str(out['發送前需確認']) || '是',
    send_sunday: str(out['週日發送時間']),
    send_一: str(out['週一發送時間']),
    send_二: str(out['週二發送時間']),
    send_三: str(out['週三發送時間']),
    send_四: str(out['週四發送時間']),
    send_五: str(out['週五發送時間']),
    send_六: str(out['週六發送時間'])
  };
}
function parseFixed(rows){
  const hr=findHeaderRow(rows,['固定課表ID','星期','上課時間','學生','課程','老師','校區','有效迄日','啟用']);
  if(hr<0) throw new Error('固定課表欄位不正確。');
  const h=hmap(rows[hr]), out=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const id=str(r[h['固定課表ID']]); if(!id) continue;
    if(norm(r[h['啟用']])!=='是') continue;
    const weekday=norm(r[h['星期']]); const time=timeKey(r[h['上課時間']]);
    if(!weekday||!time) continue;
    out.push({id,weekday,time,student:str(r[h['學生']]),course:str(r[h['課程']]),teacher:str(r[h['老師']]),site:str(r[h['校區']]),until:dateKey(r[h['有效迄日']]),template:str(r[h['通知模板']]),note:str(r[h['備註']])});
  }
  return out;
}
function parseAdjust(rows){
  const hr=findHeaderRow(rows,['調課ID','原固定課表ID','原日期','原時間','動作','新日期','新時間','學生','確認']);
  if(hr<0) throw new Error('調課課程欄位不正確。');
  const h=hmap(rows[hr]), out=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const id=str(r[h['調課ID']]); if(!id) continue;
    if(norm(r[h['確認']])!=='是') continue;
    out.push({id,fixedId:str(r[h['原固定課表ID']]),originalDate:dateKey(r[h['原日期']]),originalTime:timeKey(r[h['原時間']]),action:str(r[h['動作']]),newDate:dateKey(r[h['新日期']]),newTime:timeKey(r[h['新時間']]),student:str(r[h['學生']]),course:str(r[h['新課程']]),teacher:str(r[h['新老師']]),site:str(r[h['新校區']]),note:str(r[h['備註']])});
  }
  return out;
}
function parseContacts(rows){
  const hr=findHeaderRow(rows,['姓名','身分','學生姓名/關聯','LINE User ID','通知啟用']);
  if(hr<0) throw new Error('聯絡人欄位不正確。');
  const h=hmap(rows[hr]), out=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[];
    const userId=str(r[h['LINE User ID']]);
    if(!userId) continue;
    if(norm(r[h['通知啟用']])!=='是') continue;
    const role=str(r[h['身分']]);
    if(role!=='家長' && role!=='老師') continue;
    out.push({name:str(r[h['姓名']]),role,related:str(r[h['學生姓名/關聯']]),userId});
  }
  return out;
}
function parseTemplates(rows){
  const hr=findHeaderRow(rows,['模板名稱','適用對象','模板內容']);
  if(hr<0) return [];
  const h=hmap(rows[hr]), out=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const name=str(r[h['模板名稱']]); if(!name) continue;
    out.push({name,role:str(r[h['適用對象']]),content:str(r[h['模板內容']])});
  }
  return out;
}
function parseReminderRows(rows){
  const hr=findHeaderRow(rows,['提醒ID','課程日期','上課時間','發送日期','發送時間','身分','收件人','確認發送']);
  if(hr<0) return {headerRow:-1,headers:REMINDER_HEADERS,rows:[]};
  const headers=rows[hr].map(str);
  const h=hmap(headers); const out=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; if(!str(r[h['提醒ID']])) continue;
    out.push({
      rowIndex:i+1,
      values:r,
      id:str(r[h['提醒ID']]), date:dateKey(r[h['課程日期']]), time:timeKey(r[h['上課時間']]),
      sendDate:dateKey(r[h['發送日期']]), sendTime:timeKey(r[h['發送時間']]),
      role:str(r[h['身分']]), recipient:str(r[h['收件人']]), userId:str(r[h['LINE User ID']]),
      confirm:str(r[h['確認發送']])
    });
  }
  return {headerRow:hr,headers,rows:out};
}

function buildRows(fixed, adjusts, fromDate, days){
  const out=[]; const adjustByDate=new Map();
  for(const a of adjusts){
    if(!a.newDate && !a.originalDate) continue;
    if(a.originalDate){
      const key=`${a.fixedId}|${a.originalDate}`; if(!adjustByDate.has(key)) adjustByDate.set(key,[]); adjustByDate.get(key).push(a);
    }
  }
  const toDate=addDays(fromDate,days-1);
  for(let d=fromDate; d<=toDate; d=addDays(d,1)){
    const wd=weekdayLabel(d);
    for(const f of fixed){
      if(f.until && /^\d{4}-\d{2}-\d{2}$/.test(f.until) && d>f.until) continue;
      if(norm(f.weekday)!==norm(wd)) continue;
      const base={date:d,weekday:wd,time:f.time,student:f.student,course:f.course,teacher:f.teacher,site:f.site,source:'固定課表',fixedId:f.id,adjustId:'',adjustResult:'無',note:f.note||'',template:f.template||''};
      const key=`${f.id}|${d}`; const adj=adjustByDate.get(key)||[];
      if(adj.length){
        let handled=false;
        for(const a of adj){
          const action=norm(a.action);
          if(action==='取消' || action==='停課') { out.push({...base,source:'調課課程',adjustId:a.id,adjustResult:'取消',note:a.note||'調課取消'}); handled=true; continue; }
          if(action==='改課' || action==='調課' || action==='移課'){
            const nd=a.newDate||d; const nt=a.newTime||f.time;
            out.push({...base,date:nd,weekday:weekdayLabel(nd),time:nt,student:a.student||f.student,course:a.course||f.course,teacher:a.teacher||f.teacher,site:a.site||f.site,source:'調課課程',fixedId:f.id,adjustId:a.id,adjustResult:'已調課',note:a.note||''});
            handled=true;
          }
        }
        if(!handled) out.push(base);
      } else {
        out.push(base);
      }
    }
  }
  for(const a of adjusts){
    if(!a.newDate || a.originalDate) continue;
    if(a.action && /取消|停課/.test(a.action)) continue;
    if(a.newDate < fromDate || a.newDate > toDate) continue;
    const fixedBase = fixed.find(x=>x.id===a.fixedId);
    const action = norm(a.action);
    const isAdd = /新增|補課|體驗/.test(action) || !a.fixedId;
    if(!isAdd) continue;
    const student = a.student || fixedBase?.student || '';
    const course = a.course || fixedBase?.course || '';
    const teacher = a.teacher || fixedBase?.teacher || '';
    const site = a.site || fixedBase?.site || '';
    if(!student || !a.newTime) continue;
    out.push({
      date:a.newDate, weekday:weekdayLabel(a.newDate), time:a.newTime || fixedBase?.time || '',
      student, course, teacher, site, source:'調課課程', fixedId:fixedBase?.id || '',
      adjustId:a.id, adjustResult:'新增調課', note:a.note||'', template:fixedBase?.template || ''
    });
  }
  const seen=new Set(); const final=[];
  for(const x of out.sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)||a.student.localeCompare(b.student))){
    const key=[x.date,x.time,x.student,x.course,x.teacher,x.site,x.fixedId,x.adjustId,x.adjustResult].join('|');
    if(seen.has(key)) continue; seen.add(key);
    const courseId=x.adjustId ? `${x.fixedId}-${x.date}-${x.adjustId}` : `${x.fixedId}-${x.date}`;
    final.push([courseId,x.date,x.weekday,x.time,x.student,x.course,x.teacher,x.site,x.source,x.fixedId,x.adjustId,x.adjustResult,x.note||'']);
  }
  return final;
}

async function writeActual(rows){
  await retry('clear 實際課程',()=>sheets.spreadsheets.values.clear({spreadsheetId:SHEET_ID,range:`${qsheet('實際課程')}!A3:M`,requestBody:{}}));
  if(!rows.length) return;
  await retry('write 實際課程',()=>sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:`${qsheet('實際課程')}!A3:M${rows.length+2}`,valueInputOption:'RAW',requestBody:{values:rows}}));
}

function actualObjects(actualRows){
  return actualRows.map(r=>({
    courseId:str(r[0]), date:dateKey(r[1]), weekday:str(r[2]), time:timeKey(r[3]), student:str(r[4]), course:str(r[5]),
    teacher:str(r[6]), site:str(r[7]), source:str(r[8]), fixedId:str(r[9]), adjustId:str(r[10]), adjustResult:str(r[11]), note:str(r[12])
  }));
}

function chooseTemplate(templates, role, preferred){
  const names=split(preferred);
  if(role==='家長'){
    if(names.includes('家長一般')) return templates.find(t=>t.name==='家長一般')?.content || '';
    const candidate=names.map(n=>templates.find(t=>t.name===n && t.role==='家長')).find(Boolean);
    return candidate?.content || templates.find(t=>t.name==='家長一般')?.content || '';
  }
  if(role==='老師'){
    if(names.includes('老師通知')) return templates.find(t=>t.name==='老師通知')?.content || '';
    const candidate=names.map(n=>templates.find(t=>t.name===n && t.role==='老師')).find(Boolean);
    return candidate?.content || templates.find(t=>t.name==='老師通知')?.content || '';
  }
  return '';
}

function makeReminderRows(actual, contacts, templates, settings, fixedTemplateById){
  const out=[];
  const requireConfirm = settings.requireConfirm !== '否';
  for(const c of actual){
    if(c.adjustResult==='取消') continue;
    const slot=previousReminderSlot(c.date,settings);
    if(!slot.sendDate || !slot.sendTime) continue;
    const dateLabel=c.date.replaceAll('-','/');
    if(settings.parentNotify==='是'){
      for(const person of contacts.filter(x=>x.role==='家長' && includesStudent(x.related,c.student))){
        const preferred = fixedTemplateById.get(c.fixedId) || '';
        const template=chooseTemplate(templates,'家長',preferred);
        const content=safeReplaceTemplate(template,{學生:c.student,日期:dateLabel,星期:c.weekday,時間:c.time,課程:c.course,老師:c.teacher,校區:c.site,學生成員:c.student});
        const id=`${c.courseId}-P`;
        out.push({key:id,id,courseId:c.courseId,date:c.date,time:c.time,sendDate:slot.sendDate,sendTime:slot.sendTime,role:'家長',recipient:person.name,userId:person.userId,student:c.student,course:c.course,teacher:c.teacher,site:c.site,content,confirm:requireConfirm?'否':'是'});
      }
    }
    if(settings.teacherNotify==='是'){
      for(const person of contacts.filter(x=>x.role==='老師' && compact(x.related)===compact(c.teacher))){
        const preferred=fixedTemplateById.get(c.fixedId) || '';
        const template=chooseTemplate(templates,'老師',preferred);
        const content=safeReplaceTemplate(template,{學生:c.student,日期:dateLabel,星期:c.weekday,時間:c.time,課程:c.course,老師:c.teacher,校區:c.site,學生成員:c.student});
        const id=`${c.courseId}-T`;
        out.push({key:id,id,courseId:c.courseId,date:c.date,time:c.time,sendDate:slot.sendDate,sendTime:slot.sendTime,role:'老師',recipient:person.name,userId:person.userId,student:c.student,course:c.course,teacher:c.teacher,site:c.site,content,confirm:requireConfirm?'否':'是'});
      }
    }
  }
  return out;
}

async function syncReminders(actualRows, reminderRows, contacts, templates, settings, fromDate, days, fixedTemplateByIdInput){
  await ensureSheet('課程提醒');
  const fixedTemplateById=new Map();
  for(const f of fixedTemplateByIdInput) fixedTemplateById.set(f.id,f.template || '');
  const expected=makeReminderRows(actualObjects(actualRows),contacts,templates,settings,fixedTemplateById);
  const expectedKeys=new Set(expected.map(x=>`${x.id}|${x.role}|${x.recipient}`));
  const parsed=parseReminderRows(reminderRows);
  const headers=parsed.headers?.length ? parsed.headers : REMINDER_HEADERS;
  const h=hmap(headers);

  const width=Math.max(headers.length, REMINDER_HEADERS.length);
  const updates=[];
  const append=[];
  let created=0, updated=0, disabled=0;
  const existingByKey=new Map();
  for(const row of parsed.rows){ existingByKey.set(`${row.id}|${row.role}|${row.recipient}`,row); }

  const toOutput = x => {
    const arr=new Array(width).fill('');
    const set=(name,val)=>{ if(h[name] !== undefined) arr[h[name]]=val; };
    set('提醒ID',x.id); set('課程日期',x.date); set('上課時間',x.time); set('發送日期',x.sendDate); set('發送時間',x.sendTime);
    set('身分',x.role); set('收件人',x.recipient); set('學生/學生成員',x.student); set('課程',x.course); set('老師',x.teacher); set('校區',x.site); set('訊息內容',x.content); set('確認發送',x.confirm);
    return arr;
  };

  for(const x of expected){
    const old=existingByKey.get(`${x.id}|${x.role}|${x.recipient}`);
    if(old){
      const row=old.values.slice();
      while(row.length<width) row.push('');
      const getIdx=name=>h[name]===undefined?-1:h[name];
      const preserveMsg = str(row[getIdx('訊息內容')]);
      const preserveConfirm = str(row[getIdx('確認發送')]);
      Object.assign(row, toOutput(x));
      if(preserveMsg) row[getIdx('訊息內容')]=preserveMsg;
      if(preserveConfirm) row[getIdx('確認發送')]=preserveConfirm;
      updates.push({rowNumber:old.rowIndex,values:row});
      updated++;
    }else{
      append.push(toOutput(x));
      created++;
    }
  }

  // Generated reminder rows for courses that disappeared inside this build window
  // are explicitly disabled so the separate reminder service cannot send stale classes.
  for(const old of parsed.rows){
    if(expectedKeys.has(`${old.id}|${old.role}|${old.recipient}`)) continue;
    const isGenerated = /-(?:P|T)$/.test(old.id);
    const inWindow = old.date && old.date>=fromDate && old.date<=addDays(fromDate,days-1);
    if(!isGenerated || !inWindow) continue;
    const row=old.values.slice(); while(row.length<width) row.push('');
    if(h['確認發送']!==undefined) row[h['確認發送']]='否';
    updates.push({rowNumber:old.rowIndex,values:row});
    disabled++;
  }

  for(const u of updates){
    await retry('update 課程提醒 row',()=>sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:`${qsheet('課程提醒')}!A${u.rowNumber}:${String.fromCharCode(64+Math.min(width,26))}${u.rowNumber}`,valueInputOption:'RAW',requestBody:{values:[u.values]}}));
  }
  if(append.length){
    const startRow=parsed.rows.length ? Math.max(...parsed.rows.map(r=>r.rowIndex))+1 : (parsed.headerRow>=0 ? parsed.headerRow+2 : 2);
    await retry('append 課程提醒',()=>sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:`${qsheet('課程提醒')}!A${startRow}:${String.fromCharCode(64+Math.min(width,26))}${startRow+append.length-1}`,valueInputOption:'RAW',requestBody:{values:append}}));
  }
  if(parsed.headerRow<0){
    await retry('write 課程提醒 header',()=>sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:`${qsheet('課程提醒')}!A1:M1`,valueInputOption:'RAW',requestBody:{values:[REMINDER_HEADERS]}}));
  }
  return {expectedCount:expected.length,created,updated,disabled,reminderServiceEnabled:settings.enabled==='是',lineSending:false};
}

async function build({fromDate=todayKey(),days=DEFAULT_DAYS}={}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error('fromDate 必須是 YYYY-MM-DD');
  await ensureSheet('課程提醒');
  const [settingsRows,fixedRows,adjustRows,oldActualRows,contactRows,templateRows,reminderRows] = await readSheets();
  const settings=parseSettings(settingsRows);
  const fixed=parseFixed(fixedRows); const adjusts=parseAdjust(adjustRows); const contacts=parseContacts(contactRows); const templates=parseTemplates(templateRows);
  const fixedTemplateByIdInput=fixed;
  const actual=buildRows(fixed,adjusts,fromDate,days);
  await writeActual(actual);
  const reminder=AUTO_CREATE_REMINDERS
    ? await syncReminders(actual,reminderRows,contacts,templates,settings,fromDate,days,fixedTemplateByIdInput)
    : {expectedCount:0,created:0,updated:0,disabled:0,reminderServiceEnabled:settings.enabled==='是',autoCreateReminders:false,lineSending:false};
  return {ok:true,fromDate,toDate:addDays(fromDate,days-1),fixedCount:fixed.length,adjustCount:adjusts.length,actualCount:actual.length,reminder};
}

let lastBuild={status:'not_run'};
app.get('/health',(req,res)=>res.json({ok:true,service:'line-course-schedule-manager-v1.2',timezone:TZ,lastBuild}));
app.get('/build',async(req,res)=>{
  try{
    const fromDate=req.query.from || todayKey();
    const days=Math.min(180,Math.max(1,Number(req.query.days||DEFAULT_DAYS)));
    lastBuild=await build({fromDate,days}); lastBuild.at=new Date().toISOString();
    res.json(lastBuild);
  }catch(e){ lastBuild={status:'error',error:e.message,at:new Date().toISOString()}; console.error(e); res.status(500).json(lastBuild); }
});

app.listen(PORT,()=>console.log(`LINE Course Schedule Manager v1.2 listening on ${PORT}`));
// Light automatic refresh: rebuild once at startup, then every 6 hours. No LINE sending.
(async()=>{
  try { lastBuild=await build({fromDate:todayKey(),days:DEFAULT_DAYS}); lastBuild.at=new Date().toISOString(); console.log('Initial schedule build complete',lastBuild); }
  catch(e){ lastBuild={status:'error',error:e.message,at:new Date().toISOString()}; console.error('Initial schedule build failed',e); }
  setInterval(async()=>{
    try { lastBuild=await build({fromDate:todayKey(),days:DEFAULT_DAYS}); lastBuild.at=new Date().toISOString(); console.log('Scheduled schedule rebuild complete',lastBuild); }
    catch(e){ lastBuild={status:'error',error:e.message,at:new Date().toISOString()}; console.error('Scheduled schedule rebuild failed',e); }
  }, 6*60*60*1000).unref?.();
})();
