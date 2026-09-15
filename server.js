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

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({version:'v4', auth});
const app = express();
app.use(express.json());

const WEEKDAYS = ['日','一','二','三','四','五','六'];
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
function hmap(h){ return Object.fromEntries((h||[]).map((x,i)=>[str(x),i])); }
function findHeaderRow(rows, required){
  return (rows||[]).findIndex(r=>Array.isArray(r) && required.every(k=>r.map(str).includes(k)));
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

async function readSheets(){
  return retry('schedule batchGet', async()=>{
    const ranges=[
      `${qsheet('固定課表')}!A:K`,
      `${qsheet('調課課程')}!A:M`,
      `${qsheet('實際課程')}!A:M`
    ];
    const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:SHEET_ID,ranges,majorDimension:'ROWS'});
    return (r.data.valueRanges||[]).map(v=>v.values||[]);
  });
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
      const base={date:d,weekday:wd,time:f.time,student:f.student,course:f.course,teacher:f.teacher,site:f.site,source:'固定課表',fixedId:f.id,adjustId:'',adjustResult:'無',note:f.note||''};
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
  // Explicit add-on adjustments: allow a new class even when there is no original fixed schedule.
  // This supports experience classes and make-up classes that are not derived from a fixed timetable.
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
      adjustId:a.id, adjustResult:'新增調課', note:a.note||''
    });
  }
  // Stable sort and de-duplicate exact output rows.
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
  await retry('clear 實際課程',()=>sheets.spreadsheets.values.clear({spreadsheetId:SHEET_ID,range:`${qsheet('實際課程')}!A3:M` ,requestBody:{}}));
  if(!rows.length) return;
  await retry('write 實際課程',()=>sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:`${qsheet('實際課程')}!A3:M${rows.length+2}`,valueInputOption:'RAW',requestBody:{values:rows}}));
}
async function build({fromDate=todayKey(),days=DEFAULT_DAYS}={}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error('fromDate 必須是 YYYY-MM-DD');
  const [fixedRows, adjustRows] = await readSheets();
  const fixed=parseFixed(fixedRows); const adjusts=parseAdjust(adjustRows);
  const actual=buildRows(fixed,adjusts,fromDate,days);
  await writeActual(actual);
  return {ok:true,fromDate,toDate:addDays(fromDate,days-1),fixedCount:fixed.length,adjustCount:adjusts.length,actualCount:actual.length};
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
