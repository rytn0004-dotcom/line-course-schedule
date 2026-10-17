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
const configuredBuildDays = Number(process.env.SCHEDULE_BUILD_DAYS || 30);
const DEFAULT_DAYS = Number.isInteger(configuredBuildDays) && configuredBuildDays >= 1
  ? Math.min(180, configuredBuildDays)
  : 30;
const PREVIEW_SOURCE_SHEET_ID = String(process.env.PREVIEW_SOURCE_SHEET_ID || SHEET_ID).trim();
const PREVIEW_SOURCE_GID = String(process.env.PREVIEW_SOURCE_GID || '').trim();
const PREVIEW_SOURCE_TAB_NAME = String(process.env.PREVIEW_SOURCE_TAB_NAME || '開學課表').trim();
const AUTO_CREATE_REMINDERS = isYes(process.env.SCHEDULE_AUTO_CREATE_REMINDERS || '是', true);

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({version:'v4', auth});
const app = express();
app.use(express.json());

const WEEKDAYS = ['日','一','二','三','四','五','六'];
const REMINDER_HEADERS = ['提醒ID','課程日期','上課時間','發送日期','發送時間','身分','收件人','學生/學生成員','課程','老師','校區','訊息內容','確認發送'];
const DEFAULT_SITE = '愛學館信義光復校';
const CORRECTION_HEADERS = ['日期','學生','原時間','校正動作','新時間','新課程','新老師','備註'];
function normValue(v){ return String(v ?? '').trim().toLowerCase(); }
function isYes(v, whenBlank=false){
  const x=normValue(v);
  if(!x) return whenBlank;
  return ['是','yes','true','1','啟用','y'].includes(x);
}
function isNo(v){ return ['否','no','false','0','停用','n'].includes(normValue(v)); }
function adminAuthorized(req){
  const expected=String(process.env.SCHEDULE_ADMIN_TOKEN||'');
  if(!expected) return false;
  const supplied=String(req.get('x-admin-token')||req.query.token||'');
  const a=Buffer.from(expected), b=Buffer.from(supplied);
  return a.length===b.length && require('crypto').timingSafeEqual(a,b);
}

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
      const quotaHit=/quota exceeded|rate limit|too many requests/i.test(String(e?.message||'')) || Number(e?.code||e?.response?.status||0)===429;
      const w=quotaHit
        ? Math.min(60000,15000*(i+1))+Math.floor(Math.random()*1000)
        : Math.min(10000,600*(2**i))+Math.floor(Math.random()*300);
      console.warn(`${label}: retry ${i+1}/${RETRIES} after ${w}ms`);
      await sleep(w);
    }
  }
  throw last;
}
function qsheet(name){ return `'${String(name).replace(/'/g,"''")}'`; }
function str(v){ return String(v ?? '').trim(); }
function normalizeSite(v){ return str(v) || DEFAULT_SITE; }
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
  if(typeof v==='number'){ const mins=Math.round((v%1)*24*60); return String(Math.floor(mins/60)%24).padStart(2,'0')+':'+String(mins%60).padStart(2,'0'); }
  const x=str(v).replace(/\s+/g,''); const m=x.match(/^(\d{1,2}):([0-5]\d)/);
  if(m) return String(+m[1]).padStart(2,'0')+':'+m[2];
  if(/^\d{3,4}$/.test(x)){ const n=x.padStart(4,'0'),hh=+n.slice(0,2),mm=+n.slice(2); if(hh<24&&mm<60)return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0'); }
  return '';
}
function parseTimeRange(v){ const m=str(v).replace(/\s+/g,'').match(/(\d{1,2}:?\d{2})[-~～至](\d{1,2}:?\d{2})/); return m?{start:timeKey(m[1]),end:timeKey(m[2])}:{start:'',end:''}; }
function extractStudentFromTime(v){ const m=str(v).match(/(?:\d{1,2}:?\d{2})\s*[-~～至]\s*(?:\d{1,2}:?\d{2})\s*([^()（）]*)/); return m?str(m[1]):''; }
function isValidDateKey(value){
  const m=str(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return false;
  const y=Number(m[1]), mo=Number(m[2]), d=Number(m[3]);
  const dt=new Date(Date.UTC(y,mo-1,d));
  return dt.getUTCFullYear()===y && dt.getUTCMonth()===mo-1 && dt.getUTCDate()===d;
}
function parseDateFlexible(v, reference=todayKey()){
  if(typeof v==='number'){
    const key=dateKey(v);
    return isValidDateKey(key)?key:'';
  }
  const x=str(v);
  const full=dateKey(x);
  if(isValidDateKey(full) && /^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}/.test(x)) return full;
  const short=x.match(/^(\d{1,2})[\/\.\-](\d{1,2})$/);
  if(!short) return '';
  const refKey=isValidDateKey(String(reference)) ? String(reference) :
    /^\d{4}$/.test(String(reference)) ? String(reference)+'-01-01' : todayKey();
  const year=Number(refKey.slice(0,4));
  const makeKey=y=>String(y)+'-'+String(+short[1]).padStart(2,'0')+'-'+String(+short[2]).padStart(2,'0');
  let key=makeKey(year);
  if(!isValidDateKey(key)) return '';
  if(key<addDays(refKey,-30)){
    const next=makeKey(year+1);
    if(isValidDateKey(next)){
      const distance=(a,b)=>Math.abs(Date.parse(a+'T00:00:00Z')-Date.parse(b+'T00:00:00Z'));
      if(distance(next,refKey)<distance(key,refKey)) key=next;
    }
  }
  return key;
}
function extractMoveDate(action, originalDate, referenceDate=originalDate||todayKey()){
  const s=str(action).replace(/[\s　]+/g,'');
  const patterns=[
    /整日(?:調課|移課|改課)(?:到|至)?[:：]?(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/,
    /整日(?:調課|移課|改課)(?:到|至)?[:：]?(\d{1,2}[-\/.]\d{1,2})/,
    /(?:調|移|改)(?:到|至)[:：]?(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/,
    /(?:調|移|改)(?:到|至)[:：]?(\d{1,2}[-\/.]\d{1,2})/
  ];
  for(const re of patterns){ const m=s.match(re); if(m) return parseDateFlexible(m[1],referenceDate); }
  return '';
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
  return {sendDate, sendTime:timeKey(sendTime)};
}
function safeReplaceTemplate(t, values){
  let out = str(t);
  for (const [k,v] of Object.entries(values)) out = out.replaceAll(`{{${k}}}`, str(v));
  return out;
}

async function ensureSheet(title){
  const r=await retry('get spreadsheet metadata',()=>sheets.spreadsheets.get({spreadsheetId:SHEET_ID,fields:'sheets.properties'}));
  const exists=(r.data.sheets||[]).some(s=>s.properties?.title===title);
  if(exists)return false;
  await retry('create sheet '+title,()=>sheets.spreadsheets.batchUpdate({spreadsheetId:SHEET_ID,requestBody:{requests:[{addSheet:{properties:{title}}}]}}));
  return true;
}
async function ensureSheetHeaders(title,headers){
  const created=await ensureSheet(title);
  const end=columnLetter(headers.length);
  const r=await retry('read '+title+' headers',()=>sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:qsheet(title)+'!A:Z'}));
  const rows=r.data.values||[];
  if(findHeaderRow(rows,headers)>=0)return;
  const hasData=rows.some(row=>Array.isArray(row)&&row.some(value=>str(value)!==''));
  if(hasData){
    throw new Error('工作表「'+title+'」已有資料但找不到必要標題列；為避免覆寫資料，已停止自動建立標題。請先檢查欄位。');
  }
  await retry('write '+title+' headers',()=>sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:qsheet(title)+'!A1:'+end+'1',valueInputOption:'RAW',requestBody:{values:[headers]}}));
}
async function readSheets(){
  return retry('schedule batchGet', async()=>{
    const ranges=[
      `${qsheet('系統設定')}!A:Z`,
      `${qsheet('固定課表')}!A:K`,
      `${qsheet('調課課程')}!A:M`,
      `${qsheet('課程校正')}!A:H`,
      `${qsheet('實際課程')}!A:O`,
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
function parseFixed(rows, referenceDate=todayKey()){
  const hr=findHeaderRow(rows,['固定課表ID','星期','上課時間','學生','課程','老師','校區','有效迄日','啟用']);
  if(hr<0) throw new Error('固定課表欄位不正確。');
  const h=hmap(rows[hr]), out=[];
  const enabledIssues=[];
  const teacherDiagnostics=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const id=str(r[h['固定課表ID']]); if(!id) continue;
    const enabledRaw=str(r[h['啟用']]);
    const enabled=isYes(enabledRaw);
    if(!isYes(enabledRaw) && !isNo(enabledRaw)){
      enabledIssues.push({row:i+1,id,student:str(r[h['學生']]),teacher:str(r[h['老師']]),enabledRaw});
    }
    const teacherRaw=str(r[h['老師']]);
    if(teacherRaw && /陳少禹|少禹/.test(teacherRaw)){
      teacherDiagnostics.push({row:i+1,id,student:str(r[h['學生']]),teacher:teacherRaw,enabled:enabledRaw,weekday:str(r[h['星期']]),rawTime:str(r[h['上課時間']]),course:str(r[h['課程']]),site:str(r[h['校區']]),until:str(r[h['有效迄日']])});
    }
    if(!enabled) continue;
    const weekday=norm(r[h['星期']]); const rawTime=str(r[h['上課時間']]); const range=parseTimeRange(rawTime); const time=range.start||timeKey(rawTime);
    if(!weekday||!time) continue;
    const student=str(r[h['學生']])||extractStudentFromTime(rawTime);
    if(!student || isUnavailableSlot(student)) continue;
    out.push({id,weekday,time,endTime:range.end,student,course:str(r[h['課程']]),teacher:str(r[h['老師']]),site:normalizeSite(r[h['校區']]),until:parseDateFlexible(r[h['有效迄日']],referenceDate),template:str(r[h['通知模板']]),note:str(r[h['備註']]),rawTime});
  }
  // 診斷指定學生為何沒有進入「實際課程」。只記錄少禹相關資料，不改變既有排課結果。
  const diagnosticStudents=['陳少禹','少禹'];
  for(const target of diagnosticStudents){
    const matched=out.filter(f=>compact(f.student)===compact(target));
    if(matched.length){
      console.log('[SCHEDULE-DIAG] 固定課表找到學生', target, matched.map(f=>({
        id:f.id, weekday:f.weekday, rawTime:f.rawTime, time:f.time, endTime:f.endTime,
        course:f.course, teacher:f.teacher, site:f.site, until:f.until, enabled:'是', note:f.note
      })));
    }
  }
  if(enabledIssues.length){
    console.warn('[SCHEDULE-DATA-CHECK] 固定課表「啟用」欄位不是「是／否」', enabledIssues);
  }
  if(teacherDiagnostics.length){
    console.log('[SCHEDULE-DATA-CHECK] 固定課表找到老師「陳少禹」', teacherDiagnostics);
  }
  return out;
}
function parseAdjust(rows, correctionRows=[], referenceDate=todayKey()){
  const legacyHr=findHeaderRow(rows,['調課ID','原固定課表ID','原日期','原時間','動作','新日期','新時間','學生','確認']);
  const simpleHr=findHeaderRow(rows,['原日期','原時間','動作','新日期','新時間','學生','新課程','新老師']);
  const out=[];
  if(legacyHr>=0){
    const h=hmap(rows[legacyHr]);
    for(let i=legacyHr+1;i<rows.length;i++){
      const r=rows[i]||[],id=str(r[h['調課ID']]); if(!id)continue;
      if(h['確認']!==undefined&&!isYes(r[h['確認']]))continue;
      out.push({id,fixedId:str(r[h['原固定課表ID']]),originalDate:parseDateFlexible(r[h['原日期']],referenceDate),originalTime:parseTimeRange(r[h['原時間']]).start||timeKey(r[h['原時間']]),action:str(r[h['動作']]),newDate:parseDateFlexible(r[h['新日期']],referenceDate),newTime:parseTimeRange(r[h['新時間']]).start||timeKey(r[h['新時間']]),newEndTime:parseTimeRange(r[h['新時間']]).end,student:str(r[h['學生']]),course:str(r[h['新課程']]),teacher:str(r[h['新老師']]),site:str(r[h['新校區']]),note:str(r[h['備註']]),source:'調課課程'});
    }
  } else if(simpleHr>=0){
    const h=hmap(rows[simpleHr]);
    for(let i=simpleHr+1;i<rows.length;i++){
      const r=rows[i]||[],student=str(r[h['學生']]);
      const d=parseDateFlexible(r[h['原日期']],referenceDate),t=parseTimeRange(r[h['原時間']]).start||timeKey(r[h['原時間']]);
      const action=str(r[h['動作']]);
      if(!d)continue;
      if(!student && !/整日/.test(action))continue;
      if(!t && !/整日/.test(action))continue;
      out.push({id:'',fixedId:'',originalDate:d,originalTime:t,action,newDate:parseDateFlexible(r[h['新日期']],referenceDate),newTime:parseTimeRange(r[h['新時間']]).start||timeKey(r[h['新時間']]),newEndTime:parseTimeRange(r[h['新時間']]).end,student,course:str(r[h['新課程']]),teacher:str(r[h['新老師']]),site:'',note:'',source:'調課課程'});
    }
  }

  const cr=findHeaderRow(correctionRows,CORRECTION_HEADERS);
  if(cr>=0){
    const h=hmap(correctionRows[cr]);
    const parsedCorrectionKeys=new Set();

    // 課程校正除了原本的欄位填寫方式，也支援「只貼備註」。
    // 備註可貼單行或多行，例如：
    // 1030-1200沄臻(10/10(六)調10/9b)
    // 週六1230-1400尚哲(10/3理化加課)
    // 星期六1030-1200嘉恆(9/25p調10/3b)(10/3嘉恆請假)
    function pushCorrection(item){
      const key=[
        item.originalDate||'',
        compact(item.student||''),
        item.originalTime||'',
        item.action||'',
        item.newDate||'',
        item.newTime||'',
        item.course||''
      ].join('|');
      if(parsedCorrectionKeys.has(key)) return;
      parsedCorrectionKeys.add(key);
      out.push(item);
    }

    for(let i=cr+1;i<correctionRows.length;i++){
      const r=correctionRows[i]||[];
      const student=str(r[h['學生']]);
      const d=parseDateFlexible(r[h['日期']],referenceDate);
      const t=parseTimeRange(r[h['原時間']]).start||timeKey(r[h['原時間']]);
      const action=str(r[h['校正動作']]);
      const note=str(r[h['備註']]);

      // 先保留原本「日期／學生／原時間／校正動作」欄位的正式填法。
      if(d && (student || /整日/.test(action)) && (t || /整日/.test(action))){
        let newDate=extractMoveDate(action,d,referenceDate) || d;
        if(newDate===d){
          const noteMove=note.match(/(?:→|->|至|到)\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2})/);
          if(noteMove) newDate=parseDateFlexible(noteMove[1],referenceDate);
        }

        pushCorrection({
          id:'CORR-'+(i+1),fixedId:'',originalDate:d,originalTime:t,action,newDate,
          newTime:parseTimeRange(r[h['新時間']]).start||timeKey(r[h['新時間']]),newEndTime:parseTimeRange(r[h['新時間']]).end,
          student,course:str(r[h['新課程']]),teacher:str(r[h['新老師']]),site:'',
          note,source:'課程校正'
        });
      }

      // 「整日調課／整日停課」也可以完全只寫在備註。
      // 例如：整日調課：2026-10-10 → 2026-10-09
      // 或：整日停課：2026-10-09
      const wideMoveRe=/整日(?:調課|移課|改課)\s*[:：]?\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2})\s*(?:→|->|至|到)\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2})/;
      const wideCancelRe=/整日(?:停課|取消)\s*[:：]?\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2})/;
      let wideMatch=note.match(wideMoveRe);
      if(wideMatch){
        const from=parseDateFlexible(wideMatch[1],referenceDate);
        const to=parseDateFlexible(wideMatch[2],referenceDate);
        if(from && to && from!==to){
          pushCorrection({
            id:'CORR-NOTE-WIDE-MOVE-'+(i+1)+'-'+from+'-'+to,
            fixedId:'',originalDate:from,originalTime:'',action:'整日調課',
            newDate:to,newTime:'',student:'',
            course:'',teacher:'',site:'',
            note:'來源：課程校正備註；'+note,source:'課程校正'
          });
        }
      }
      wideMatch=note.match(wideCancelRe);
      if(wideMatch){
        const from=parseDateFlexible(wideMatch[1],referenceDate);
        if(from){
          pushCorrection({
            id:'CORR-NOTE-WIDE-CANCEL-'+(i+1)+'-'+from,
            fixedId:'',originalDate:from,originalTime:'',action:'整日停課',
            newDate:from,newTime:'',student:'',
            course:'',teacher:'',site:'',
            note:'來源：課程校正備註；'+note,source:'課程校正'
          });
        }
      }

      // 新功能：備註欄直接貼自然文字即可。
      // 一個儲存格內可以放多行，每行獨立解析；不會修改固定課表。
      if(note){
        const lines=note.split(/\r?\n/).map(str).filter(Boolean);
        for(const line of lines){
          const timeMatch=line.match(/(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})\s*([^()（）]*)/);
          const inlineTime=timeMatch ? timeKey(timeMatch[1]) : t;
          const inlineStudent=timeMatch ? str(timeMatch[3]) : student;
          const text=line;

          // 「9/25p調10/3b」或「10/10(六)調10/9b」
          // 「1830-2000昀瑄(10/9 0900-1030)」：同一天只調整時間。
          // 括號內日期是課程日期，括號內時段是調整後時段。
          const timeMoveRe=/(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})\s*([^()（）]+?)\s*[（(]\s*(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{1,2}[-\/.]\d{1,2})\s+(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})\s*[）)]/;
          const timeMoveMatch=text.match(timeMoveRe);
          if(timeMoveMatch){
            const moveDate=parseDateFlexible(timeMoveMatch[4],referenceDate);
            const moveStudent=str(timeMoveMatch[3]);
            const originalStart=timeKey(timeMoveMatch[1]);
            const originalEnd=timeKey(timeMoveMatch[2]);
            const moveStart=timeKey(timeMoveMatch[5]);
            const moveEnd=timeKey(timeMoveMatch[6]);
            if(moveDate && moveStudent && originalStart && originalEnd && moveStart && moveEnd){
              pushCorrection({
                id:'CORR-NOTE-TIME-'+(i+1)+'-'+moveDate+'-'+compact(moveStudent)+'-'+originalStart+'-'+moveStart,
                fixedId:'',originalDate:moveDate,originalTime:originalStart,action:'改時間',
                newDate:moveDate,newTime:moveStart,student:moveStudent,
                course:'',teacher:'',site:'',
                note:'來源：課程校正備註；'+line+'（原時段 '+originalStart+'-'+originalEnd+'；新時段 '+moveStart+'-'+moveEnd+'）',source:'課程校正'
              });
            }
          }

          const dateMoveRe=/(\d{1,2})\/(\d{1,2})(?:\([^)]*\))?[^()]*?調\s*(\d{1,2})\/(\d{1,2})/g;
          let m;
          while((m=dateMoveRe.exec(text))){
            const from=parseDateFlexible(m[1]+'/'+m[2],referenceDate);
            const to=parseDateFlexible(m[3]+'/'+m[4],referenceDate);
            if(!inlineStudent || !inlineTime) continue;
            pushCorrection({
              id:'CORR-NOTE-'+(i+1)+'-'+from+'-'+to+'-'+compact(inlineStudent),
              fixedId:'',originalDate:from,originalTime:inlineTime,action:'調課',
              newDate:to,newTime:inlineTime,student:inlineStudent,
              course:'',teacher:'',site:'',
              note:'來源：課程校正備註；'+line,source:'課程校正'
            });
          }

          // 「10/3嘉恆請假」以及「9/25~27p」：
          // 後者代表 9/25～9/27 整段期間請假，不是一般備註。
          const leaveRangeRe=/(\d{1,2})\/(\d{1,2})\s*[~～\-至]\s*(\d{1,2})\/(\d{1,2})[^()]*?(?:p)?\s*請?假|(?:\()?\s*(\d{1,2})\/(\d{1,2})\s*[~～\-至]\s*(\d{1,2})\/(\d{1,2})\s*p\s*\)?/gi;
          while((m=leaveRangeRe.exec(text))){
            const from=parseDateFlexible(m[1]+'/'+m[2],referenceDate);
            const to=parseDateFlexible(m[3]+'/'+m[4],referenceDate);
            if(!inlineStudent || !inlineTime || !from || !to) continue;
            for(let leaveDate=from; leaveDate<=to; leaveDate=addDays(leaveDate,1)){
              pushCorrection({
                id:'CORR-NOTE-LEAVE-'+(i+1)+'-'+leaveDate+'-'+compact(inlineStudent),
                fixedId:'',originalDate:leaveDate,originalTime:inlineTime,action:'請假',
                newDate:leaveDate,newTime:inlineTime,student:inlineStudent,
                course:'',teacher:'',site:'',
                note:'來源：課程校正備註；'+line+'（'+from+'～'+to+'請假）',source:'課程校正'
              });
            }
          }

          // 單日請假，例如「10/3嘉恆請假」。
          const leaveRe=/(\d{1,2})\/(\d{1,2})[^()]*請假/g;
          while((m=leaveRe.exec(text))){
            const from=parseDateFlexible(m[1]+'/'+m[2],referenceDate);
            if(!inlineStudent || !inlineTime) continue;
            pushCorrection({
              id:'CORR-NOTE-LEAVE-'+(i+1)+'-'+from+'-'+compact(inlineStudent),
              fixedId:'',originalDate:from,originalTime:inlineTime,action:'請假',
              newDate:from,newTime:inlineTime,student:inlineStudent,
              course:'',teacher:'',site:'',
              note:'來源：課程校正備註；'+line,source:'課程校正'
            });
          }

          // 「10/3理化加課」：建立一筆真正的新增課程。
          // 如果沒有寫課程名稱（例如「10/3加課」），則沿用正式欄位的「新課程」。
          const addRe=/(\d{1,2})\/(\d{1,2})\s*([^()（）]*?)\s*加課/g;
          while((m=addRe.exec(text))){
            const newDate=parseDateFlexible(m[1]+'/'+m[2],referenceDate);
            const course=str(m[3]) || str(r[h['新課程']]);
            if(!inlineStudent || !inlineTime) continue;
            pushCorrection({
              id:'CORR-NOTE-ADD-'+(i+1)+'-'+newDate+'-'+compact(inlineStudent)+'-'+inlineTime,
              fixedId:'',originalDate:'',originalTime:'',action:'加課',
              newDate,newTime:inlineTime,student:inlineStudent,
              course,teacher:str(r[h['新老師']]),site:'',
              note:'來源：課程校正備註；'+line,source:'課程校正'
            });
          }
        }
      }
    }
  }
  return out;
}

function parseInlineAdjustments(fixed, referenceDate=todayKey()){
  const out=[];
  for(const f of fixed){
    const raw=str(f.rawTime);
    const note=str(f.note);
    const text=raw+' '+note;

    // 例：1030-1200沄臻(10/10(六)調10/9b)
    // 只處理明確的「日期調到另一日期」，時間沿用原課時間。
    const dateMoveRe=/(\d{1,2})\/(\d{1,2})(?:\([^)]*\))?[^()]*?調\s*(\d{1,2})\/(\d{1,2})/g;
    let m;
    while((m=dateMoveRe.exec(text))){
      const from=parseDateFlexible(m[1]+'/'+m[2],referenceDate);
      const to=parseDateFlexible(m[3]+'/'+m[4],referenceDate);
      out.push({
        id:'INLINE-'+f.id+'-'+from+'-'+to,
        fixedId:f.id,originalDate:from,originalTime:f.time,action:'調課',
        newDate:to,newTime:f.time,student:f.student,course:f.course,teacher:f.teacher,
        site:f.site,note:'來源：固定課表備註；'+m[0],source:'固定課表備註'
      });
    }

    // 例：(9/26改1000-1200)
    const timeMoveRe=/(\d{1,2})\/(\d{1,2})[^()]*?改\s*(\d{3,4})(?:\s*[-~～至]\s*(\d{3,4}))?/g;
    while((m=timeMoveRe.exec(text))){
      const from=parseDateFlexible(m[1]+'/'+m[2],referenceDate);
      const nt=timeKey(m[3]);
      if(!nt)continue;
      out.push({
        id:'INLINE-TIME-'+f.id+'-'+from+'-'+nt,
        fixedId:f.id,originalDate:from,originalTime:f.time,action:'改時間',
        newDate:from,newTime:nt,student:f.student,course:f.course,teacher:f.teacher,
        site:f.site,note:'來源：固定課表備註；'+m[0],source:'固定課表備註'
      });
    }

    // 例：(10/3嘉恆請假)；只在明確包含「請假」時取消該日期的該學生課程。
    const leaveRe=/(\d{1,2})\/(\d{1,2})[^()]*請假/g;
    while((m=leaveRe.exec(text))){
      const from=parseDateFlexible(m[1]+'/'+m[2],referenceDate);
      out.push({
        id:'INLINE-LEAVE-'+f.id+'-'+from,
        fixedId:f.id,originalDate:from,originalTime:f.time,action:'請假',
        newDate:from,newTime:f.time,student:f.student,course:f.course,teacher:f.teacher,
        site:f.site,note:'來源：固定課表備註；'+m[0],source:'固定課表備註'
      });
    }
  }
  return out;
}
function parseContacts(rows){
  const hr=findHeaderRow(rows,['姓名','身分','LINE User ID','通知啟用']);
  if(hr<0) throw new Error('聯絡人欄位不正確：缺少姓名、身分、LINE User ID 或通知啟用。');
  const h=hmap(rows[hr]), out=[];
  const relationIndex=[
    h['學生姓名/關聯（可多位）'],
    h['學生姓名/關聯'],
    h['學生姓名／關聯（可多位）'],
    h['學生姓名／關聯'],
    h['學生姓名關聯']
  ].find(index=>index!==undefined);
  if(relationIndex===undefined) throw new Error('聯絡人欄位不正確：找不到「學生姓名/關聯」欄位（可接受「學生姓名/關聯（可多位）」）。');
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[];
    const userId=str(r[h['LINE User ID']]);
    if(!userId) continue;
    if(!isYes(r[h['通知啟用']])) continue;
    const role=str(r[h['身分']]);
    if(role!=='家長' && role!=='老師') continue;
    out.push({name:str(r[h['姓名']]),role,related:str(r[relationIndex]),userId});
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

function splitClassRoster(value){
  const text=str(value);
  const m=text.match(/^(.*?團班)\s*[（(]\s*([^）)]+)\s*[）)]\s*$/);
  if(!m) return {course:'',students:text};
  return {course:str(m[1]),students:str(m[2])};
}
function fullTime(start, end){
  const s=timeKey(start)||str(start);
  const e=timeKey(end)||str(end);
  return s&&e?s+'-'+e:s;
}
function buildRows(fixed, adjusts, fromDate, days){
  const out=[],byKey=new Map(),dateWide=new Map();
  const toDate=addDays(fromDate,days-1);
  const inWindow=d=>!!d&&d>=fromDate&&d<=toDate;
  const sourcePriority=a=>{
    const s=str(a.source);
    if(s.includes('課程校正')) return 4;
    if(s.includes('調課課程')) return 3;
    if(s.includes('開學課表')) return 2;
    if(s.includes('固定課表備註')) return 1;
    return 0;
  };
  const actionPriority=a=>{
    const action=norm(a.action);
    if(/取消|停課|請假/.test(action)) return 1;
    if(/改時間|改課|調課|移課/.test(action)) return 2;
    if(action==='延長時間') return 3;
    if(action==='延長時間待確認') return 9;
    return 4;
  };
  const orderedAdjusts=[...(adjusts||[])].sort((a,b)=>
    actionPriority(a)-actionPriority(b)||sourcePriority(b)-sourcePriority(a)||
    String(a.id||'').localeCompare(String(b.id||'')));
  const conflictGroups=new Map();
  for(const a of orderedAdjusts){
    if(!a.originalDate||!a.originalTime||!a.student) continue;
    const key=[a.originalDate,compact(a.student),timeKey(a.originalTime)].join('|');
    if(!conflictGroups.has(key)) conflictGroups.set(key,[]);
    conflictGroups.get(key).push(a);
  }
  for(const [key,group] of conflictGroups){
    if(group.length<2) continue;
    const signatures=new Set(group.map(a=>[norm(a.action),a.newDate||'',a.newTime||'',a.newEndTime||''].join('|')));
    if(signatures.size>1){
      console.warn('[SCHEDULE-ADJUST-CONFLICT] 同一課程有多筆不同校正，依優先順序採用第一筆', {
        key,selected:group[0].id||'(no id)',ignored:group.slice(1).map(x=>x.id||'(no id)')
      });
    }
  }

  for(const a of orderedAdjusts){
    if(!a.originalDate) continue;
    const action=norm(a.action);
    const isWholeDay=/整日/.test(action)&&!str(a.student);
    if(isWholeDay && /(?:停課|取消)/.test(action)){
      if(!dateWide.has(a.originalDate)) dateWide.set(a.originalDate,{cancel:true,moves:[]});
      dateWide.get(a.originalDate).cancel=true;
      continue;
    }
    if(isWholeDay && /(?:調課|移課|改課)/.test(action)){
      const nd=extractMoveDate(a.action,a.originalDate,a.originalDate)||a.newDate;
      if(nd && nd!==a.originalDate){
        if(!dateWide.has(a.originalDate)) dateWide.set(a.originalDate,{cancel:false,moves:[]});
        dateWide.get(a.originalDate).moves.push({...a,newDate:nd});
      }else{
        console.warn('[SCHEDULE-WHOLE-DAY-MOVE] 無效目的日期，保留原固定課程',a.id||'',a.originalDate,a.action);
      }
      continue;
    }
    const key=a.originalDate+'|'+compact(a.student)+'|'+(timeKey(a.originalTime)||a.originalTime);
    if(!byKey.has(key)) byKey.set(key,[]);
    byKey.get(key).push(a);
  }

  for(let d=fromDate;d<=toDate;d=addDays(d,1)){
    const wd=weekdayLabel(d);
    for(const f of fixed){
      if(!str(f.student)||isUnavailableSlot(f.student)) continue;
      if(f.until&&isValidDateKey(f.until)&&d>f.until) continue;
      if(norm(f.weekday)!==norm(wd)) continue;
      const base={
        date:d,weekday:wd,time:fullTime(f.time,f.endTime),student:f.student,course:f.course,
        teacher:f.teacher,site:f.site,source:'固定課表',fixedId:f.id,adjustId:'',
        adjustResult:'無',note:f.note||'',template:f.template||''
      };
      const wide=dateWide.get(d);
      const k=d+'|'+compact(f.student)+'|'+timeKey(f.time);
      const adj=byKey.get(k)||[];
      let handled=false;

      for(const a of adj){
        const action=norm(a.action);
        if(action==='延長時間待確認') continue;
        if(/取消|停課|請假/.test(action)){
          handled=true;
          break;
        }
        if(action==='延長時間'){
          const extensionEnd=a.newEndTime||parseTimeRange(a.newTime).end||'';
          if(extensionEnd){
            out.push({...base,time:fullTime(f.time,extensionEnd),adjustId:'',adjustResult:'已加時30分鐘',
              note:a.note||('原時段 '+fullTime(f.time,f.endTime)+'；加時後 '+fullTime(f.time,extensionEnd))});
            handled=true;
            break;
          }
          continue;
        }
        if(/改時間|改課|調課|移課/.test(action)){
          const nd=a.newDate||d;
          if(inWindow(nd)){
            const start=a.newTime||f.time;
            const end=a.newEndTime||parseTimeRange(a.newTime).end||f.endTime;
            out.push({...base,date:nd,weekday:weekdayLabel(nd),time:fullTime(start,end),
              student:f.student,course:f.course,teacher:f.teacher,site:f.site,source:'調課',
              fixedId:f.id,adjustId:a.id||'MOVE-'+d+'-'+nd,adjustResult:'已調課',note:a.note||''});
          }
          handled=true;
          break;
        }
      }

      if(!handled&&wide?.cancel) handled=true;
      if(!handled&&wide?.moves?.length){
        const validMoves=wide.moves.filter(a=>a.newDate&&a.newDate!==d);
        if(validMoves.length){
          for(const a of validMoves){
            const nd=a.newDate;
            if(!inWindow(nd)) continue;
            out.push({...base,date:nd,weekday:weekdayLabel(nd),
              time:fullTime(a.newTime||f.time,a.newEndTime||parseTimeRange(a.newTime).end||f.endTime),
              student:f.student,course:f.course,teacher:f.teacher,site:f.site,source:'調課',
              fixedId:f.id,adjustId:a.id||'DATE-MOVE-'+d+'-'+nd,adjustResult:'已調課',
              note:a.note||('整日調課：'+d+' → '+nd)});
          }
          handled=true;
        }
      }
      if(!handled) out.push(base);
    }
  }

  for(const a of orderedAdjusts){
    if(!a.originalDate||inWindow(a.originalDate)||!inWindow(a.newDate)||str(a.student)) continue;
    const action=norm(a.action);
    if(!/整日/.test(action)||!/(?:調課|移課|改課)/.test(action)) continue;
    const target=extractMoveDate(a.action,a.originalDate,a.originalDate)||a.newDate;
    if(!inWindow(target)||target===a.originalDate) continue;
    for(const f of fixed){
      if(!str(f.student)||isUnavailableSlot(f.student)||norm(f.weekday)!==norm(weekdayLabel(a.originalDate))) continue;
      if(f.until&&isValidDateKey(f.until)&&a.originalDate>f.until) continue;
      out.push({date:target,weekday:weekdayLabel(target),time:fullTime(f.time,f.endTime),
        student:f.student,course:f.course,teacher:f.teacher,site:f.site,source:'調課',
        fixedId:f.id,adjustId:a.id||'DATE-MOVE-'+a.originalDate+'-'+target,
        adjustResult:'已調課',note:a.note||('整日調課：'+a.originalDate+' → '+target),template:f.template||''});
    }
  }

  for(const a of orderedAdjusts){
    if(!a.originalDate||inWindow(a.originalDate)||!inWindow(a.newDate)) continue;
    const action=norm(a.action);
    if(!/改時間|改課|調課|移課/.test(action)||/整日/.test(action)) continue;
    if(/取消|停課|請假/.test(action)) continue;
    const members=normalizeMemberList(splitClassRoster(a.student).students);
    const f=fixed.find(x=>(a.fixedId&&x.id===a.fixedId)||
      (norm(x.weekday)===norm(weekdayLabel(a.originalDate))&&
       timeKey(x.time)===timeKey(a.originalTime)&&
       (compact(x.student)===compact(a.student)||members.includes(str(x.student)))));
    if(!f||!str(f.student)||isUnavailableSlot(f.student)) continue;
    const start=a.newTime||f.time;
    const end=a.newEndTime||parseTimeRange(a.newTime).end||f.endTime;
    out.push({date:a.newDate,weekday:weekdayLabel(a.newDate),time:fullTime(start,end),
      student:f.student,course:f.course,teacher:f.teacher,site:f.site,source:'調課',
      fixedId:f.id,adjustId:a.id||'MOVE-'+a.originalDate+'-'+a.newDate,adjustResult:'已調課',
      note:a.note||('由 '+a.originalDate+' 調至 '+a.newDate),template:f.template||''});
  }

  for(const a of orderedAdjusts){
    const action=norm(a.action);
    if(!/新增|補課|體驗|代課|加課/.test(action)||/取消|停課/.test(action)) continue;
    const addDate=a.newDate||a.originalDate;
    if(!inWindow(addDate)) continue;
    const fb=fixed.find(x=>x.id===a.fixedId);
    const start=a.newTime||a.originalTime||'';
    const end=a.newEndTime||parseTimeRange(a.newTime).end||fb?.endTime||'';
    if(!timeKey(start)) continue;
    const student=a.student||fb?.student||'';
    if(!student||isUnavailableSlot(student)) continue;
    if(!end) console.warn('[SCHEDULE-ADD-MISSING-END] 新增課程缺少下課時間，請檢查調課課程／課程校正列',a.id||'',student,addDate);
    out.push({date:addDate,weekday:weekdayLabel(addDate),time:fullTime(start,end),student,
      course:a.course||fb?.course||'',teacher:a.teacher||fb?.teacher||'',site:a.site||fb?.site||'',
      source:'調課',fixedId:fb?.id||'',adjustId:a.id||'NEW-'+addDate+'-'+compact(student),
      adjustResult:'新增調課',note:a.note||'單次加課',template:fb?.template||''});
  }

  const seen=new Set(),final=[];
  for(const x of out.sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)||a.student.localeCompare(b.student))){
    const roster=splitClassRoster(x.student);
    const course=x.course||roster.course;
    const members=normalizeMemberList(roster.course?roster.students:x.student);
    if(!members.length) continue;
    const range=parseTimeRange(x.time);
    const start=range.start||timeKey(x.time);
    const end=range.end||'';
    const isMulti=members.length>1;
    for(const member of members){
      const suffix=isMulti?'#'+member:'';
      const baseId=x.adjustId?(x.fixedId||'ADJ')+'-'+x.date+'-'+x.adjustId:(x.fixedId||'ADJ')+'-'+x.date;
      const courseId=baseId+suffix;
      const result=['無','已調課','新增調課','已加時30分鐘'].includes(x.adjustResult)?x.adjustResult:'無';
      const source=result==='已調課'||result==='新增調課'?'調課':'固定課表';
      const row=[courseId,x.date,weekdayLabel(x.date),fullTime(start,end),member,course,
        x.teacher,normalizeSite(x.site),source,x.fixedId||'',result==='已調課'||result==='新增調課'?(x.adjustId||''):'',
        result,x.note||'',start,end];
      const key=[row[0],row[1],row[3],row[4],row[5],row[6]].join('|');
      if(seen.has(key)) continue;
      seen.add(key);
      final.push(row);
    }
  }
  return final;
}

function mergeActualRows(rows, previousRows, fromDate, toDate){
  const previous=(previousRows||[]).slice(2).filter(row=>Array.isArray(row)&&row.some(value=>str(value)!==''));
  const inWindow=row=>{
    const date=dateKey(row?.[1]);
    return isValidDateKey(date)&&date>=fromDate&&date<=toDate;
  };
  const priorInWindow=previous.filter(inWindow);
  if(rows.length===0&&priorInWindow.length>0){
    throw new Error('安全保護：本次區間的實際課程結果為 0 筆，但區間內仍有 '+priorInWindow.length+' 筆舊課程；已拒絕清空資料，請先檢查來源解析及日期範圍。');
  }
  const normalizeRow=row=>{
    const out=(row||[]).slice(0,15);
    while(out.length<15) out.push('');
    const range=parseTimeRange(out[3]);
    if(!str(out[13])) out[13]=range.start||timeKey(out[3]);
    if(!str(out[14])) out[14]=range.end||'';
    return out;
  };
  const preserved=previous.filter(row=>!inWindow(row)).map(normalizeRow);
  const replacements=(rows||[]).map(normalizeRow);
  const merged=[...preserved,...replacements];
  merged.sort((a,b)=>dateKey(a[1]).localeCompare(dateKey(b[1]))||str(a[3]).localeCompare(str(b[3]))||str(a[4]).localeCompare(str(b[4])));
  return {merged,previousDataCount:previous.length};
}
async function writeActual(rows, previousRows=[], fromDate=todayKey(), toDate=fromDate){
  const {merged,previousDataCount}=mergeActualRows(rows,previousRows,fromDate,toDate);
  const lastExistingDataRow=Math.max(2,(previousRows||[]).length);
  if(merged.length){
    await retry('write 實際課程',()=>sheets.spreadsheets.values.update({
      spreadsheetId:SHEET_ID,
      range:qsheet('實際課程')+'!A3:O'+(merged.length+2),
      valueInputOption:'RAW',requestBody:{values:merged}
    }));
  }
  const newLastRow=merged.length+2;
  if(lastExistingDataRow>newLastRow){
    await retry('clear stale tail 實際課程',()=>sheets.spreadsheets.values.clear({
      spreadsheetId:SHEET_ID,
      range:qsheet('實際課程')+'!A'+(newLastRow+1)+':O'+lastExistingDataRow,
      requestBody:{}
    }));
  }
  return {previousDataCount,preservedOutsideWindow:Math.max(0,merged.length-rows.length),written:merged.length};
}
function actualObjects(actualRows){
  return actualRows.map(r=>{
    const range=parseTimeRange(r[3]);
    const start=range.start||timeKey(r[3]);
    const timeRange=range.start&&range.end?range.start+'-'+range.end:start;
    return {
      courseId:str(r[0]), date:dateKey(r[1]), weekday:str(r[2]), time:start, timeRange, endTime:range.end||'',
      student:str(r[4]), course:str(r[5]), teacher:str(r[6]), site:str(r[7]), source:str(r[8]),
      fixedId:str(r[9]), adjustId:str(r[10]), adjustResult:str(r[11]), note:str(r[12])
    };
  });
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

function normalizeMemberList(value){
  const roster=splitClassRoster(value);
  const source=roster.course?roster.students:value;
  const seen=new Set();
  const out=[];
  for(const item of split(source)){
    const name=str(item);
    if(!name) continue;
    const key=compact(name);
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function formatReminderMember(course, student){
  const c=str(course);
  const students=normalizeMemberList(student).join('、');
  if(!students) return c;
  if(/團班/.test(c)) return c+'('+students+')';
  return students;
}

function mergeReminderItems(items){
  const groups=new Map();
  for(const item of items){
    const normalizedItem={...item,site:normalizeSite(item.site)};
    const key=normalizedItem.role==='老師'
      ? [normalizedItem.role,compact(normalizedItem.recipient),normalizedItem.date,compact(normalizedItem.teacher),compact(normalizedItem.site)].join('|')
      : [normalizedItem.role,compact(normalizedItem.recipient),normalizedItem.date,normalizedItem.time,compact(normalizedItem.teacher),compact(normalizedItem.site)].join('|');
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(normalizedItem);
  }

  const merged=[];
  for(const group of groups.values()){
    const first=group[0];
    const courses=[],courseKeys=new Set(),studentsByCourse=new Map(),scheduleByTime=new Map();
    const parentStudents=[],parentKeys=new Set();
    for(const item of group){
      const course=str(item.course)||splitClassRoster(item.student).course;
      const courseKey=compact(course);
      if(course&&!courseKeys.has(courseKey)){ courseKeys.add(courseKey); courses.push(course); }
      const names=normalizeMemberList(item.student);
      if(item.role==='家長'){
        for(const name of names){
          const k=compact(name);
          if(!parentKeys.has(k)){parentKeys.add(k);parentStudents.push(name);}
        }
      }else{
        if(!studentsByCourse.has(courseKey)) studentsByCourse.set(courseKey,{course,names:[],seen:new Set()});
        const entry=studentsByCourse.get(courseKey);
        for(const name of names){
          const k=compact(name);
          if(!entry.seen.has(k)){entry.seen.add(k);entry.names.push(name);}
        }
        const time=str(item.timeRange)||fullTime(item.time,item.endTime)||timeKey(item.time)||str(item.time);
        if(time){
          if(!scheduleByTime.has(time)) scheduleByTime.set(time,new Map());
          const timeCourses=scheduleByTime.get(time);
          if(!timeCourses.has(courseKey)) timeCourses.set(courseKey,{course,names:[],seen:new Set()});
          const entryAtTime=timeCourses.get(courseKey);
          for(const name of names){
            const k=compact(name);
            if(!entryAtTime.seen.has(k)){entryAtTime.seen.add(k);entryAtTime.names.push(name);}
          }
        }
      }
    }

    const renderEntry=entry=>entry.course&&/團班/.test(entry.course)
      ? entry.course+'('+entry.names.join('、')+')'
      : entry.names.join('、');
    const teacherMembers=Array.from(studentsByCourse.values()).map(renderEntry).filter(Boolean);
    const scheduleLines=Array.from(scheduleByTime.entries())
      .sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([time,byCourse])=>time+' '+Array.from(byCourse.values()).map(renderEntry).filter(Boolean).join('、'))
      .join('\n');
    const members=first.role==='老師'?teacherMembers.join('、'):parentStudents.join('、');
    merged.push({...first,student:members,course:courses.join('、'),members,scheduleLines});
  }
  return merged;
}
function reminderGroupId(item){
  // 老師的提醒 ID 不含時間：同一天同校區只維持一個穩定提醒。
  const raw=item.role==='老師'
    ? [item.role,item.recipient,item.date,item.teacher,item.site].join('|')
    : [item.role,item.recipient,item.date,item.time,item.teacher,item.site].join('|');
  let hash=2166136261;
  for(let i=0;i<raw.length;i++){
    hash^=raw.charCodeAt(i);
    hash=Math.imul(hash,16777619);
  }
  const hex=(hash>>>0).toString(16).padStart(8,'0');
  const slot=item.role==='老師' ? 'DAILY' : item.time.replace(':','');
  return `MERGED-${item.date}-${slot}-${item.role}-${hex}`;
}

function makeReminderRows(actual, contacts, templates, settings, fixedTemplateById){
  const raw=[];
  const requireConfirm = isYes(settings.requireConfirm,true);

  for(const c of actual){
    if(c.adjustResult==='取消') continue;
    // 沒有有效學生／學生成員，或是「無法排課」佔位文字，不建立任何提醒。
    if(!str(c.student) || isUnavailableSlot(c.student)) continue;
    const slot=previousReminderSlot(c.date,settings);
    if(!slot.sendDate || !slot.sendTime) continue;
    const dateLabel=c.date.replaceAll('-','/');

    if(isYes(settings.parentNotify,true)){
      // 團班可能同時包含多位學生；家長匹配必須逐一拆開學生姓名，
      // 否則「葉依柔、陳翊森」會被當成單一姓名，導致兩位學生的家長都收不到通知。
      const roster=splitClassRoster(c.student);
      const studentMembers = normalizeMemberList(roster.course?roster.students:c.student);
      const parentStudents = studentMembers.length ? studentMembers : [c.student];
      for(const studentMember of parentStudents){
        for(const person of contacts.filter(x=>x.role==='家長' && includesStudent(x.related,studentMember))){
        const preferred = fixedTemplateById.get(c.fixedId) || '';
        const template=chooseTemplate(templates,'家長',preferred);
        raw.push({
          id:'',
          courseId:c.courseId,
          date:c.date,
          time:c.time,timeRange:c.timeRange||c.time,
          sendDate:slot.sendDate,
          sendTime:slot.sendTime,
          role:'家長',
          recipient:person.name,
          userId:person.userId,
          // 家長提醒使用單一學生名稱；課程名稱仍保留原本的團班名稱。
          student:studentMember,
          course:c.course||roster.course,
          teacher:c.teacher,
          site:c.site,
          template,
          dateLabel,
          confirm:requireConfirm?'否':'是'
        });
        }
      }
    }

    if(isYes(settings.teacherNotify,true)){
      for(const person of contacts.filter(x=>x.role==='老師' && compact(x.related)===compact(c.teacher))){
        const preferred=fixedTemplateById.get(c.fixedId) || '';
        const template=chooseTemplate(templates,'老師',preferred);
        raw.push({
          id:'',
          courseId:c.courseId,
          date:c.date,
          time:c.time,timeRange:c.timeRange||c.time,
          sendDate:slot.sendDate,
          sendTime:slot.sendTime,
          role:'老師',
          recipient:person.name,
          userId:person.userId,
          student:c.student,
          course:c.course,
          teacher:c.teacher,
          site:c.site,
          template,
          dateLabel,
          confirm:requireConfirm?'否':'是'
        });
      }
    }
  }

  const merged=mergeReminderItems(raw);
  return merged.map(x=>{
    const id=reminderGroupId(x);
    let content;
    if(x.role==='老師'){
      // 老師每日提醒固定採用：日期＋校區＋時段／學生清單。
      // 優先沿用模板中的開頭與「謝謝」後的簽名，避免覆蓋既有簽名。
      const renderedTemplate=safeReplaceTemplate(x.template,{
        日期:x.dateLabel,
        星期:weekdayLabel(x.date),
        時間:'',
        課程:x.course,
        老師:x.teacher,
        校區:x.site,
        學生:x.members || x.student,
        學生成員:x.scheduleLines || x.members || x.student
      });
      if(x.template){
        let teacherText=renderedTemplate;
        teacherText=teacherText.replace(/，?\s*於\s*於/g,'，於');
        teacherText=teacherText.replace(/([，,])?\s*謝謝！/,'\n謝謝！');
        if(x.scheduleLines){
          teacherText=teacherText.replace(/([，,])?\s*(謝謝！)/,'\n$2');
          teacherText=teacherText.replace(/(學生成員：)\s*/,'$1\n');
        }
        content=teacherText;
      }else{
        content=[
          `老師您好，提醒您於${x.dateLabel}(${weekdayLabel(x.date)})，於${x.site}有課程，學生成員：`,
          x.scheduleLines || x.members || x.student,
          '謝謝！'
        ].join('\n');
      }
    }else{
      content=safeReplaceTemplate(x.template,{
        學生:x.members || x.student,
        日期:x.dateLabel,
        星期:weekdayLabel(x.date),
        時間:x.timeRange || x.time,
        課程:x.course,
        老師:x.teacher,
        校區:x.site,
        學生成員:x.members || x.student
      });
    }
    return {
      key:id+'|'+x.role+'|'+x.recipient,
      id,courseId:x.courseId,date:x.date,time:x.time,sendDate:x.sendDate,sendTime:x.sendTime,
      role:x.role,recipient:x.recipient,userId:x.userId,student:x.members||x.student,
      course:x.course,teacher:x.teacher,site:x.site,content,confirm:x.confirm
    };
  });;
}

async function syncReminders(actualRows, reminderRows, contacts, templates, settings, fromDate, days, fixedTemplateByIdInput){
  await ensureSheet('課程提醒');
  const fixedTemplateById=new Map();
  for(const f of fixedTemplateByIdInput) fixedTemplateById.set(f.id,f.template || '');
  const expected=(AUTO_CREATE_REMINDERS&&isYes(settings.enabled))?makeReminderRows(actualObjects(actualRows),contacts,templates,settings,fixedTemplateById):[];
  const expectedKeys=new Set(expected.map(x=>x.id+'|'+x.role+'|'+x.recipient));
  const expectedLogicalKeys=new Set(expected.map(x=>{
    if(x.role==='老師'){
      return [x.role,compact(x.recipient),x.date,compact(x.teacher),compact(x.site)].join('|');
    }
    return [x.role,compact(x.recipient),x.date,x.time,compact(x.teacher),compact(x.site)].join('|');
  }));
  // 以邏輯群組建立索引。舊版提醒 ID 可能不同，因此不能只靠 ID 判斷；
  // 只要日期／身分／收件人／老師／校區相同，就同步最新合併內容並保留原 ID。
  const parsed=parseReminderRows(reminderRows);
  const hasReminderData=(reminderRows||[]).some(row=>Array.isArray(row)&&row.some(value=>str(value)!==''));
  if(parsed.headerRow<0 && hasReminderData){
    throw new Error('課程提醒已有資料但找不到標準標題列；為避免覆寫既有資料，已停止同步。');
  }
  const headers=parsed.headers?.length ? parsed.headers : REMINDER_HEADERS;
  const h=hmap(headers);
  const missingReminderHeaders=REMINDER_HEADERS.filter(name=>h[name]===undefined);
  if(parsed.headerRow>=0 && missingReminderHeaders.length){
    throw new Error('課程提醒缺少必要欄位：'+missingReminderHeaders.join('、')+'；已停止同步，未寫入提醒。');
  }
  const logicalKeyForExpected=x=>x.role==='老師'
    ? [x.role,compact(x.recipient),x.date,compact(x.teacher),compact(x.site)].join('|')
    : [x.role,compact(x.recipient),x.date,x.time,compact(x.teacher),compact(x.site)].join('|');
  const logicalKeyForOld=old=>old.role==='老師'
    ? [old.role,compact(old.recipient),old.date,compact(String(old.values[h['老師']]||'')),compact(normalizeSite(old.values[h['校區']]))].join('|')
    : [old.role,compact(old.recipient),old.date,old.time,compact(String(old.values[h['老師']]||'')),compact(normalizeSite(old.values[h['校區']]))].join('|');
  const oldByLogicalKey=new Map();
  for(const old of parsed.rows){
    const isGenerated = /-(?:P|T)$/.test(old.id) || old.id.startsWith('MERGED-');
    if(!isGenerated) continue; // 手動提醒（例如 TEST-...）不可被自動同步覆寫。
    const logicalKey=logicalKeyForOld(old);
    if(!oldByLogicalKey.has(logicalKey)) oldByLogicalKey.set(logicalKey,old);
  }

  const width=Math.max(headers.length, REMINDER_HEADERS.length);
  const updates=[];
  const append=[];
  let created=0, updated=0, disabled=0;
  const existingByKey=new Map();
  for(const row of parsed.rows){ existingByKey.set(`${row.id}|${row.role}|${row.recipient}`,row); }
  const matchedOldRowIndexes=new Set();

  const toOutput = x => {
    const arr=new Array(width).fill('');
    const set=(name,val)=>{ if(h[name] !== undefined) arr[h[name]]=val; };
    set('提醒ID',x.id); set('課程日期',x.date); set('上課時間',x.time); set('發送日期',x.sendDate); set('發送時間',x.sendTime);
    set('身分',x.role); set('收件人',x.recipient); set('學生/學生成員',x.student); set('課程',x.course); set('老師',x.teacher); set('校區',x.site); set('訊息內容',x.content); set('確認發送',x.confirm);
    return arr;
  };

  for(const x of expected){
    const exactKey=`${x.id}|${x.role}|${x.recipient}`;
    // 先以 ID 精確比對；若 ID 改版，再以提醒的邏輯群組沿用舊列，
    // 避免同一個提醒同時新增新 ID、又保留舊 ID 而產生重複。
    const old=existingByKey.get(exactKey) || oldByLogicalKey.get(logicalKeyForExpected(x));
    if(old && !matchedOldRowIndexes.has(old.rowIndex)){
      matchedOldRowIndexes.add(old.rowIndex);
      const row=old.values.slice();
      while(row.length<width) row.push('');
      const getIdx=name=>h[name]===undefined?-1:h[name];
      const preserveMsg = str(row[getIdx('訊息內容')]);
      const preserveConfirm = str(row[getIdx('確認發送')]);
      const isGeneratedReminder = /-(?:P|T)$/.test(old.id) || old.id.startsWith('MERGED-');
      Object.assign(row, toOutput({...x,id:old.id}));
      // 自動產生的提醒（包含 MERGED- 每日老師提醒）必須同步最新學生成員與訊息內容。
      // 手動建立的提醒（例如 TEST-...）仍保留人工編輯過的訊息。
      if(preserveMsg && !isGeneratedReminder) row[getIdx('訊息內容')]=preserveMsg;
      const hasUserVisibleContent =
        !!str(row[getIdx('學生/學生成員')]) ||
        !!str(row[getIdx('課程')]) ||
        !!str(row[getIdx('訊息內容')]);
      if(preserveConfirm&&hasUserVisibleContent){
        row[getIdx('確認發送')]=isYes(preserveConfirm)?'是':(isNo(preserveConfirm)?'否':x.confirm);
      }
      updates.push({rowNumber:old.rowIndex,values:row});
      updated++;
    }else{
      append.push(toOutput(x));
      created++;
    }
  }

  // 課程被停用／刪除後，如果同一個提醒群組仍存在（例如老師當天還有其他學生），
  // 直接重建該提醒內容，不需要人工刪除；只有整個群組都不存在時才停用。
  for(const old of parsed.rows){
    if(matchedOldRowIndexes.has(old.rowIndex)) continue;

    const isGenerated = /-(?:P|T)$/.test(old.id) || old.id.startsWith('MERGED-');
    const inWindow = old.date && old.date>=fromDate && old.date<=addDays(fromDate,days-1);
    if(!inWindow || !isGenerated) continue;

    // 沒有被任何目前應存在的提醒配對到，代表這是重複或已失效的舊列。
    // 若已清空學生／課程／訊息且「確認發送」為「否」，保留作為稽核紀錄，不重複寫入或重複計數。
    const row=old.values.slice();
    while(row.length<width) row.push('');
    const alreadyDisabled =
      !str(row[h['學生/學生成員']]) &&
      !str(row[h['課程']]) &&
      !str(row[h['訊息內容']]) &&
      norm(row[h['確認發送']])==='否';
    if(alreadyDisabled) continue;
    if(h['學生/學生成員']!==undefined) row[h['學生/學生成員']]='';
    if(h['課程']!==undefined) row[h['課程']]='';
    if(h['訊息內容']!==undefined) row[h['訊息內容']]='';
    if(h['確認發送']!==undefined) row[h['確認發送']]='否';
    updates.push({rowNumber:old.rowIndex,values:row});
    disabled++;
  }

  const batchData=[];

  for(const u of updates){
    batchData.push({
      range:`${qsheet('課程提醒')}!A${u.rowNumber}:${String.fromCharCode(64+Math.min(width,26))}${u.rowNumber}`,
      values:[u.values]
    });
  }

  if(append.length){
    const startRow=parsed.rows.length ? Math.max(...parsed.rows.map(r=>r.rowIndex))+1 : (parsed.headerRow>=0 ? parsed.headerRow+2 : 2);
    batchData.push({
      range:`${qsheet('課程提醒')}!A${startRow}:${String.fromCharCode(64+Math.min(width,26))}${startRow+append.length-1}`,
      values:append
    });
  }

  if(parsed.headerRow<0){
    batchData.unshift({
      range:`${qsheet('課程提醒')}!A1:M1`,
      values:[REMINDER_HEADERS]
    });
  }

  if(batchData.length){
    await retry('batch update 課程提醒',()=>sheets.spreadsheets.values.batchUpdate({
      spreadsheetId:SHEET_ID,
      requestBody:{valueInputOption:'RAW',data:batchData}
    }));
  }
  return {expectedCount:expected.length,created,updated,disabled,reminderServiceEnabled:isYes(settings.enabled)&&AUTO_CREATE_REMINDERS,lineSending:false};
}


function columnLetter(n){
  let out='';
  while(n>0){ const r=(n-1)%26; out=String.fromCharCode(65+r)+out; n=Math.floor((n-1)/26); }
  return out;
}

// 每次手動呼叫 /build 時，先讀取「開學課表」並把尚未存在的固定課表／調課資料補入。
// 安全原則：只新增來源中缺少的列，不刪除或覆寫現有列；既有人工資料保留。
async function syncSourceIntoSchedule(referenceDate=todayKey()){
  // 在「系統設定」新增可手動切換的「轉譯開學課表」；未設定時預設開啟。
  const settingsRead=await retry('read source translation setting',()=>sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:qsheet('系統設定')+'!A:Z'}));
  const settingsRows=settingsRead.data.values||[];
  let translationRow=-1;
  for(let i=0;i<settingsRows.length;i++){
    if(str(settingsRows[i]?.[0])==='轉譯開學課表'){ translationRow=i+1; break; }
  }
  let translateSource='是';
  if(translationRow<0){
    await retry('add source translation setting',()=>sheets.spreadsheets.values.append({spreadsheetId:SHEET_ID,range:qsheet('系統設定')+'!A:B',valueInputOption:'RAW',insertDataOption:'INSERT_ROWS',requestBody:{values:[['轉譯開學課表','是']]}}));
  }else{
    translateSource=str(settingsRows[translationRow-1]?.[1]) || '是';
  }
  if(!isYes(translateSource)){
    return {sourceSheet:'開學課表',translationEnabled:false,sourceFixedParsed:0,sourceAdjustmentsParsed:0,fixedAdded:0,fixedCorrected:0,adjustmentsAdded:0,existingRowsPreserved:true,skipped:true};
  }
  const year=Number(String(referenceDate).slice(0,4))||Number(todayKey().slice(0,4));
  const {rawRows,fixedRows,adjustRows,themeColors}=await readRawSourcePreview();
  const parsed=parseRawSchedule(rawRows,year,themeColors);
  const fixedHeaderRow=findHeaderRow(fixedRows,['固定課表ID','星期','上課時間','學生','課程','老師','校區','有效迄日','啟用']);
  if(fixedHeaderRow<0) throw new Error('來源同步停止：固定課表欄位不正確，沒有寫入任何資料。');
  const adjustHeaderRow=findHeaderRow(adjustRows,['調課ID','原固定課表ID','原日期','原時間','動作','新日期','新時間','學生','確認']);
  if(adjustHeaderRow<0) throw new Error('來源同步停止：調課課程欄位不正確；尚未寫入固定課表或調課資料。');
  const fixedHeaders=(fixedRows[fixedHeaderRow]||[]).map(str);
  const fh=hmap(fixedHeaders);
  const existingFixedIds=new Set();
  const existingFixedKeys=new Set();
  const existingFixedById=new Map();
  for(let i=fixedHeaderRow+1;i<fixedRows.length;i++){
    const r=fixedRows[i]||[];
    const id=str(r[fh['固定課表ID']]);
    if(!id) continue;
    existingFixedIds.add(id);
    existingFixedKeys.add(rawFixedLogicalKey({
      weekday:str(r[fh['星期']]),
      time:str(r[fh['上課時間']]),
      student:str(r[fh['學生']]),
      teacher:str(r[fh['老師']])
    }));
    existingFixedById.set(id,{rowNumber:i+1,values:r});
  }
  const matchedFixed=matchRawFixedIds(parsed.fixed,fixedRows);
  const fixedToAdd=matchedFixed.filter(x=>!existingFixedIds.has(x.id) && !existingFixedKeys.has(rawFixedLogicalKey(x)));
  const makeFixedRow=x=>{
    const row=new Array(fixedHeaders.length).fill('');
    const set=(name,value)=>{ if(fh[name]!==undefined) row[fh[name]]=value??''; };
    set('固定課表ID',x.id);
    set('星期',x.weekday);
    set('上課時間',x.time+(x.endTime?'-'+x.endTime:''));
    set('學生',x.student);
    set('課程',x.course||'');
    set('老師',x.teacher);
    set('校區',normalizeSite(x.site));
    set('有效迄日',x.untilDate||'');
    set('啟用',x.colorStatus==='yellow'?'否':'是');
    set('備註','來源：開學課表自動同步'+(x.colorStatus==='yellow'?'；黃色確認中，預設停用；字色 '+(x.colorHex||'未知'):'')+(x.note?'；'+x.note:''));
    set('通知模板','家長一般/老師通知');
    return row;
  };
  const fixedOutput=fixedToAdd.map(makeFixedRow);
  const fixedUpdates=[];
  // 只更新來源管理列的課程欄位；「啟用」與備註保留人工決策。
  for(const x of matchedFixed){
    const old=existingFixedById.get(x.id);
    if(!old) continue;
    const oldNote=fh['備註']===undefined?'':str(old.values[fh['備註']]);
    if(!oldNote.includes('來源：開學課表自動同步')) continue;
    const row=old.values.slice();
    while(row.length<fixedHeaders.length) row.push('');
    const set=(name,value)=>{ if(fh[name]!==undefined) row[fh[name]]=value??''; };
    set('星期',x.weekday);
    set('上課時間',x.time+(x.endTime?'-'+x.endTime:''));
    set('學生',x.student);
    set('課程',x.course||'');
    set('老師',x.teacher);
    set('校區',normalizeSite(x.site));
    set('有效迄日',x.untilDate||'');
    if(x.colorStatus==='yellow'){
      if(fh['啟用']!==undefined) row[fh['啟用']]='否';
      if(fh['備註']!==undefined&&!oldNote.includes('黃色確認中')) row[fh['備註']]=oldNote+'；黃色確認中，預設停用；字色 '+(x.colorHex||'未知');
    }else if(x.colorStatus==='black'&&oldNote.includes('黃色確認中')){
      if(fh['啟用']!==undefined) row[fh['啟用']]='是';
      if(fh['備註']!==undefined) row[fh['備註']]=oldNote.replace(/；黃色確認中，預設停用；字色 [^；]*/,'；黃色確認已解除（來源字色已轉黑）');
    }
    if(JSON.stringify(old.values.slice(0,fixedHeaders.length))!==JSON.stringify(row.slice(0,fixedHeaders.length))){
      fixedUpdates.push({rowNumber:old.rowNumber,values:row.slice(0,fixedHeaders.length)});
    }
  }
  const blockedSourceKeys=new Set(
    [...(parsed.redItems||[]),...(parsed.unclassifiedItems||[])].map(rawFixedLogicalKey)
  );
  // 已由舊版錯誤匯入的「無法排課」佔位列，不再當成課程；僅停用程式自動建立的列。
  for(const [id,old] of existingFixedById){
    const oldNote=fh['備註']===undefined?'':str(old.values[fh['備註']]);
    const oldStudent=fh['學生']===undefined?'':str(old.values[fh['學生']]);
    if(!oldNote.includes('來源：開學課表自動同步') || !isUnavailableSlot(oldStudent)) continue;
    const row=old.values.slice();
    while(row.length<fixedHeaders.length) row.push('');
    if(fh['啟用']!==undefined) row[fh['啟用']]='否';
    if(fh['備註']!==undefined) row[fh['備註']]='來源：開學課表自動同步；已排除不可排課時段';
    fixedUpdates.push({rowNumber:old.rowNumber,values:row.slice(0,fixedHeaders.length)});
  }
  const rowsAlreadyCorrected=new Set(fixedUpdates.map(u=>u.rowNumber));
  // Older parser versions may have imported "芯瑜+30min" as a weekly student.
  // Disable only rows owned by this importer; never touch manually maintained rows.
  for(const [id,old] of existingFixedById){
    if(rowsAlreadyCorrected.has(old.rowNumber)) continue;
    const oldNote=fh['備註']===undefined?'':str(old.values[fh['備註']]);
    const oldStudent=fh['學生']===undefined?'':str(old.values[fh['學生']]);
    if(!oldNote.includes('來源：開學課表自動同步') || !/(?:\+|＋)\s*30\s*min/i.test(oldStudent)) continue;
    const row=old.values.slice();
    while(row.length<fixedHeaders.length) row.push('');
    if(fh['啟用']!==undefined) row[fh['啟用']]='否';
    if(fh['備註']!==undefined) row[fh['備註']]='來源：開學課表自動同步；已轉為指定日期加時規則，不再作為每週固定課程';
    fixedUpdates.push({rowNumber:old.rowNumber,values:row.slice(0,fixedHeaders.length)});
  }
  for(const [id,old] of existingFixedById){
    if(rowsAlreadyCorrected.has(old.rowNumber)) continue;
    const oldNote=fh['備註']===undefined?'':str(old.values[fh['備註']]);
    if(!oldNote.includes('來源：開學課表自動同步')) continue;
    const oldKey=rawFixedLogicalKey({
      weekday:str(old.values[fh['星期']]),
      time:str(old.values[fh['上課時間']]),
      student:str(old.values[fh['學生']]),
      teacher:str(old.values[fh['老師']])
    });
    if(!blockedSourceKeys.has(oldKey)) continue;
    const row=old.values.slice();
    while(row.length<fixedHeaders.length) row.push('');
    if(fh['啟用']!==undefined) row[fh['啟用']]='否';
    if(fh['備註']!==undefined) row[fh['備註']]='來源：開學課表自動同步；來源字色為紅色或無法判讀，已停用';
    fixedUpdates.push({rowNumber:old.rowNumber,values:row.slice(0,fixedHeaders.length)});
  }
  // 使用者已確認目前有效課程的預設校區為「愛學館信義光復校」。
  // 將有效、具學生姓名、校區空白的既有列補上預設校區；不改動停用列或不可排課佔位列。
  const alreadyUpdatedRows=new Set(fixedUpdates.map(u=>u.rowNumber));
  for(const [id,old] of existingFixedById){
    if(alreadyUpdatedRows.has(old.rowNumber)) continue;
    const row=old.values.slice();
    while(row.length<fixedHeaders.length) row.push('');
    const student=str(row[fh['學生']]);
    if(!isYes(row[fh['啟用']]) || !student || isUnavailableSlot(student)) continue;
    if(str(row[fh['校區']])) continue;
    row[fh['校區']]=DEFAULT_SITE;
    fixedUpdates.push({rowNumber:old.rowNumber,values:row.slice(0,fixedHeaders.length)});
  }
  // 來源本次已不再出現的自動固定課表，停用而不刪除；手動列完全不動。
  if(parsed.fixed.length>0){
    const activeSourceIds=new Set(matchedFixed.map(x=>x.id));
    const alreadyChanged=new Set(fixedUpdates.map(x=>x.rowNumber));
    for(const [id,old] of existingFixedById){
      if(activeSourceIds.has(id)||alreadyChanged.has(old.rowNumber)) continue;
      const oldNote=fh['備註']===undefined?'':str(old.values[fh['備註']]);
      if(!oldNote.includes('來源：開學課表自動同步')) continue;
      const row=old.values.slice();
      while(row.length<fixedHeaders.length) row.push('');
      if(fh['啟用']!==undefined) row[fh['啟用']]='否';
      if(fh['備註']!==undefined&&!oldNote.includes('本次來源已無此列，已停用')){
        row[fh['備註']]=oldNote+'；本次來源已無此列，已停用';
      }
      fixedUpdates.push({rowNumber:old.rowNumber,values:row.slice(0,fixedHeaders.length)});
    }
  }
  const adjustHeaders=(adjustRows[adjustHeaderRow]||[]).map(str);
  const ah=hmap(adjustHeaders);
  const existingAdjustIds=new Set();
  for(let i=adjustHeaderRow+1;i<adjustRows.length;i++){
    const id=str((adjustRows[i]||[])[ah['調課ID']]);
    if(id) existingAdjustIds.add(id);
  }
  const fixedIdByKey=new Map(matchedFixed.map(x=>[rawFixedLogicalKey(x),x.id]));
  const assignedAdjustments=assignPreviewAdjustmentIds(
    parsed.adjustments.map(x=>({...x,fixedId:fixedIdByKey.get([
      norm(x.weekday),
      parseTimeRange(x.originalTime).start||timeKey(x.originalTime),
      compact(stripScheduleAnnotation(x.student)),
      compact(stripScheduleAnnotation(x.teacher))
    ].join('|'))||x.fixedId||''})),
    adjustRows
  );
  const activeSourceAdjustIds=new Set(assignedAdjustments.map(x=>x.id));
  const adjustUpdates=[];
  if(parsed.fixed.length>0){
    for(let i=adjustHeaderRow+1;i<adjustRows.length;i++){
      const oldRow=adjustRows[i]||[];
      const id=str(oldRow[ah['調課ID']]);
      if(!id||activeSourceAdjustIds.has(id)) continue;
      const note=ah['備註']===undefined?'':str(oldRow[ah['備註']]);
      if(!note.includes('來源：開學課表')) continue;
      const row=oldRow.slice();
      while(row.length<adjustHeaders.length) row.push('');
      if(ah['確認']!==undefined) row[ah['確認']]='否';
      if(ah['備註']!==undefined&&!note.includes('本次來源已無此列，已停用')) row[ah['備註']]=note+'；本次來源已無此列，已停用';
      adjustUpdates.push({rowNumber:i+1,values:row.slice(0,adjustHeaders.length)});
    }
  }
  const adjustToAdd=assignedAdjustments.filter(x=>x.id && !existingAdjustIds.has(x.id));
  const adjustOutput=adjustToAdd.map(x=>{
    const row=new Array(adjustHeaders.length).fill('');
    const set=(name,value)=>{ if(ah[name]!==undefined) row[ah[name]]=value??''; };
    set('調課ID',x.id);
    set('原固定課表ID',x.fixedId||'');
    set('原日期',x.originalDate||'');
    set('原時間',x.originalTime||'');
    set('動作',x.action||'');
    set('新日期',x.newDate||'');
    set('新時間',x.newTime||'');
    set('學生',x.student||'');
    set('新課程',x.course||'');
    set('新老師',x.teacher||'');
    set('新校區',x.site||'');
    set('確認','是');
    set('備註',x.note||'來源：開學課表自動解析');
    return row;
  });
  const sourceWriteData=[];
  for(const u of fixedUpdates){
    sourceWriteData.push({
      range:qsheet('固定課表')+'!A'+u.rowNumber+':'+columnLetter(fixedHeaders.length)+u.rowNumber,
      values:[u.values]
    });
  }
  for(const u of adjustUpdates){
    sourceWriteData.push({
      range:qsheet('調課課程')+'!A'+u.rowNumber+':'+columnLetter(adjustHeaders.length)+u.rowNumber,
      values:[u.values]
    });
  }
  if(fixedOutput.length){
    const start=fixedRows.length+1;
    sourceWriteData.push({
      range:qsheet('固定課表')+'!A'+start+':'+columnLetter(fixedHeaders.length)+(start+fixedOutput.length-1),
      values:fixedOutput
    });
  }
  if(adjustOutput.length){
    const start=adjustRows.length+1;
    sourceWriteData.push({
      range:qsheet('調課課程')+'!A'+start+':'+columnLetter(adjustHeaders.length)+(start+adjustOutput.length-1),
      values:adjustOutput
    });
  }
  // 將固定課表修正、新增固定課表與新增調課合併為單一 Sheets 寫入請求，
  // 避免中途 API 失敗時只完成一半來源同步。
  if(sourceWriteData.length){
    await retry('batch sync source schedule',()=>sheets.spreadsheets.values.batchUpdate({
      spreadsheetId:SHEET_ID,
      requestBody:{valueInputOption:'RAW',data:sourceWriteData}
    }));
  }
  return {
    sourceSheet:'開學課表',
    sourceFixedParsed:parsed.fixed.length,
    sourceAdjustmentsParsed:parsed.adjustments.length,
    fixedAdded:fixedOutput.length,
    fixedCorrected:fixedUpdates.length,
    adjustmentsAdded:adjustOutput.length,
    existingRowsPreserved:true,
    translationEnabled:true
  };
}

function missingReminderTimeWarnings(actualRows, contacts, settings){
  if(!AUTO_CREATE_REMINDERS||!isYes(settings.enabled)) return [];
  const missingByDay=new Map();
  const add=(day,key)=>{
    if(!missingByDay.has(day)) missingByDay.set(day,new Set());
    missingByDay.get(day).add(key);
  };
  for(const c of actualObjects(actualRows)){
    if(c.adjustResult==='取消'||!c.student||isUnavailableSlot(c.student)) continue;
    const slot=previousReminderSlot(c.date,settings);
    if(slot.sendTime) continue;
    const day=weekdayLabel(slot.sendDate);
    if(isYes(settings.parentNotify,true)){
      const roster=splitClassRoster(c.student);
      const members=normalizeMemberList(roster.course?roster.students:c.student);
      for(const name of members){
        for(const person of contacts.filter(x=>x.role==='家長'&&includesStudent(x.related,name))){
          add(day,['家長',compact(person.name),c.date,c.time,compact(c.teacher),compact(c.site)].join('|'));
        }
      }
    }
    if(isYes(settings.teacherNotify,true)){
      for(const person of contacts.filter(x=>x.role==='老師'&&compact(x.related)===compact(c.teacher))){
        add(day,['老師',compact(person.name),c.date,compact(c.teacher),compact(c.site)].join('|'));
      }
    }
  }
  return Array.from(missingByDay.entries()).filter(([,keys])=>keys.size)
    .map(([day,keys])=>'週'+day+'發送時間是空的，已略過 '+keys.size+' 筆提醒');
}

async function build({fromDate=todayKey(),days=DEFAULT_DAYS}={}){
  if(!isValidDateKey(fromDate)) throw new Error('fromDate 必須是有效的 YYYY-MM-DD 日期');
  if(!Number.isInteger(days)||days<1||days>180) throw new Error('days 必須是 1 到 180 的整數');
  const sourceSync=await syncSourceIntoSchedule(fromDate);
  await ensureSheet('課程提醒');
  await ensureSheetHeaders('課程校正',CORRECTION_HEADERS);
  const [settingsRows,fixedRows,adjustRows,correctionRows,oldActualRows,contactRows,templateRows,reminderRows] = await readSheets();
  const settings=parseSettings(settingsRows);
  const fixed=parseFixed(fixedRows,fromDate); const adjusts=[...parseAdjust(adjustRows,correctionRows,fromDate),...parseInlineAdjustments(fixed,fromDate)]; const contacts=parseContacts(contactRows); const templates=parseTemplates(templateRows);
  const fixedTemplateByIdInput=fixed;
  const actual=buildRows(fixed,adjusts,fromDate,days);

  // 建立完成後再次確認少禹是否真的進入實際課程。
  const diagFixed=fixed.filter(f=>['陳少禹','少禹'].some(n=>compact(f.student)===compact(n)));
  const diagActual=actualObjects(actual).filter(x=>['陳少禹','少禹'].some(n=>compact(x.student)===compact(n)));
  console.log('[SCHEDULE-DIAG] 少禹 Build 結果', {
    fromDate,
    toDate:addDays(fromDate,days-1),
    fixedMatches:diagFixed.map(f=>({id:f.id,weekday:f.weekday,time:f.time,endTime:f.endTime,until:f.until,course:f.course,teacher:f.teacher,site:f.site,note:f.note})),
    actualMatches:diagActual.map(x=>({courseId:x.courseId,date:x.date,weekday:x.weekday,time:x.time,student:x.student,course:x.course,teacher:x.teacher,site:x.site,source:x.source,fixedId:x.fixedId,adjustId:x.adjustId,adjustResult:x.adjustResult,note:x.note}))
  });
  const toDate=addDays(fromDate,days-1);
  const warnings=missingReminderTimeWarnings(actual,contacts,settings);
  await writeActual(actual,oldActualRows,fromDate,toDate);
  const reminder=await syncReminders(actual,reminderRows,contacts,templates,settings,fromDate,days,fixedTemplateByIdInput);
  return {ok:true,fromDate,toDate,sourceSync,fixedCount:fixed.length,adjustCount:adjusts.length,actualCount:actual.length,reminder,warnings};
}

let lastBuild={status:'not_run'};
let buildInProgress=null;
app.get('/health',(req,res)=>res.json({ok:true,service:'line-course-schedule-manager-v1.2',timezone:TZ,lastBuild}));
async function buildOnce(options){
  if(buildInProgress) throw Object.assign(new Error('已有 /build 正在執行；本次參數沒有被覆蓋，請稍後重新送出。'),{statusCode:409});
  const task=build(options);
  buildInProgress=task;
  try { return await task; }
  finally { if(buildInProgress===task) buildInProgress=null; }
}

app.get('/build',async(req,res)=>{
  if(!adminAuthorized(req)) return res.status(process.env.SCHEDULE_ADMIN_TOKEN?401:503).json({ok:false,error:process.env.SCHEDULE_ADMIN_TOKEN?'未授權，請提供有效的管理員 token。':'尚未設定 SCHEDULE_ADMIN_TOKEN；為保護 Google Sheet，已停用 /build。'});
  try{
    const fromDate=req.query.from || todayKey();
    const days=req.query.days===undefined?DEFAULT_DAYS:Number(req.query.days);
    if(!isValidDateKey(fromDate)) return res.status(400).json({ok:false,error:'from 必須是有效的 YYYY-MM-DD 日期。'});
    if(!Number.isInteger(days)||days<1||days>180) return res.status(400).json({ok:false,error:'days 必須是 1 到 180 的整數。'});
    lastBuild=await buildOnce({fromDate,days}); lastBuild.at=new Date().toISOString();
    res.json(lastBuild);
  }catch(e){ lastBuild={status:'error',error:e.message,at:new Date().toISOString()}; console.error(e); res.status(e.statusCode||500).json(lastBuild); }
});


function stripScheduleAnnotation(value){
  return str(value)
    // 開學課表常見未閉合註記，例如「繹桓(9/25p調10/5b」。
    .replace(/[（(](?=[^）)]*(?:\d{1,2}\/\d{1,2}|調課|調|請假|加時|加課|補課|改課|代課|停課|僅|\bp\b|\bb\b))[\s\S]*$/i,'')
    .trim();
}
function isUnavailableSlot(value){
  const cleaned=str(value).replace(/[\s　]/g,'').replace(/^\d{1,2}:?\d{2}/,'').replace(/^[：:、，,]+/,'');
  return /^(?:無法排課|時段不能排課|不能排課|不可排課|無法安排|休息時段)$/i.test(cleaned);
}
function rawCellText(cell){
  if(cell && typeof cell === 'object' && !Array.isArray(cell) && Object.prototype.hasOwnProperty.call(cell,'value')) return str(cell.value);
  return str(cell);
}

function rawFormatColor(format, themeColors = {}){
  if(!format || typeof format !== 'object') return null;
  const style=format.foregroundColorStyle;
  const direct=format.foregroundColor;
  const toRgb=rgb=>{
    if(!rgb || typeof rgb !== 'object' || !['red','green','blue'].some(k=>typeof rgb[k]==='number')) return null;
    const cv=v=>{
      const n=Number(v||0);
      return Math.max(0,Math.min(255,Math.round(n<=1?n*255:n)));
    };
    return [cv(rgb.red),cv(rgb.green),cv(rgb.blue)];
  };
  // Per Google Sheets API, foregroundColorStyle takes precedence over the deprecated foregroundColor.
  const styleRgb=toRgb(style && style.rgbColor);
  if(styleRgb) return {rgb:styleRgb,source:'rgb-style'};
  const theme=style && style.themeColor ? String(style.themeColor).toUpperCase() : '';
  const defaultTheme={
    TEXT:[0,0,0], BACKGROUND:[255,255,255],
    TEXT1:[0,0,0], DARK1:[0,0,0],
    BACKGROUND1:[255,255,255], LIGHT1:[255,255,255],
    TEXT2:[89,89,89], DARK2:[31,78,121],
    BACKGROUND2:[238,236,225], LIGHT2:[238,236,225],
    ACCENT1:[79,129,189], ACCENT2:[192,80,77],
    ACCENT3:[155,187,89], ACCENT4:[128,100,162],
    ACCENT5:[75,172,198], ACCENT6:[247,150,70],
    LINK:[0,0,255], HYPERLINK:[0,0,255], FOLLOWED_LINK:[128,0,128]
  };
  if(theme && themeColors[theme]) return {rgb:themeColors[theme],source:'theme:'+theme};
  if(theme && defaultTheme[theme]) return {rgb:defaultTheme[theme],source:'theme:'+theme};
  if(theme) return {rgb:null,source:'theme:'+theme};
  const directRgb=toRgb(direct);
  if(directRgb) return {rgb:directRgb,source:'rgb-legacy'};
  return null;
}

function rawFontColorAt(cell, charIndex, themeColors = {}){
  const runs=Array.isArray(cell && cell.textFormatRuns) ? cell.textFormatRuns : [];
  let selected=null, selectedStart=-1;
  for(const run of runs){
    const start=Number(run && run.startIndex || 0);
    if(start<=charIndex && start>=selectedStart){
      selected=run && run.format ? run.format : null;
      selectedStart=start;
    }
  }
  const runColor=rawFormatColor(selected,themeColors);
  if(runColor && runColor.rgb) return runColor;
  if(runColor && runColor.source && runColor.source.startsWith('theme:')) return runColor;
  const cellFormat=(cell && cell.effectiveFormat && cell.effectiveFormat.textFormat) ||
    (cell && cell.userEnteredFormat && cell.userEnteredFormat.textFormat) || null;
  const cellColor=rawFormatColor(cellFormat,themeColors);
  if(cellColor && cellColor.rgb) return cellColor;
  if(runColor) return runColor;
  if(cellColor) return cellColor;
  // Sheets' default text color is black if no cell/run font color is explicitly set.
  return {rgb:[0,0,0],source:'default-black'};
}

function classifyRawFontColor(cell, charIndex, themeColors = {}){
  const detected=rawFontColorAt(cell,charIndex,themeColors);
  const rgb=detected.rgb;
  if(!rgb) return {status:'unknown',hex:'',colorSource:detected.source};
  const r=rgb[0],g=rgb[1],b=rgb[2];
  const hex='#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
  let status='unknown';
  if(Math.max(r,g,b)<=90){
    status='black';
  } else if(r>=140 && g<=120 && b<=120 && r-g>=45 && r-b>=45){
    status='red';
  } else if(r>=145 && g>=125 && b<=190 && r-b>=30 && g-b>=25){
    status='yellow';
  } else if(r>=75 && b>=75 && r-g>=25 && b-g>=25){
    status='purple';
  }
  return {status,hex,colorSource:detected.source};
}

function parseRawCourseCell(cell, teacher, weekday, year = new Date().getFullYear(), themeColors = {}){
  const rawText=rawCellText(cell);
  const lines=[...rawText.matchAll(/[^\r\n]+/g)];
  const out=[];
  for(const match of lines){
    const originalLine=match[0];
    const line=originalLine.trim();
    if(!line) continue;
    const leading=originalLine.length-originalLine.trimStart().length;
    const lineStart=match.index+leading;
    const tm=line.match(/^(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})\s*(.*)$/);
    if(!tm) continue;
    const start=timeKey(tm[1]), end=timeKey(tm[2]);
    let rest=str(tm[3]);
    if(!start || !end || !rest) continue;
    const colorCharOffset=line.indexOf(tm[3]);
    const colorInfo=classifyRawFontColor(cell,lineStart+Math.max(0,colorCharOffset),themeColors);
    const annotations=[];
    if(isUnavailableSlot(rest)) continue;
    rest=rest.replace(/[（(]([^）)]*)[）)]/g,(whole,x,offset)=>{
      const before=rest.slice(0,offset);
      const groupRoster=/團班\s*$/.test(before) &&
        !/[0-9]/.test(x) &&
        !/(?:調|請假|加時|加課|補課|改|代|僅|\bp\b|\bb\b)/i.test(x);
      if(groupRoster) return whole;
      annotations.push(str(x));
      return '';
    }).trim();
    const tail=rest.match(/[（(]([^）)]*(?:\d{1,2}\/\d{1,2}|調課|調|請假|加時|加課|補課|改課|代課|停課|僅|\bp\b|\bb\b)[^）)]*)$/i);
    if(tail){
      annotations.push(str(tail[1]));
      rest=rest.slice(0,tail.index).trim();
    }
    let student=rest.replace(/\s+/g,' ').trim();
    if(!student || isUnavailableSlot(student)) continue;
    const durationMatch=student.match(/(?:\+|＋)\s*30\s*min(?:ute)?s?/i);
    const durationAdjustmentMinutes=durationMatch?30:0;
    if(durationMatch) student=student.replace(/(?:\+|＋)\s*30\s*min(?:ute)?s?/ig,'').trim();
    const annotationText=annotations.join('；');
    const untilMatch=annotationText.match(/(?:直到|至)\s*(\d{1,2})\/(\d{1,2})/);
    const untilDate=untilMatch?parseDateFlexible(untilMatch[1]+'/'+untilMatch[2],year):'';
    out.push({
      teacher,weekday,time:start,endTime:end,student,course:'',site:'',
      annotations,raw:line,colorStatus:colorInfo.status,colorHex:colorInfo.hex,
      colorSource:colorInfo.colorSource,durationAdjustmentMinutes,untilDate,
      note:[colorInfo.status==='yellow'?'[黃色確認中]':'',durationAdjustmentMinutes?'[指定日期加時30分鐘]':'',annotations.some(a=>/可能加半小|可能延長半小時/.test(a))?'[可能延長30分鐘，待確認]':''].filter(Boolean).join('；')
    });
  }
  return out;
}

function parseRawPurpleCourse(item, year = new Date().getFullYear()){
  const annotations=(item.annotations||[]).map(str);
  const annotationText=annotations.join('；');
  let newDate='', newTime=item.time, action='補課', originNote='';

  // 紫字的定義是「單次課程」，因此目的日期／時段應建立成獨立課程；
  // 不把它當作固定課程的移動指令，避免因找不到原時段而漏建。
  // 範例：9/7p調10/9b -> 單次建立在 10/9，課堂時段使用紫字主行。
  const moveRe=/(?:^|[^0-9])(\d{1,2})\/(\d{1,2})[^()]*?調\s*(\d{1,2})\/(\d{1,2})/;
  const moveMatch=annotationText.replace(/\s+/g,'').match(moveRe);
  if(moveMatch){
    const from=parseDateFlexible(moveMatch[1]+'/'+moveMatch[2],year);
    newDate=parseDateFlexible(moveMatch[3]+'/'+moveMatch[4],year);
    if(from) originNote='來源日期 '+from+'；';
    action='補課';
  } else {
    const timeMatch=annotationText.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})/);
    if(timeMatch){
      newDate=parseDateFlexible(timeMatch[1]+'/'+timeMatch[2],year);
      newTime=timeKey(timeMatch[3])||item.time;
      action='補課';
    } else {
      const onlyDate=annotationText.match(/僅\s*(\d{1,2})\/(\d{1,2})/);
      const addDate=annotationText.match(/(\d{1,2})\/(\d{1,2})[^()（）]*?(?:補課|加課)/);
      if(onlyDate){
        newDate=parseDateFlexible(onlyDate[1]+'/'+onlyDate[2],year);
        action='補課';
      } else if(addDate){
        newDate=parseDateFlexible(addDate[1]+'/'+addDate[2],year);
        action='加課';
      }
    }
  }

  // 2026/10/08 更新課表的星期五欄位，對應當週 2026/10/09。
  // 楊詔鈞代戴老師的兩筆是代課；郁翔則是可能延長半小時，不改原定起始時間。
  const isKnownSubstitute = item.teacher==='楊詔鈞' &&
    ['凱荻','昜寧'].includes(str(item.student).replace(/英文$/,'')) &&
    /代戴老師/.test(annotationText) && item.weekday==='五';
  const isPossibleExtension = /可能加半小|可能延長半小時/.test(annotationText) &&
    str(item.student).includes('郁翔') && item.weekday==='五';
  if(!newDate && isKnownSubstitute){
    newDate='2026-10-09';
    action='代課';
    originNote='10/8更新課表；星期五對應當週10/9；';
  }
  if(!newDate && isPossibleExtension){
    newDate='2026-10-09';
    action='補課';
    originNote='10/8更新課表；星期五對應當週10/9；';
  }
  if(!newDate) return [];
  const extensionNote=isPossibleExtension?'；[可能延長30分鐘，待確認；不變更原定時間]':'';
  const studentName=isKnownSubstitute ? str(item.student).replace(/英文$/,'') : item.student;
  const courseName=isKnownSubstitute ? '英文' : item.course;
  return [{
    id:'',fixedId:'',weekday:item.weekday,originalDate:'',originalTime:'',
    action,newDate,newTime,student:studentName,course:courseName,
    teacher:item.teacher,site:item.site,
    note:'[紫色調課] '+originNote+'單次課程：'+(item.raw||item.student)+'；備註：'+(annotationText||'無')+'；字色 '+(item.colorHex||'未知')+extensionNote,
    source:'開學課表',colorStatus:'purple',colorHex:item.colorHex||''
  }];
}

function parseRawAdjustmentAnnotations(item, year = new Date().getFullYear()){
  const out=[];
  for(const note of item.annotations||[]){
    // 保留原始空白，避免「10/9 1100-1230」去空白後被誤讀成「10/91 100-1230」。
    const rawText=str(note);
    const text=rawText.replace(/\s+/g,'');
    let m;
    // 日期與新時段之間必須有分隔空白，避免把時間的首位數字併入日期。
    const sameDayTime=/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:?\d{2})[-~～至](\d{1,2}:?\d{2})$/;
    const sameDayMatch=rawText.match(sameDayTime);
    if(sameDayMatch){
      const d=parseDateFlexible(sameDayMatch[1]+'/'+sameDayMatch[2],year);
      const newStart=timeKey(sameDayMatch[3]), newEnd=timeKey(sameDayMatch[4]);
      if(d && newStart && newEnd) out.push({id:'',fixedId:'',weekday:item.weekday,colorStatus:item.colorStatus,colorHex:item.colorHex,originalDate:d,originalTime:item.time,action:'改時間',newDate:d,newTime:newStart,student:item.student,course:item.course,teacher:item.teacher,site:item.site,note:'來源：開學課表；'+note+'（調整後時段 '+newStart+'-'+newEnd+'）',source:'開學課表'});
    }
    const moveRe=/(\d{1,2})\/(\d{1,2})[^()]*?調\s*(\d{1,2})\/(\d{1,2})/g;
    while((m=moveRe.exec(text))){
      const from=parseDateFlexible(m[1]+'/'+m[2],year);
      const to=parseDateFlexible(m[3]+'/'+m[4],year);
      if(from && to) out.push({id:'',fixedId:'',weekday:item.weekday,colorStatus:item.colorStatus,colorHex:item.colorHex,originalDate:from,originalTime:item.time,action:'調課',newDate:to,newTime:item.time,student:item.student,course:item.course,teacher:item.teacher,site:item.site,note:'來源：開學課表；'+note,source:'開學課表'});
    }
    // Multiple absence dates may be written as "9/8p、10/6p".
    // The negative look-ahead excludes a make-up expression such as "9/8p調10/5b".
    const absenceRe=/(\d{1,2})\/(\d{1,2})\s*p(?!\s*調)(?=$|[^a-z0-9])/gi;
    while((m=absenceRe.exec(rawText))){
      const d=parseDateFlexible(m[1]+'/'+m[2],year);
      if(d && !out.some(x=>x.action==='請假'&&x.originalDate===d&&x.student===item.student&&x.originalTime===item.time)){
        out.push({id:'',fixedId:'',weekday:item.weekday,colorStatus:item.colorStatus,colorHex:item.colorHex,originalDate:d,originalTime:item.time,action:'請假',newDate:d,newTime:item.time,student:item.student,course:item.course,teacher:item.teacher,site:item.site,note:'來源：開學課表；'+note,source:'開學課表'});
      }
    }
    const leaveRe=/(\d{1,2})\/(\d{1,2})[^0-9]*(?:請假|p(?:調|$))/gi;
    while((m=leaveRe.exec(text))){
      const d=parseDateFlexible(m[1]+'/'+m[2],year);
      if(d && !/調/.test(text) && !out.some(x=>x.action==='請假'&&x.originalDate===d&&x.student===item.student&&x.originalTime===item.time)){
        out.push({id:'',fixedId:'',weekday:item.weekday,colorStatus:item.colorStatus,colorHex:item.colorHex,originalDate:d,originalTime:item.time,action:'請假',newDate:d,newTime:item.time,student:item.student,course:item.course,teacher:item.teacher,site:item.site,note:'來源：開學課表；'+note,source:'開學課表'});
      }
    }
    const addRe=/(\d{1,2})\/(\d{1,2})[^0-9]*?(?:補課|加課)/g;
    while((m=addRe.exec(text))){
      const d=parseDateFlexible(m[1]+'/'+m[2],year);
      if(d) out.push({id:'',fixedId:'',weekday:item.weekday,colorStatus:item.colorStatus,colorHex:item.colorHex,originalDate:'',originalTime:'',action:'補課',newDate:d,newTime:item.time,student:item.student,course:item.course,teacher:item.teacher,site:item.site,note:'來源：開學課表；'+note,source:'開學課表'});
    }
  }
  return out;
}

function rawFixedLogicalKey(x){
  const rawTime=str(x.time);
  const start=parseTimeRange(rawTime).start || timeKey(rawTime);
  return [norm(x.weekday),start,compact(stripScheduleAnnotation(x.student)),compact(stripScheduleAnnotation(x.teacher))].join('|');
}

function parseRawSchedule(rows, year = new Date().getFullYear(), themeColors = {}){
  if(!rows.length) throw new Error('找不到「開學課表」資料。');
  const header=rows[0]||[];
  const teacherAliases=new Set(['老師','授課老師','班別負責老師','負責老師']);
  const teacherCol=header.findIndex(x=>teacherAliases.has(normHeader(rawCellText(x))));
  const weekdayCols={};
  const weekdayMap={'1':'一','2':'二','3':'三','4':'四','5':'五','6':'六','7':'日','一':'一','二':'二','三':'三','四':'四','五':'五','六':'六','日':'日'};
  for(let i=0;i<header.length;i++){
    const m=rawCellText(header[i]).replace(/\s+/g,'').match(/^星期([一二三四五六日1-7])$/);
    if(m) weekdayCols[i]=weekdayMap[m[1]];
  }
  if(teacherCol<0 || !Object.keys(weekdayCols).length){
    const seenHeader=header.map(rawCellText).filter(Boolean).join('、');
    throw new Error('「開學課表」格式不符合目前預期：需要老師欄及星期欄位；目前讀到：'+(seenHeader||'空白標題列'));
  }
  const fixed=[], adjustments=[], redItems=[], unclassifiedItems=[], durationRows=[];
  for(let r=1;r<rows.length;r++){
    const row=rows[r]||[];
    const teacherCell=rawCellText(row[teacherCol]);
    const teacher=stripScheduleAnnotation((teacherCell.split(/\r?\n/)[0]||'').replace(/[（(][^）)]*[）)]/g,(whole,x,offset,before)=>/(?:團班|班別)/.test(before||'') && !/[0-9]/.test(x) ? whole : ''));
    if(!teacher) continue;
    for(const [col,weekday] of Object.entries(weekdayCols)){
      for(const item of parseRawCourseCell(row[Number(col)],teacher,weekday,year,themeColors)){
        if(item.durationAdjustmentMinutes && ['black','yellow','purple'].includes(item.colorStatus)){
          durationRows.push(item);
          continue;
        }
        if(item.colorStatus==='black' || item.colorStatus==='yellow'){
          fixed.push(item);
          adjustments.push(...parseRawAdjustmentAnnotations(item,year));
        } else if(item.colorStatus==='purple'){
          const oneTime=parseRawPurpleCourse(item,year);
          if(oneTime.length) adjustments.push(...oneTime);
          else unclassifiedItems.push({...item,note:'[紫色課程待確認] 無法從備註判定單次上課日期或原／新日期'});
        } else if(item.colorStatus==='red'){
          redItems.push({...item,note:'[紅色自爆] 已終止／停課取消；不列入固定課表'});
        } else {
          unclassifiedItems.push({...item,note:'[顏色無法判定] 未自動歸類，避免誤入固定課表'});
        }
      }
    }
  }

  // Match each +30min row back to the ordinary fixed class; apply it only on the
  // explicit date list. A yellow/pending row is recorded but never applied.
  for(const item of durationRows){
    const annotationText=(item.annotations||[]).join('；');
    const dateMatches=[...annotationText.matchAll(/(\d{1,2})\/(\d{1,2})/g)];
    const dates=[];
    const seenDates=new Set();
    for(const m of dateMatches){
      const d=parseDateFlexible(m[1]+'/'+m[2],year);
      if(d && !seenDates.has(d)){
        dates.push(d);
        seenDates.add(d);
      }
    }
    const base=fixed.find(x=>
      x.weekday===item.weekday &&
      compact(x.student)===compact(item.student) &&
      x.time===item.time &&
      !x.durationAdjustmentMinutes
    );
    if(!dates.length || !base || !item.endTime){
      unclassifiedItems.push({...item,note:'[加時課程待確認] 找不到對應固定課程或有效日期清單；未自動套用'});
      continue;
    }
    for(const d of dates){
      const action=item.colorStatus==='yellow'?'延長時間待確認':'延長時間';
      adjustments.push({
        id:'',fixedId:'',weekday:item.weekday,originalDate:d,originalTime:item.time,
        action,newDate:d,newTime:item.time+'-'+item.endTime,
        student:item.student,course:base.course||item.course,teacher:item.teacher,
        site:item.site,note:'來源：開學課表；指定日期加時30分鐘；原定時段 '+base.time+'-'+base.endTime+'；加時後時段 '+item.time+'-'+item.endTime+'；日期清單：'+annotationText,
        source:'開學課表',colorStatus:item.colorStatus
      });
    }
  }

  return {fixed,adjustments,redItems,unclassifiedItems};
}

function matchRawFixedIds(rawFixed, existingFixedRows){
  const existing=[];
  const hr=findHeaderRow(existingFixedRows,['固定課表ID','星期','上課時間','學生','老師','校區','有效迄日','啟用']);
  if(hr>=0){
    const h=hmap(existingFixedRows[hr]);
    for(let i=hr+1;i<existingFixedRows.length;i++){
      const r=existingFixedRows[i]||[], id=str(r[h['固定課表ID']]);
      if(id) existing.push({id,weekday:str(r[h['星期']]),time:str(r[h['上課時間']]),student:str(r[h['學生']]),teacher:str(r[h['老師']]),site:str(r[h['校區']])});
    }
  }
  const byKey=new Map(existing.map(x=>[rawFixedLogicalKey(x),x.id]));
  let max=0;
  for(const x of existing){ const m=x.id.match(/^FS(\d+)$/i); if(m) max=Math.max(max,Number(m[1])); }
  const used=new Set(existing.map(x=>x.id));
  return rawFixed.map(x=>{
    const key=rawFixedLogicalKey(x);
    let id=byKey.get(key);
    if(!id){
      do{id='FS'+String(++max).padStart(3,'0');}while(used.has(id));
      used.add(id); byKey.set(key,id);
    }
    return {...x,id};
  });
}

function assignPreviewAdjustmentIds(adjustments, existingAdjustRows){
  const existing=[];
  const hr=findHeaderRow(existingAdjustRows,['調課ID','原固定課表ID','原日期','原時間','動作','新日期','新時間','學生','確認']);
  if(hr>=0){
    const h=hmap(existingAdjustRows[hr]);
    for(let i=hr+1;i<existingAdjustRows.length;i++){
      const r=existingAdjustRows[i]||[], id=str(r[h['調課ID']]);
      if(id) existing.push({id,fixedId:str(r[h['原固定課表ID']]),originalDate:parseDateFlexible(r[h['原日期']]),originalTime:timeKey(r[h['原時間']]),action:str(r[h['動作']]),newDate:parseDateFlexible(r[h['新日期']]),newTime:(parseTimeRange(r[h['新時間']]).start&&parseTimeRange(r[h['新時間']]).end?parseTimeRange(r[h['新時間']]).start+'-'+parseTimeRange(r[h['新時間']]).end:timeKey(r[h['新時間']])),student:str(r[h['學生']])});
    }
  }
  let max=0;
  for(const x of existing){ const m=x.id.match(/^ADJ(\d+)$/i); if(m) max=Math.max(max,Number(m[1])); }
  const keyOf=x=>[x.fixedId||'',x.originalDate||'',x.originalTime||'',x.action||'',x.newDate||'',x.newTime||'',compact(x.student||'')].join('|');
  const byKey=new Map(existing.map(x=>[keyOf(x),x.id]));
  const used=new Set(existing.map(x=>x.id));
  return adjustments.map(x=>{
    const key=keyOf(x); let id=byKey.get(key);
    if(!id){do{id='ADJ'+String(++max).padStart(3,'0');}while(used.has(id)); used.add(id); byKey.set(key,id);}
    return {...x,id};
  });
}

function gridCellForPreview(cell){
  const source=cell||{};
  let value='';
  if(source.formattedValue!==undefined) value=source.formattedValue;
  else if(source.userEnteredValue && source.userEnteredValue.stringValue!==undefined) value=source.userEnteredValue.stringValue;
  else if(source.userEnteredValue && source.userEnteredValue.numberValue!==undefined) value=String(source.userEnteredValue.numberValue);
  else if(source.userEnteredValue && source.userEnteredValue.boolValue!==undefined) value=String(source.userEnteredValue.boolValue);
  return {...source,value};
}

function gridRowsForPreview(sheet){
  const data=(sheet && sheet.data)||[];
  const out=[];
  for(const grid of data){
    for(const row of (grid.rowData||[])){
      out.push((row.values||[]).map(gridCellForPreview));
    }
  }
  return out;
}

function readThemeColors(theme){
  const out={};
  for(const pair of (theme && theme.themeColors)||[]){
    const key=str(pair.colorType).toUpperCase();
    const rgb=pair.color && pair.color.rgbColor;
    if(!key || !rgb) continue;
    const cv=v=>Math.max(0,Math.min(255,Math.round(Number(v||0)*255)));
    out[key]=[cv(rgb.red),cv(rgb.green),cv(rgb.blue)];
  }
  return out;
}

async function readRawSourcePreview(){
  const sourceSpreadsheetId=PREVIEW_SOURCE_SHEET_ID;
  const metadata=await retry('read preview source spreadsheet metadata',()=>sheets.spreadsheets.get({
    spreadsheetId:sourceSpreadsheetId,
    includeGridData:false,
    fields:'properties(spreadsheetTheme),sheets(properties(sheetId,title,gridProperties))'
  }));
  const availableSheets=(metadata.data.sheets||[]);
  let selectedSheet=null;
  if(PREVIEW_SOURCE_GID && /^\d+$/.test(PREVIEW_SOURCE_GID)){
    selectedSheet=availableSheets.find(x=>String(x.properties && x.properties.sheetId)===PREVIEW_SOURCE_GID)||null;
  }
  if(!selectedSheet){
    selectedSheet=availableSheets.find(x=>str(x.properties && x.properties.title)===PREVIEW_SOURCE_TAB_NAME)||null;
  }
  if(!selectedSheet){
    throw new Error('預覽來源分頁不存在。請檢查 PREVIEW_SOURCE_GID / PREVIEW_SOURCE_TAB_NAME；可用分頁：'+availableSheets.map(x=>str(x.properties && x.properties.title)+' (gid '+str(x.properties && x.properties.sheetId)+')').join('、'));
  }
  const sourceTitle=str(selectedSheet.properties.title);
  const sourceResponse=await retry('read preview source font colors',()=>sheets.spreadsheets.get({
    spreadsheetId:sourceSpreadsheetId,
    ranges:[qsheet(sourceTitle)+'!A:Z'],
    includeGridData:true,
    fields:'properties(spreadsheetTheme),sheets(properties(sheetId,title),data(rowData(values(formattedValue,userEnteredValue,effectiveFormat(textFormat(foregroundColor,foregroundColorStyle)),userEnteredFormat(textFormat(foregroundColor,foregroundColorStyle)),textFormatRuns))))'
  }));
  const sourceSheet=(sourceResponse.data.sheets||[]).find(x=>Number(x.properties && x.properties.sheetId)===Number(selectedSheet.properties.sheetId));
  if(!sourceSheet) throw new Error('無法讀取指定來源分頁的格線資料。');
  const themeColors=readThemeColors(sourceResponse.data.properties && sourceResponse.data.properties.spreadsheetTheme);
  const rawRows=gridRowsForPreview(sourceSheet);
  let fixedRows=[],adjustRows=[];
  try{
    const other=await retry('read optional ID matching data for preview',()=>sheets.spreadsheets.values.batchGet({
      spreadsheetId:SHEET_ID,
      ranges:[qsheet('固定課表')+'!A:K',qsheet('調課課程')+'!A:M'],
      majorDimension:'ROWS'
    }));
    const result=other.data.valueRanges||[];
    fixedRows=(result[0] && result[0].values)||[];
    adjustRows=(result[1] && result[1].values)||[];
  }catch(e){
    console.warn('Optional 固定課表／調課課程 tabs unavailable; use temporary preview IDs only:',str(e && e.message));
  }
  return {rawRows,fixedRows,adjustRows,themeColors,sourceSheetId:String(selectedSheet.properties.sheetId),sourceSheetTitle:sourceTitle,sourceSpreadsheetId};
}


async function buildSourcePreview(year = new Date().getFullYear()){
  const {rawRows,fixedRows,adjustRows,themeColors,sourceSheetId,sourceSheetTitle,sourceSpreadsheetId}=await readRawSourcePreview();
  const parsed=parseRawSchedule(rawRows,year,themeColors);
  const fixed=matchRawFixedIds(parsed.fixed,fixedRows);
  const fixedIdByKey=new Map(fixed.map(x=>[rawFixedLogicalKey(x),x.id]));
  const adjustments=assignPreviewAdjustmentIds(parsed.adjustments.map(x=>({
    ...x,
    fixedId:x.fixedId||fixedIdByKey.get([
      norm(x.weekday),
      parseTimeRange(x.originalTime).start||timeKey(x.originalTime),
      compact(stripScheduleAnnotation(x.student)),
      compact(stripScheduleAnnotation(x.teacher))
    ].join('|'))||''
  })),adjustRows);
  const colorSummary={
    blackFixed:fixed.filter(x=>x.colorStatus==='black').length,
    yellowPending:fixed.filter(x=>x.colorStatus==='yellow').length,
    purpleAdjustments:adjustments.filter(x=>x.colorStatus==='purple').length,
    redCancelled:parsed.redItems.length,
    unclassified:parsed.unclassifiedItems.length
  };
  return {
    ok:true,mode:'preview-only',sourceSheetId,sourceSheetTitle,
    sourceSpreadsheetId,
    writesPerformed:false,colorRulesApplied:true,year,colorSummary,
    fixedCount:fixed.length,adjustmentCount:adjustments.length,
    redCount:parsed.redItems.length,unclassifiedCount:parsed.unclassifiedItems.length,
    fixed:fixed.slice(0,300),adjustments:adjustments.slice(0,300),
    redItems:parsed.redItems.slice(0,200),
    unclassifiedItems:parsed.unclassifiedItems.slice(0,200)
  };
}

app.get('/preview-source',async(req,res)=>{
  if(!adminAuthorized(req)) return res.status(process.env.SCHEDULE_ADMIN_TOKEN?401:503).json({ok:false,mode:'preview-only',writesPerformed:false,error:process.env.SCHEDULE_ADMIN_TOKEN?'未授權，請提供有效的管理員 token。':'尚未設定 SCHEDULE_ADMIN_TOKEN；為保護學生與老師資料，已停用 /preview-source。'});
  try{
    const year=Number(req.query.year||new Date().getFullYear());
    res.json(await buildSourcePreview(year));
  }catch(e){
    console.error('Source preview failed',e);
    res.status(500).json({ok:false,mode:'preview-only',writesPerformed:false,error:e.message});
  }
});



if(require.main===module) app.listen(PORT,()=>console.log(`LINE Course Schedule Manager v1.2 listening on ${PORT}`));
module.exports={app,isYes,isNo,parseDateFlexible,splitClassRoster,normalizeMemberList,parseAdjust,parseFixed,parseSettings,buildRows,mergeActualRows,makeReminderRows,mergeReminderItems,actualObjects,missingReminderTimeWarnings,adminAuthorized};
// Safety: do not build or write Google Sheets automatically at startup or on a timer.
// Use the explicit /build endpoint only after reviewing the source preview.
