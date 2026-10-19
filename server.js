require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const {
  addMinutesToTime,
  normalizeTimeRange,
  hasDateScopedTargetOverride,
  mergeExplicitMoveDestinationOverrides,
  isSourceImportedFixedNote,
  extractReminderStudentNames,
  parseDurationTargetDates,
  parseSameDayTimeChangeNote,
  parseCourseStartDateNote,
  normalizeStudentNameForContact,
  parseSingleDateOnlyNote,
  parseTeacherAbsenceNote,
  parseTeacherConfirmUntil,
  sourceTeacherCourseOverride,
  splitWrappedCourseLines
} = require('./source_note_rules');

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
const DEFAULT_SITE = '愛學館信義光復校';
const CORRECTION_HEADERS = ['日期','學生','原時間','校正動作','新時間','新課程','新老師','備註'];
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
function normalizeWeekday(value){
  const raw=norm(value).replace(/^(?:星期|週|周)/,'');
  const map={'1':'一','2':'二','3':'三','4':'四','5':'五','6':'六','7':'日',
    '一':'一','二':'二','三':'三','四':'四','五':'五','六':'六','日':'日'};
  return map[raw]||raw;
}
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
function parseDateFlexible(v, fallbackYear=new Date().toLocaleString('en-US',{timeZone:TZ,year:'numeric'})){
  if(typeof v==='number'){
    const key=dateKey(v);
    return isValidDateKey(key)?key:'';
  }
  const x=str(v);
  const short=x.match(/^(\d{1,2})[\/\.\-](\d{1,2})$/);
  if(short){
    const suppliedReference=isValidDateKey(String(fallbackYear))?String(fallbackYear):'';
    const requestedYear=Number(String(fallbackYear).slice(0,4));
    const baseYear=Number.isFinite(requestedYear)&&requestedYear>=1900?requestedYear:Number(todayKey().slice(0,4));
    const reference=suppliedReference || (baseYear===Number(todayKey().slice(0,4))?todayKey():String(baseYear)+'-07-01');
    const makeKey=y=>String(y)+'-'+String(Number(short[1])).padStart(2,'0')+'-'+String(Number(short[2])).padStart(2,'0');
    const candidates=[baseYear-1,baseYear,baseYear+1].map(makeKey).filter(isValidDateKey);
    if(!candidates.length) return '';
    const distance=(a,b)=>Math.abs(Date.parse(a+'T00:00:00Z')-Date.parse(b+'T00:00:00Z'));
    candidates.sort((a,b)=>distance(a,reference)-distance(b,reference)||
      Math.abs(Number(a.slice(0,4))-baseYear)-Math.abs(Number(b.slice(0,4))-baseYear));
    return candidates[0];
  }
  const full=dateKey(x);
  return isValidDateKey(full)?full:'';
}
function extractMoveDate(action, originalDate){
  const s=str(action).replace(/[\s　]+/g,'');
  const patterns=[
    /整日(?:調課|移課|改課)(?:到|至)?[:：]?(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/,
    /整日(?:調課|移課|改課)(?:到|至)?[:：]?(\d{1,2}[-\/.]\d{1,2})/,
    /(?:調|移|改)(?:到|至)[:：]?(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/,
    /(?:調|移|改)(?:到|至)[:：]?(\d{1,2}[-\/.]\d{1,2})/
  ];
  for(const re of patterns){ const m=s.match(re); if(m) return parseDateFlexible(m[1]); }
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
  return {sendDate, sendTime};
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
  if(hr<0) throw new Error('「系統設定」缺少「設定項目／目前值」標題；已中止建置，以免把欄位錯誤當成提醒停用。');
  const h=hmap(rows[hr]); const out={};
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const key=str(r[h['設定項目']]); if(!key) continue;
    out[key]=str(r[h['目前值']]);
  }
  const reminderEnabled=str(out['課程提醒啟用']);
  if(!reminderEnabled || (!isYes(reminderEnabled)&&!isNo(reminderEnabled))){
    throw new Error('「系統設定」缺少有效的「課程提醒啟用」值；請明確填寫「是」或「否」，已中止建置。');
  }
  return {
    enabled:reminderEnabled,
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
  const parseYear=Number(todayKey().slice(0,4));
  const enabledIssues=[];
  
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const id=str(r[h['固定課表ID']]); if(!id) continue;
    const enabledRaw=str(r[h['啟用']]);
    const enabled=norm(enabledRaw);
    if(enabled!=='是' && enabled!=='否'){
      enabledIssues.push({row:i+1,id,student:str(r[h['學生']]),teacher:str(r[h['老師']]),enabledRaw});
    }
    if(enabled!=='是') continue;
    const weekday=normalizeWeekday(r[h['星期']]); const rawTime=str(r[h['上課時間']]); const range=parseTimeRange(rawTime); const time=range.start||timeKey(rawTime);
    if(!weekday||!time) continue;
    const student=str(r[h['學生']])||extractStudentFromTime(rawTime);
    if(!student || isUnavailableSlot(student)) continue;
    const note=str(r[h['備註']]);
    const explicitStart=note.match(/有效起日[:：]\s*(\d{4}-\d{2}-\d{2})/);
    const startsOn=explicitStart&&isValidDateKey(explicitStart[1])
      ? explicitStart[1]
      : parseCourseStartDateNote(note,parseYear);
    out.push({id,weekday,time,endTime:range.end,student,course:str(r[h['課程']]),teacher:str(r[h['老師']]),site:normalizeSite(r[h['校區']]),until:dateKey(r[h['有效迄日']]),startsOn,template:str(r[h['通知模板']]),note,rawTime});
  }
  if(enabledIssues.length){
    console.warn('[SCHEDULE-DATA-CHECK] 固定課表「啟用」欄位不是「是／否」', enabledIssues);
  }
  return out;
}
function parseAdjust(rows, correctionRows=[]){
  const legacyHr=findHeaderRow(rows,['調課ID','原固定課表ID','原日期','原時間','動作','新日期','新時間','學生','確認']);
  const simpleHr=findHeaderRow(rows,['原日期','原時間','動作','新日期','新時間','學生','新課程','新老師']);
  const out=[];
  if(legacyHr>=0){
    const h=hmap(rows[legacyHr]);
    for(let i=legacyHr+1;i<rows.length;i++){
      const r=rows[i]||[],id=str(r[h['調課ID']]); if(!id)continue;
      if(h['確認']!==undefined&&norm(r[h['確認']])!=='是')continue;
      out.push({id,fixedId:str(r[h['原固定課表ID']]),originalDate:parseDateFlexible(r[h['原日期']]),originalTime:parseTimeRange(r[h['原時間']]).start||timeKey(r[h['原時間']]),action:str(r[h['動作']]),newDate:parseDateFlexible(r[h['新日期']]),newTime:normalizeTimeRange(r[h['新時間']]),newEndTime:parseTimeRange(r[h['新時間']]).end,student:str(r[h['學生']]),course:str(r[h['新課程']]),teacher:str(r[h['新老師']]),site:str(r[h['新校區']]),note:str(r[h['備註']]),source:'調課課程'});
    }
  } else if(simpleHr>=0){
    const h=hmap(rows[simpleHr]);
    for(let i=simpleHr+1;i<rows.length;i++){
      const r=rows[i]||[],student=str(r[h['學生']]);
      const d=parseDateFlexible(r[h['原日期']]),t=parseTimeRange(r[h['原時間']]).start||timeKey(r[h['原時間']]);
      const action=str(r[h['動作']]);
      if(!d)continue;
      if(!student && !/整日/.test(action))continue;
      if(!t && !/整日/.test(action))continue;
      out.push({id:'',fixedId:'',originalDate:d,originalTime:t,action,newDate:parseDateFlexible(r[h['新日期']]),newTime:normalizeTimeRange(r[h['新時間']]),newEndTime:parseTimeRange(r[h['新時間']]).end,student,course:str(r[h['新課程']]),teacher:str(r[h['新老師']]),site:'',note:'',source:'調課課程'});
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
      const d=parseDateFlexible(r[h['日期']]);
      const t=parseTimeRange(r[h['原時間']]).start||timeKey(r[h['原時間']]);
      const action=str(r[h['校正動作']]);
      const note=str(r[h['備註']]);

      // 先保留原本「日期／學生／原時間／校正動作」欄位的正式填法。
      if(d && (student || /整日/.test(action)) && (t || /整日/.test(action))){
        let newDate=extractMoveDate(action,d) || d;
        if(newDate===d){
          const noteMove=note.match(/(?:→|->|至|到)\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2})/);
          if(noteMove) newDate=parseDateFlexible(noteMove[1]);
        }

        pushCorrection({
          id:'CORR-'+(i+1),fixedId:'',originalDate:d,originalTime:t,action,newDate,
          newTime:normalizeTimeRange(r[h['新時間']]),newEndTime:parseTimeRange(r[h['新時間']]).end,
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
        const from=parseDateFlexible(wideMatch[1]);
        const to=parseDateFlexible(wideMatch[2]);
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
        const from=parseDateFlexible(wideMatch[1]);
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
            const moveDate=parseDateFlexible(timeMoveMatch[4]);
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
            const from=parseDateFlexible(m[1]+'/'+m[2]);
            const to=parseDateFlexible(m[3]+'/'+m[4]);
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
            const from=parseDateFlexible(m[1]+'/'+m[2]);
            const to=parseDateFlexible(m[3]+'/'+m[4]);
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
            const from=parseDateFlexible(m[1]+'/'+m[2]);
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
            const newDate=parseDateFlexible(m[1]+'/'+m[2]);
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

function parseInlineAdjustments(fixed){
  const out=[];
  for(const f of fixed){
    // Source workbook annotations are parsed into 調課課程 during source synchronization.
    // Do not parse their copied audit note a second time as a separate manual adjustment.
    if(isSourceImportedFixedNote(f.note)) continue;
    const raw=str(f.rawTime);
    const note=str(f.note);
    const text=raw+' '+note;

    // 例：1030-1200沄臻(10/10(六)調10/9b)
    // 只處理明確的「日期調到另一日期」，時間沿用原課時間。
    const dateMoveRe=/(\d{1,2})\/(\d{1,2})(?:\([^)]*\))?[^()]*?調\s*(\d{1,2})\/(\d{1,2})/g;
    let m;
    while((m=dateMoveRe.exec(text))){
      const from=parseDateFlexible(m[1]+'/'+m[2]);
      const to=parseDateFlexible(m[3]+'/'+m[4]);
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
      const from=parseDateFlexible(m[1]+'/'+m[2]);
      const nt=timeKey(m[3]), end=timeKey(m[4]);
      if(!nt)continue;
      const adjustedTime=end?nt+'-'+end:nt;
      out.push({
        id:'INLINE-TIME-'+f.id+'-'+from+'-'+adjustedTime,
        fixedId:f.id,originalDate:from,originalTime:f.time,action:'改時間',
        newDate:from,newTime:adjustedTime,newEndTime:end,student:f.student,course:f.course,teacher:f.teacher,
        site:f.site,note:'來源：固定課表備註；'+m[0],source:'固定課表備註'
      });
    }

    // 例：(10/3嘉恆請假)；只在明確包含「請假」時取消該日期的該學生課程。
    const leaveRe=/(\d{1,2})\/(\d{1,2})[^()]*請假/g;
    while((m=leaveRe.exec(text))){
      const from=parseDateFlexible(m[1]+'/'+m[2]);
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
    if(norm(r[h['通知啟用']])!=='是') continue;
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

function buildRows(fixed, adjusts, fromDate, days){
  const out=[],byKey=new Map(),dateWide=new Map();

  for(const a of adjusts){
    if(!a.originalDate)continue;
    const action=norm(a.action);

    // 「整日停課」：只要日期符合，就取消當天全部固定課程。
    if(/整日.*(?:停課|取消)/.test(action)){
      if(!dateWide.has(a.originalDate))dateWide.set(a.originalDate,{cancel:true,moves:[]});
      dateWide.get(a.originalDate).cancel=true;
      continue;
    }

    // 「整日調課到10/9」：將來源日期的全部固定課程搬到指定日期。
    if(/整日.*(?:調課|移課|改課)/.test(action)){
      // 整日調課的目的日期以「校正動作」為最高優先來源。
      // 例如：2026-10-10 +「整日調課到10/9」=> 2026-10-09。
      const nd=extractMoveDate(a.action,a.originalDate) || a.newDate;
      if(nd && nd!==a.originalDate){
        if(!dateWide.has(a.originalDate))dateWide.set(a.originalDate,{cancel:false,moves:[]});
        dateWide.get(a.originalDate).moves.push({...a,newDate:nd});
      }else if(nd===a.originalDate){
        console.warn('Ignored invalid same-date whole-day move:',a.originalDate,a.action,a.note||'');
      }
      continue;
    }

    const k=a.originalDate+'|'+compact(a.student)+'|'+a.originalTime;
    if(!byKey.has(k))byKey.set(k,[]);
    byKey.get(k).push(a);
  }

  const toDate=addDays(fromDate,days-1);

  for(let d=fromDate;d<=toDate;d=addDays(d,1)){
    const wd=weekdayLabel(d);
    for(const f of fixed){
      if(!str(f.student) || isUnavailableSlot(f.student)) continue;
      if(f.startsOn&&isValidDateKey(f.startsOn)&&d<f.startsOn)continue;
      if(f.until&&/^\d{4}-\d{2}-\d{2}$/.test(f.until)&&d>f.until)continue;
      if(normalizeWeekday(f.weekday)!==normalizeWeekday(wd))continue;
      // If this date has an explicit cross-date move that resolves to the same
      // student and start time, the date-scoped destination lesson replaces the
      // weekly slot instead of generating overlapping 18:00-19:30 and 18:00-20:00 rows.
      if(hasDateScopedTargetOverride(adjusts,d,f.student,f.time))continue;

      const base={date:d,weekday:wd,time:f.endTime?f.time+'-'+f.endTime:f.time,student:f.student,course:f.course,teacher:f.teacher,site:f.site,source:'固定課表',fixedId:f.id,adjustId:'',adjustResult:'無',note:f.note||'',template:f.template||''};
      const wide=dateWide.get(d);
      const k=d+'|'+compact(f.student)+'|'+f.time;
      const adj=byKey.get(k)||[];
      let handled=false;

      // 個別校正優先於整日規則。
      // 例如：10/10 整日調課到 10/9，但小明另填「10/10 小明 12:00 調到 10/11」，
      // 小明就不走 10/9 的整日搬課，而是直接使用個別校正結果。
      if(adj.length){
        for(const a of adj){
          const action=norm(a.action);
          if(action==='延長時間待確認') continue;
          if(action==='延長時間'){
            const extensionEnd=a.newEndTime||parseTimeRange(a.newTime).end||'';
            if(extensionEnd){
              out.push({
                ...base,time:f.time+'-'+extensionEnd,
                source:a.source||'開學課表',adjustId:a.id||f.id+'-'+d,
                adjustResult:'已加時30分鐘',note:a.note||('原定時段 '+f.time+'-'+f.endTime+'；加時後 '+f.time+'-'+extensionEnd)
              });
              handled=true;
              break;
            }
            continue;
          }
          if(action==='取消'||action==='停課'||/請假/.test(action)){
            out.push({...base,source:a.source||'調課課程',adjustId:a.id||f.id+'-'+d,adjustResult:'取消',note:a.note||'取消'});
            handled=true;
            break;
          }
          if(/改時間|改課|調課|移課|代課/.test(action)){
            const moveActions=adj.filter(x=>
              /調課|移課|改課|代課/.test(norm(x.action))&&
              x.newDate&&x.newDate!==d
            );
            if(moveActions.length>1){
              const emitted=new Set();
              for(const move of moveActions){
                const nd=move.newDate,nt=move.newTime||base.time;
                const moveKey=[nd,nt,compact(move.student||f.student),compact(move.teacher||f.teacher)].join('|');
                if(emitted.has(moveKey))continue;
                emitted.add(moveKey);
                out.push({
                  ...base,date:nd,weekday:weekdayLabel(nd),time:nt,
                  student:move.student||f.student,course:move.course||f.course,
                  teacher:move.teacher||f.teacher,site:move.site||f.site,
                  source:move.source||'調課課程',fixedId:f.id,
                  adjustId:move.id||f.id+'-'+d+'-'+nd,adjustResult:'已調課',
                  note:move.note||''
                });
              }
            }else{
              const nd=a.newDate||d,nt=a.newTime||base.time;
              out.push({
                ...base,date:nd,weekday:weekdayLabel(nd),time:nt,
                student:a.student||f.student,course:a.course||f.course,teacher:a.teacher||f.teacher,
                site:a.site||f.site,source:a.source||'調課課程',fixedId:f.id,
                adjustId:a.id||f.id+'-'+d,adjustResult:'已調課',note:a.note||''
              });
            }
            handled=true;
            break;
          }
        }
      }

      // 沒有個別例外時，才套用整日規則。
      if(!handled && wide?.cancel){
        out.push({...base,source:'課程校正',adjustId:'DATE-CANCEL-'+d,adjustResult:'取消',note:'整日停課'});
        handled=true;
      }

      if(!handled && wide?.moves?.length){
        for(const a of wide.moves){
          const nd=a.newDate;
          if(!nd || nd===d || nd<fromDate||nd>toDate)continue;
          out.push({
            ...base,date:nd,weekday:weekdayLabel(nd),time:a.newTime||base.time,
            student:a.student||f.student,course:a.course||f.course,teacher:a.teacher||f.teacher,
            site:a.site||f.site,source:a.source||'課程校正',fixedId:f.id,
            adjustId:a.id||'DATE-MOVE-'+d+'-'+nd,adjustResult:'已調課',
            note:a.note||('整日調課：'+d+' → '+nd)
          });
        }
        handled=true;
      }

      if(!handled)out.push(base);
    }
  }

  // If the source date is already outside the build window but its destination is still future,
  // materialize the move directly on the target date. Otherwise the source-date loop below cannot see it.
  for(const a of adjusts){
    if(!a.originalDate||!a.newDate||a.newDate===a.originalDate)continue;
    if(!/調課|移課|改課|代課/.test(norm(a.action)))continue;
    if(a.newDate<fromDate||a.newDate>toDate)continue;
    if(a.originalDate>=fromDate&&a.originalDate<=toDate)continue;
    if(/請假|取消|停課/.test(a.action))continue;
    const sourceWeekday=weekdayLabel(a.originalDate);
    const fb=(a.fixedId&&fixed.find(x=>x.id===a.fixedId))||
      fixed.find(x=>compact(x.student)===compact(a.student)&&
        x.weekday===sourceWeekday&&
        x.time===(parseTimeRange(a.originalTime).start||timeKey(a.originalTime)));
    const student=a.student||fb?.student||'';
    if(!student)continue;
    const fallbackTime=fb?(fb.endTime?fb.time+'-'+fb.endTime:fb.time):'';
    out.push({
      date:a.newDate,weekday:weekdayLabel(a.newDate),time:a.newTime||fallbackTime,
      student,course:a.course||fb?.course||'',teacher:a.teacher||fb?.teacher||'',
      site:a.site||fb?.site||'',source:a.source||'調課課程',
      fixedId:fb?.id||a.fixedId||'',
      adjustId:a.id||'PAST-SOURCE-MOVE-'+a.originalDate+'-'+a.newDate+'-'+compact(student),
      adjustResult:'已調課',
      note:a.note||('來源日期 '+a.originalDate+' 已超出本次 Build 範圍；移至 '+a.newDate)
    });
  }

  // 「新增／補課／體驗」仍沿用原本的新增課程機制。
  for(const a of adjusts){
    if(!a.newDate||a.originalDate||/取消|停課/.test(a.action))continue;
    if(a.newDate<fromDate||a.newDate>toDate)continue;
    const fb=fixed.find(x=>x.id===a.fixedId),isAdd=/新增|補課|體驗|代課/.test(a.action)||!a.fixedId;
    if(!isAdd||!a.newTime)continue;
    const student=a.student||fb?.student||''; if(!student)continue;
    out.push({date:a.newDate,weekday:weekdayLabel(a.newDate),time:a.newTime,student,course:a.course||fb?.course||'',teacher:a.teacher||fb?.teacher||'',site:a.site||fb?.site||'',source:a.source||'調課課程',fixedId:fb?.id||'',adjustId:a.id||'NEW-'+a.newDate+'-'+compact(student),adjustResult:'新增調課',note:a.note||'',template:fb?.template||''});
  }

  const seen=new Set(),final=[];
  for(const x of out.sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)||a.student.localeCompare(b.student))){
    const key=[x.date,x.time,x.student,x.course,x.teacher,x.site,x.fixedId,x.adjustId,x.adjustResult].join('|');
    if(seen.has(key))continue;
    seen.add(key);
    const courseId=x.adjustId?(x.fixedId||'ADJ')+'-'+x.date+'-'+x.adjustId:x.fixedId+'-'+x.date;
    final.push([courseId,x.date,x.weekday,x.time,x.student,x.course,x.teacher,normalizeSite(x.site),x.source,x.fixedId,x.adjustId,x.adjustResult,x.note||'']);
  }
  return final;
}
function mergeActualRows(rows, previousRows, fromDate, toDate, headerRowIndex=1){
  const dataStartIndex=Math.max(0,Number.isInteger(headerRowIndex)?headerRowIndex+1:2);
  const previous=(previousRows||[]).slice(dataStartIndex).filter(row=>Array.isArray(row)&&row.some(value=>str(value)!==''));
  const inWindow=row=>{
    const date=dateKey(row?.[1]);
    return isValidDateKey(date)&&date>=fromDate&&date<=toDate;
  };
  const priorInWindow=previous.filter(inWindow);
  if((rows||[]).length===0&&priorInWindow.length>0){
    throw new Error('安全保護：本次區間實際課程為 0 筆，但區間內仍有 '+priorInWindow.length+' 筆舊課程；已拒絕清空，請先檢查來源解析及日期範圍。');
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
  const sortStart=row=>timeKey(row[13])||parseTimeRange(row[3]).start||timeKey(row[3])||'99:99';
  merged.sort((a,b)=>
    dateKey(a[1]).localeCompare(dateKey(b[1]))||
    sortStart(a).localeCompare(sortStart(b))||
    str(a[4]).localeCompare(str(b[4]))||
    str(a[5]).localeCompare(str(b[5]))||
    str(a[6]).localeCompare(str(b[6]))
  );
  return {merged,previousDataCount:previous.length};
}
async function writeActual(rows, previousRows=[], fromDate=todayKey(), toDate=fromDate){
  const headerColumns=[
    'Course ID','課程日期','星期','上課時間','學生','課程','老師','校區',
    '來源','固定課表ID','調課ID','調課結果','備註'
  ];
  const headerIndex=findHeaderRow(previousRows,headerColumns);
  if(headerIndex<0) throw new Error('安全保護：「實際課程」找不到完整的前 13 欄標題，為避免寫錯欄位，未寫入資料。');
  const headerRow=(previousRows[headerIndex]||[]).slice();
  while(headerRow.length<15) headerRow.push('');
  const attendanceHeaders=['開始時間（出勤用）','下課時間（出勤用）'];
  if(headerRow[13]!==attendanceHeaders[0]||headerRow[14]!==attendanceHeaders[1]){
    await retry('ensure 實際課程 attendance headers',()=>sheets.spreadsheets.values.update({
      spreadsheetId:SHEET_ID,
      range:qsheet('實際課程')+'!N'+(headerIndex+1)+':O'+(headerIndex+1),
      valueInputOption:'RAW',requestBody:{values:[attendanceHeaders]}
    }));
  }
  const {merged}=mergeActualRows(rows,previousRows,fromDate,toDate,headerIndex);
  const firstDataRow=headerIndex+2;
  const lastExistingDataRow=Math.max(headerIndex+1,(previousRows||[]).reduce((last,row,i)=>{
    if(i>headerIndex&&Array.isArray(row)&&row.some(value=>str(value)!=='')) return i+1;
    return last;
  },0));
  const newLastRow=headerIndex+1+merged.length;
  if(merged.length){
    await retry('write 實際課程',()=>sheets.spreadsheets.values.update({
      spreadsheetId:SHEET_ID,
      range:qsheet('實際課程')+'!A'+firstDataRow+':O'+newLastRow,
      valueInputOption:'RAW',requestBody:{values:merged}
    }));
  }
  if(lastExistingDataRow>newLastRow){
    await retry('clear stale tail 實際課程',()=>sheets.spreadsheets.values.clear({
      spreadsheetId:SHEET_ID,
      range:qsheet('實際課程')+'!A'+(newLastRow+1)+':O'+lastExistingDataRow,
      requestBody:{}
    }));
  }
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
  const seen=new Set();
  const out=[];
  for(const item of split(value)){
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
  // 團班保留班別名稱，學生放在括號內，例如：
  // 生物團班(葉依柔、陳翊森)
  if(/團班/.test(c)) return `${c}(${students})`;
  return students;
}

function mergeReminderItems(items){
  const groups=new Map();
  for(const item of items){
    // 老師：同一天＋同校區＋同一位老師，只發一則，內含所有時段。
    // 家長：維持同一時間合併，避免不同時間的課程混在同一則家長通知。
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
    const members=[];
    const memberKeys=new Set();
    const courses=[];
    const courseKeys=new Set();
    const scheduleByTime=new Map();

    for(const item of group){
      const member=formatReminderMember(item.course,item.student);
      const memberKey=compact(member);
      if(member && !memberKeys.has(memberKey)){
        memberKeys.add(memberKey);
        members.push(member);
      }

      const course=str(item.course);
      const courseKey=compact(course);
      if(course && !courseKeys.has(courseKey)){
        courseKeys.add(courseKey);
        courses.push(course);
      }

      if(item.role==='老師'){
        const time=str(item.timeRange)||timeKey(item.time)||str(item.time);
        if(!time || !member) continue;
        if(!scheduleByTime.has(time)) scheduleByTime.set(time,[]);
        const list=scheduleByTime.get(time);
        if(!list.some(x=>compact(x)===memberKey)) list.push(member);
      }
    }

    const scheduleLines=Array.from(scheduleByTime.entries())
      .sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([time,list])=>time+' '+list.join('、'))
      .join('\n');

    merged.push({
      ...first,
      student:members.join('、'),
      course:courses.join('、'),
      members:members.join('、'),
      scheduleLines
    });
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
  const requireConfirm = settings.requireConfirm !== '否';

  for(const c of actual){
    if(c.adjustResult==='取消') continue;
    // 沒有有效學生／學生成員，或是「無法排課」佔位文字，不建立任何提醒。
    if(!str(c.student) || isUnavailableSlot(c.student)) continue;
    const slot=previousReminderSlot(c.date,settings);
    if(!slot.sendDate || !slot.sendTime) continue;
    const dateLabel=c.date.replaceAll('-','/');

    if(settings.parentNotify==='是'){
      // 團班可能同時包含多位學生；家長匹配必須逐一拆開學生姓名，
      // 否則「葉依柔、陳翊森」會被當成單一姓名，導致兩位學生的家長都收不到通知。
      const studentMembers = extractReminderStudentNames(c.student);
      const rosterlessGroup = /團班/.test(String(c.course||c.student)) && studentMembers.length===0;
      const parentStudents = studentMembers.length ? studentMembers : (rosterlessGroup ? [] : [c.student]);
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

    if(settings.teacherNotify==='是'){
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
  const expected=(AUTO_CREATE_REMINDERS&&isYes(settings.enabled))
    ? makeReminderRows(actualObjects(actualRows),contacts,templates,settings,fixedTemplateById)
    : [];
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
      const proposedRow=toOutput({...x,id:old.id});
      const sameReminderContent=shouldPreserveReminderConfirmation(old.values,proposedRow,headers,isGeneratedReminder);
      const hadUserVisibleContentBeforeUpdate=!!str(row[getIdx('學生/學生成員')])||!!str(row[getIdx('課程')])||!!preserveMsg;
      Object.assign(row,proposedRow);
      // 自動提醒同步新訊息；手動提醒保留人工訊息。
      if(preserveMsg&&!isGeneratedReminder) row[getIdx('訊息內容')]=preserveMsg;
      // 提醒關鍵欄位或內容變更就重新確認，不能沿用舊的「是」。
      if(preserveConfirm&&sameReminderContent&&hadUserVisibleContentBeforeUpdate){
        row[getIdx('確認發送')]=isYes(preserveConfirm)?'是':(isNo(preserveConfirm)?'否':x.confirm);
      }else{
        row[getIdx('確認發送')]=x.confirm;
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
      range:qsheet('課程提醒')+'!A'+u.rowNumber+':'+columnLetter(width)+u.rowNumber,
      values:[u.values]
    });
  }

  if(append.length){
    const startRow=Math.max((reminderRows||[]).length+1,parsed.headerRow>=0 ? parsed.headerRow+2 : 2);
    batchData.push({
      range:qsheet('課程提醒')+'!A'+startRow+':'+columnLetter(width)+(startRow+append.length-1),
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
  return {expectedCount:expected.length,created,updated,disabled,reminderServiceEnabled:settings.enabled==='是',lineSending:false};
}


function columnLetter(n){
  let out='';
  while(n>0){ const r=(n-1)%26; out=String.fromCharCode(65+r)+out; n=Math.floor((n-1)/26); }
  return out;
}

// 每次手動呼叫 /build 時，先讀取「開學課表」並把尚未存在的固定課表／調課資料補入。
// 安全原則：只新增來源中缺少的列，不刪除或覆寫現有列；既有人工資料保留。
async function syncSourceIntoSchedule(){
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
  if(!['是','yes','true','1','啟用'].includes(norm(translateSource))){
    return {sourceSheet:'開學課表',translationEnabled:false,sourceFixedParsed:0,sourceAdjustmentsParsed:0,fixedAdded:0,fixedCorrected:0,adjustmentsAdded:0,existingRowsPreserved:true,skipped:true};
  }
  const year=Number(todayKey().slice(0,4));
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
    set('備註','來源：開學課表自動同步'+(x.startsOn?'；有效起日：'+x.startsOn:'')+(x.colorStatus==='yellow'?'；黃色確認中，預設停用；字色 '+(x.colorHex||'未知'):'')+(x.note?'；'+x.note:''));
    set('通知模板','家長一般/老師通知');
    return row;
  };
  const fixedOutput=fixedToAdd.map(makeFixedRow);
  const fixedUpdates=[];
  // 只校正由本程式建立的來源列；人工維護的固定課表不覆寫。
  for(const x of matchedFixed){
    const old=existingFixedById.get(x.id);
    if(!old) continue;
    const oldNote=fh['備註']===undefined?'':str(old.values[fh['備註']]);
    if(!oldNote.includes('來源：開學課表自動同步')) continue;
    const corrected=makeFixedRow(x);
    if(JSON.stringify(old.values.slice(0,fixedHeaders.length))!==JSON.stringify(corrected)){
      fixedUpdates.push({rowNumber:old.rowNumber,values:corrected});
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
    if(normValue(row[fh['啟用']])!=='是' || !student || isUnavailableSlot(student)) continue;
    if(str(row[fh['校區']])) continue;
    row[fh['校區']]=DEFAULT_SITE;
    fixedUpdates.push({rowNumber:old.rowNumber,values:row.slice(0,fixedHeaders.length)});
  }
  const adjustHeaders=(adjustRows[adjustHeaderRow]||[]).map(str);
  const ah=hmap(adjustHeaders);
  const existingAdjustIds=new Set();
  const existingAdjustById=new Map();
  const existingAdjustBySignature=new Map();
  const adjustmentUpdates=[];
  const adjustmentRowsUsed=new Set();
  const expectedTargetKeys=new Set();
  const fixedIdByKey=new Map(matchedFixed.map(x=>[rawFixedLogicalKey(x),x.id]));
  const assignedAdjustments=assignPreviewAdjustmentIds(
    parsed.adjustments.map(x=>({
      ...x,
      fixedId:fixedIdByKey.get(rawFixedLogicalKey({
        weekday:x.weekday,
        time:x.originalTime||x.time,
        student:x.student,
        course:x.course||'',
        teacher:x.teacher
      }))||x.fixedId||''
    })),
    adjustRows
  );

  const normalizedAdjustStudent=value=>{
    const source=str(value);
    const group=source.match(/^(.*?團班)\s*[（(]([^（）()]*)[）)]$/);
    return compact(normalizeStudentNameForContact(group?group[2]:source));
  };
  const adjustmentSignature=x=>[
    parseDateFlexible(x.originalDate)||'',
    parseTimeRange(x.originalTime).start||timeKey(x.originalTime)||'',
    parseDateFlexible(x.newDate)||'',
    normalizedAdjustStudent(x.student),
    compact(str(x.teacher))
  ].join('|');
  const isSourceImportedAdjustment=note=>
    /來源：開學課表/.test(str(note))||
    /^\[(?:單次課程|單次／紫色調課|紫色調課)\]/.test(str(note));

  for(let i=adjustHeaderRow+1;i<adjustRows.length;i++){
    const row=adjustRows[i]||[];
    const id=str(row[ah['調課ID']]);
    if(!id)continue;
    existingAdjustIds.add(id);
    const originalDate=parseDateFlexible(row[ah['原日期']]);
    const originalTime=parseTimeRange(row[ah['原時間']]).start||timeKey(row[ah['原時間']]);
    const newDate=parseDateFlexible(row[ah['新日期']]);
    const newRange=parseTimeRange(row[ah['新時間']]);
    const record={
      id,rowNumber:i+1,values:row,
      fixedId:str(row[ah['原固定課表ID']]),
      originalDate,originalTime,
      action:str(row[ah['動作']]),newDate,
      newTime:newRange.start&&newRange.end?newRange.start+'-'+newRange.end:(newRange.start||timeKey(row[ah['新時間']])),
      student:str(row[ah['學生']]),course:str(row[ah['新課程']]),
      teacher:str(row[ah['新老師']]),site:str(row[ah['新校區']]),
      confirm:str(row[ah['確認']]),note:str(row[ah['備註']])
    };
    record.signature=adjustmentSignature(record);
    record.sourceImported=isSourceImportedAdjustment(record.note)||/^ADJ\d+$/i.test(id)&&/紫色|單次|來源：開學課表/.test(record.note);
    existingAdjustById.set(id,record);
    if(record.signature){
      if(!existingAdjustBySignature.has(record.signature))existingAdjustBySignature.set(record.signature,[]);
      existingAdjustBySignature.get(record.signature).push(record);
    }
  }

  const targetSignature=x=>[
    parseDateFlexible(x.newDate)||'',
    parseTimeRange(x.newTime).start||timeKey(x.newTime)||'',
    normalizedAdjustStudent(x.student),
    compact(str(x.teacher)),
    compact(normalizeSite(x.site))
  ].join('|');

  const makeAdjustmentRow=(x,id,confirm,oldValues=[])=>{
    const row=oldValues.slice();
    while(row.length<adjustHeaders.length)row.push('');
    const set=(name,value)=>{if(ah[name]!==undefined)row[ah[name]]=value??'';};
    set('調課ID',id);
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
    set('確認',confirm||'是');
    const sourceNote=str(x.note);
    set('備註',/^來源：開學課表/.test(sourceNote)?sourceNote:'來源：開學課表自動解析；'+sourceNote);
    return row.slice(0,adjustHeaders.length);
  };

  const adjustOutput=[];
  for(const x of assignedAdjustments){
    if(x.newDate&&!/請假|取消|停課/.test(str(x.action)))expectedTargetKeys.add(targetSignature(x));
    const signature=adjustmentSignature(x);
    const exact=existingAdjustById.get(str(x.id));
    const candidates=signature?(existingAdjustBySignature.get(signature)||[]):[];
    const old=(exact&&exact.sourceImported?exact:null)||
      candidates.find(row=>row.sourceImported&&!adjustmentRowsUsed.has(row.rowNumber))||
      candidates.find(row=>!adjustmentRowsUsed.has(row.rowNumber))||
      null;

    if(old){
      // Preserve an existing ID and a deliberate confirmation-off state, but refresh parser-owned fields.
      adjustmentRowsUsed.add(old.rowNumber);
      if(!old.sourceImported){
        // A manually maintained adjustment with the same logical date/student/teacher is authoritative.
        continue;
      }
      const values=makeAdjustmentRow(x,old.id,old.confirm||'是',old.values);
      if(JSON.stringify(old.values.slice(0,adjustHeaders.length))!==JSON.stringify(values)){
        adjustmentUpdates.push({rowNumber:old.rowNumber,values});
      }
      continue;
    }

    if(existingAdjustIds.has(str(x.id))){
      // Never overwrite an existing row solely because an ID happens to collide.
      continue;
    }
    adjustOutput.push(makeAdjustmentRow(x,x.id,'是'));
  }

  // Retire old parser-owned duplicate rows when a source move and a destination-row
  // annotation previously created the same target lesson under different IDs.
  for(const old of existingAdjustById.values()){
    if(adjustmentRowsUsed.has(old.rowNumber)||!old.sourceImported||!old.newDate)continue;
    if(/請假|取消|停課/.test(old.action))continue;
    if(!expectedTargetKeys.has(targetSignature(old)))continue;
    const values=old.values.slice();
    while(values.length<adjustHeaders.length)values.push('');
    if(ah['確認']!==undefined)values[ah['確認']]='否';
    if(ah['備註']!==undefined){
      const note=str(values[ah['備註']]);
      const marker='同步健檢：同一目標日期／學生／開始時間已由新版解析列代表，停用重複舊列';
      if(!note.includes(marker))values[ah['備註']]=note+'；'+marker;
    }
    adjustmentUpdates.push({rowNumber:old.rowNumber,values:values.slice(0,adjustHeaders.length)});
    adjustmentRowsUsed.add(old.rowNumber);
  }
  const sourceWriteData=[];
  for(const u of adjustmentUpdates){
    sourceWriteData.push({
      range:qsheet('調課課程')+'!A'+u.rowNumber+':'+columnLetter(adjustHeaders.length)+u.rowNumber,
      values:[u.values]
    });
  }
  for(const u of fixedUpdates){
    sourceWriteData.push({
      range:qsheet('固定課表')+'!A'+u.rowNumber+':'+columnLetter(fixedHeaders.length)+u.rowNumber,
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
    adjustmentsCorrected:adjustmentUpdates.length,
    existingRowsPreserved:true,
    translationEnabled:true
  };
}


function shouldPreserveReminderConfirmation(oldValues, proposedValues, headers, includeMessage=true){
  const h=hmap(headers);
  const fields=['課程日期','上課時間','發送日期','發送時間','學生/學生成員','課程','老師','校區'];
  if(includeMessage) fields.push('訊息內容');
  return fields.every(name=>h[name]!==undefined&&str((oldValues||[])[h[name]])===str((proposedValues||[])[h[name]]));
}

function adjustmentConflictWarnings(adjustments){
  const groups=new Map();
  for(const a of adjustments||[]){
    if(!a.originalDate||!a.originalTime||!str(a.student)) continue;
    const key=[a.originalDate,compact(a.student),timeKey(a.originalTime)||str(a.originalTime)].join('|');
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(a);
  }
  const warnings=[];
  for(const [key,group] of groups){
    if(group.length<2) continue;
    const signatures=new Set(group.map(a=>[
      norm(a.action),a.newDate||'',normalizeTimeRange(a.newTime)||str(a.newTime),
      timeKey(a.newEndTime)||str(a.newEndTime),compact(a.course),compact(a.teacher),compact(a.site)
    ].join('|')));
    if(signatures.size<2) continue;
    const [date,student,time]=key.split('|');
    const ids=group.map(x=>str(x.id)||'(無 ID)').slice(0,4).join('、');
    warnings.push('同一課程有 '+signatures.size+' 種不同調整：'+student+' '+date+' '+time+'；程式依既有優先序處理，其餘請人工核對。調課ID：'+ids);
  }
  return warnings.slice(0,20);
}

function fixedDataQualityWarnings(rows, referenceDate=todayKey()){
  const hr=findHeaderRow(rows,['固定課表ID','星期','上課時間','學生','課程','老師','校區','有效迄日','啟用']);
  if(hr<0) return ['固定課表缺少必要標題列，無法完整核對資料品質。'];
  const h=hmap(rows[hr]);
  const badEnabled=[],badWeekday=[],badTime=[],badUntil=[],missingStudent=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[],id=str(r[h['固定課表ID']]);
    if(!id) continue;
    const enabledRaw=str(r[h['啟用']]);
    if(!isYes(enabledRaw)&&!isNo(enabledRaw)){badEnabled.push('列 '+(i+1)+'（'+id+'）');continue;}
    if(!isYes(enabledRaw)) continue;
    const weekday=normalizeWeekday(r[h['星期']]);
    if(!['一','二','三','四','五','六','日'].includes(weekday)) badWeekday.push('列 '+(i+1)+'（'+id+'）');
    const rawTime=str(r[h['上課時間']]),range=parseTimeRange(rawTime),start=range.start||timeKey(rawTime);
    if(!start) badTime.push('列 '+(i+1)+'（'+id+'：'+(rawTime||'時間空白')+'）');
    const untilRaw=r[h['有效迄日']];
    if(str(untilRaw)&&!parseDateFlexible(untilRaw,referenceDate)) badUntil.push('列 '+(i+1)+'（'+id+'：'+str(untilRaw)+'）');
    const student=str(r[h['學生']])||extractStudentFromTime(rawTime);
    if(!student) missingStudent.push('列 '+(i+1)+'（'+id+'）');
  }
  const warnings=[];
  if(badEnabled.length) warnings.push('固定課表有 '+badEnabled.length+' 筆「啟用」欄位不是明確的是／否；例：'+badEnabled.slice(0,5).join('、'));
  if(badWeekday.length) warnings.push('固定課表有 '+badWeekday.length+' 筆星期無法判讀；例：'+badWeekday.slice(0,5).join('、'));
  if(badTime.length) warnings.push('固定課表有 '+badTime.length+' 筆上課時間無法判讀；例：'+badTime.slice(0,5).join('、'));
  if(badUntil.length) warnings.push('固定課表有 '+badUntil.length+' 筆有效迄日無法判讀；可能被當成沒有到期日。例：'+badUntil.slice(0,5).join('、'));
  if(missingStudent.length) warnings.push('固定課表有 '+missingStudent.length+' 筆學生欄空白且無法從時間欄還原；例：'+missingStudent.slice(0,5).join('、'));
  return warnings;
}

function actualIntegrityWarnings(actualRows){
  const rows=actualRows||[];
  const seen=new Map(),duplicateSamples=[],invalidDateSamples=[],invalidTimeSamples=[],inconsistentTimeSamples=[];
  const studentIntervals=new Map(),teacherIntervals=new Map();
  const minutes=value=>{const t=timeKey(value);if(!t)return -1;const [h,m]=t.split(':').map(Number);return h*60+m;};
  const addInterval=(map,key,item)=>{if(!map.has(key))map.set(key,new Map());map.get(key).set(item.signature,item);};
  for(const row of rows){
    const date=dateKey(row?.[1]),range=parseTimeRange(row?.[3]);
    const start=range.start||timeKey(row?.[13])||timeKey(row?.[3]);
    const end=range.end||timeKey(row?.[14]);
    const student=str(row?.[4]),course=str(row?.[5]),teacher=str(row?.[6]),site=normalizeSite(row?.[7]);
    const label=[student,date,str(row?.[3]),course,teacher].filter(Boolean).join(' / ');
    if(!isValidDateKey(date)) invalidDateSamples.push(label||'(空白課程)');
    if(!start) invalidTimeSamples.push(label||'(空白課程)');
    if(start&&end&&minutes(end)<=minutes(start)) invalidTimeSamples.push(label+'（下課時間不晚於上課時間）');
    if(range.start&&start&&range.start!==start) inconsistentTimeSamples.push(label+'（上課時間與出勤開始時間不一致）');
    if(range.end&&end&&range.end!==end) inconsistentTimeSamples.push(label+'（上課時間與出勤下課時間不一致）');
    const duplicateKey=[date,start,end,compact(student),compact(course),compact(teacher),compact(site)].join('|');
    if(isValidDateKey(date)&&start&&student){
      if(seen.has(duplicateKey)){if(duplicateSamples.length<5)duplicateSamples.push(label);}
      else seen.set(duplicateKey,label);
    }
    if(isValidDateKey(date)&&start&&end&&minutes(end)>minutes(start)){
      const signature=[date,start,end,compact(student),compact(course),compact(teacher),compact(site)].join('|');
      const item={date,start,end,startMinute:minutes(start),endMinute:minutes(end),student,teacher,signature};
      if(student)addInterval(studentIntervals,date+'|'+compact(student),item);
      if(teacher)addInterval(teacherIntervals,date+'|'+compact(teacher),{...item,signature:[date,start,end,compact(teacher),compact(course),compact(site)].join('|')});
    }
  }
  const overlaps=(map,entity)=>{
    let count=0;const samples=[];
    for(const [groupKey,bySignature] of map){
      const items=Array.from(bySignature.values()).sort((a,b)=>a.startMinute-b.startMinute||a.endMinute-b.endMinute);
      for(let i=0;i<items.length;i++){
        for(let j=i+1;j<items.length&&items[j].startMinute<items[i].endMinute;j++){
          if(items[i].signature===items[j].signature)continue;
          count++;
          if(samples.length<5)samples.push(entity+'「'+(entity==='學生'?items[i].student:items[i].teacher)+'」'+items[i].date+'：'+items[i].start+'-'+items[i].end+' 與 '+items[j].start+'-'+items[j].end+' 重疊');
        }
      }
    }
    return {count,samples};
  };
  const studentOverlap=overlaps(studentIntervals,'學生'),teacherOverlap=overlaps(teacherIntervals,'老師');
  const warnings=[];
  if(duplicateSamples.length)warnings.push('實際課程疑似有重複列；例：'+duplicateSamples.join('；'));
  if(invalidDateSamples.length)warnings.push('實際課程有 '+invalidDateSamples.length+' 筆日期無法判讀；例：'+invalidDateSamples.slice(0,3).join('；'));
  if(invalidTimeSamples.length)warnings.push('實際課程有 '+invalidTimeSamples.length+' 筆時間無效或區間不合理；例：'+invalidTimeSamples.slice(0,3).join('；'));
  if(inconsistentTimeSamples.length)warnings.push('實際課程時間欄與出勤時間欄有 '+inconsistentTimeSamples.length+' 筆不一致；例：'+inconsistentTimeSamples.slice(0,3).join('；'));
  if(studentOverlap.count)warnings.push('實際課程有 '+studentOverlap.count+' 組學生上課時段重疊；例：'+studentOverlap.samples.join('；'));
  if(teacherOverlap.count)warnings.push('實際課程有 '+teacherOverlap.count+' 組老師上課時段重疊；例：'+teacherOverlap.samples.join('；'));
  return warnings;
}

function missingActualEndTimeWarnings(actualRows){
  const missing=(actualRows||[]).filter(row=>!(parseTimeRange(row[3]).end||timeKey(row[14])));
  if(!missing.length)return [];
  return ['有 '+missing.length+' 筆實際課程缺少下課時間；例：'+missing.slice(0,5).map(row=>str(row[4])+' '+str(row[1])+' '+str(row[3])).join('、')];
}

function missingRecipientWarnings(actualRows, contacts, settings){
  const actual=actualObjects(actualRows||[]);
  const missingParents=new Map(),missingTeachers=new Map();
  for(const c of actual){
    if(c.adjustResult==='取消'||!str(c.student)||isUnavailableSlot(c.student))continue;
    if(isYes(settings.parentNotify,true)){
      const students=extractReminderStudentNames(c.student);
      for(const name of (students.length?students:[c.student])){
        const found=(contacts||[]).some(x=>x.role==='家長'&&includesStudent(x.related,name));
        if(!found&&!missingParents.has(compact(name)))missingParents.set(compact(name),name+'（'+c.date+' '+c.time+'）');
      }
    }
    if(isYes(settings.teacherNotify,true)){
      const teacher=str(c.teacher);
      const found=teacher&&(contacts||[]).some(x=>x.role==='老師'&&compact(x.related)===compact(teacher));
      if(!found){
        const display=teacher||'(老師欄空白)';
        if(!missingTeachers.has(compact(display)))missingTeachers.set(compact(display),display+'（'+c.date+' '+c.time+'）');
      }
    }
  }
  const warnings=[];
  if(missingParents.size)warnings.push('有 '+missingParents.size+' 位學生找不到已啟用且可匹配的家長 LINE 聯絡人，家長提醒不會建立；例：'+Array.from(missingParents.values()).slice(0,5).join('、'));
  if(missingTeachers.size)warnings.push('有 '+missingTeachers.size+' 位老師找不到已啟用且可匹配的 LINE 聯絡人，老師提醒不會建立；例：'+Array.from(missingTeachers.values()).slice(0,5).join('、'));
  return warnings;
}

function notificationTemplateWarnings(templates,settings){
  const warnings=[];
  if(isYes(settings.parentNotify,true)&&!(templates||[]).some(t=>t.name==='家長一般'&&str(t.content)))warnings.push('訊息模板缺少有效的「家長一般」模板；請確認提醒是否有非空白訊息。');
  if(isYes(settings.teacherNotify,true)&&!(templates||[]).some(t=>t.name==='老師通知'&&str(t.content)))warnings.push('訊息模板缺少有效的「老師通知」模板；請確認提醒是否有非空白訊息。');
  return warnings;
}

function adminAuthorized(req){
  const expected=String(process.env.SCHEDULE_ADMIN_TOKEN||'');
  if(!expected)return false;
  const supplied=String((req&&req.get&&req.get('x-admin-token'))||req?.query?.token||'');
  const a=Buffer.from(expected),b=Buffer.from(supplied);
  return a.length===b.length&&require('crypto').timingSafeEqual(a,b);
}

async function build({fromDate=todayKey(),days=DEFAULT_DAYS}={}){
  if(!isValidDateKey(fromDate)) throw new Error('fromDate 必須是有效的 YYYY-MM-DD 日期');
  if(!Number.isInteger(days)||days<1||days>180) throw new Error('days 必須是 1 到 180 的整數');
  const sourceSync=await syncSourceIntoSchedule();
  await ensureSheet('課程提醒');
  await ensureSheetHeaders('課程校正',CORRECTION_HEADERS);
  const [settingsRows,fixedRows,adjustRows,correctionRows,oldActualRows,contactRows,templateRows,reminderRows] = await readSheets();
  const settings=parseSettings(settingsRows);
  const fixed=parseFixed(fixedRows); const adjusts=[...parseAdjust(adjustRows,correctionRows),...parseInlineAdjustments(fixed)]; const contacts=parseContacts(contactRows); const templates=parseTemplates(templateRows);
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
  await writeActual(actual,oldActualRows,fromDate,addDays(fromDate,days-1));
  const reminder=AUTO_CREATE_REMINDERS
    ? await syncReminders(actual,reminderRows,contacts,templates,settings,fromDate,days,fixedTemplateByIdInput)
    : {expectedCount:0,created:0,updated:0,disabled:0,reminderServiceEnabled:settings.enabled==='是',autoCreateReminders:false,lineSending:false};
  return {ok:true,fromDate,toDate:addDays(fromDate,days-1),sourceSync,fixedCount:fixed.length,adjustCount:adjusts.length,actualCount:actual.length,reminder};
}

let lastBuild={status:'not_run'};
let buildInProgress=null;
app.get('/health',(req,res)=>res.json({ok:true,service:'line-course-schedule-manager-v1.2',timezone:TZ,lastBuild}));
async function buildOnce(options){
  if(buildInProgress) return buildInProgress;
  buildInProgress=build(options).finally(()=>{ buildInProgress=null; });
  return buildInProgress;
}

app.get('/build',async(req,res)=>{
  try{
    const fromDate=req.query.from || todayKey();
    const days=Math.min(180,Math.max(1,Number(req.query.days||DEFAULT_DAYS)));
    lastBuild=await buildOnce({fromDate,days}); lastBuild.at=new Date().toISOString();
    res.json(lastBuild);
  }catch(e){ lastBuild={status:'error',error:e.message,at:new Date().toISOString()}; console.error(e); res.status(500).json(lastBuild); }
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
  const lines=splitWrappedCourseLines(rawText);
  const out=[];
  for(const match of lines){
    const originalLine=match.text;
    const line=originalLine.trim();
    if(!line) continue;
    const lineStart=match.start;
    const tm=line.match(/^(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})\s*(.*)$/);
    if(!tm) continue;
    const start=timeKey(tm[1]), end=timeKey(tm[2]);
    let rest=str(tm[3]);
    if(!start || !end || !rest) continue;
    // The sheet legend marks yellow text as "確認中". Some lessons color only
    // the time range yellow while leaving the student name dark; inspect both.
    const timeColorInfo=classifyRawFontColor(cell,lineStart+Math.max(0,line.indexOf(tm[1])),themeColors);
    const contentColorInfo=classifyRawFontColor(cell,lineStart+Math.max(0,line.indexOf(tm[3])),themeColors);
    const colorInfo =
      [timeColorInfo,contentColorInfo].find(x=>x.status==='red') ||
      [timeColorInfo,contentColorInfo].find(x=>x.status==='yellow') ||
      [contentColorInfo,timeColorInfo].find(x=>x.status==='purple') ||
      contentColorInfo;
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
    const annotationText=annotations.join('；');
    const startsOn=parseCourseStartDateNote(annotationText,year);
    const durationMatch=student.match(/(?:\+|＋)\s*30\s*min(?:ute)?s?/i);
    const durationVariantNote=/各\s*[+＋]?\s*30\s*min(?:ute)?s?/i.test(annotationText);
    const durationAdjustmentMinutes=(durationMatch||durationVariantNote)?30:0;
    if(durationMatch) student=student.replace(/(?:\+|＋)\s*30\s*min(?:ute)?s?/ig,'').trim();
    let course='';
    const groupMatch=student.match(/^(.*?團班)\s*[（(]([^（）()]*)[）)]$/);
    if(groupMatch){
      course=str(groupMatch[1]);
      student=split(groupMatch[2]).join('、');
    }else{
      const subjectMatch=student.match(/^(.+?)(國文|數學|理化|物理|化學|英文|生物|自然|社會)$/);
      if(subjectMatch&&subjectMatch[1]&&!/團班/.test(subjectMatch[1])){
        student=str(subjectMatch[1]);
        course=str(subjectMatch[2]);
      }
    }
    const untilMatch=annotationText.match(/(?:直到|至)\s*(\d{1,2})\/(\d{1,2})/);
    const untilDate=untilMatch?parseDateFlexible(untilMatch[1]+'/'+untilMatch[2],year):'';
    out.push({
      teacher,weekday,time:start,endTime:end,student,course,site:'',
      annotations,raw:line,cellText:rawText,colorStatus:colorInfo.status,colorHex:colorInfo.hex,
      colorSource:colorInfo.colorSource,timeColorStatus:timeColorInfo.status,timeColorHex:timeColorInfo.hex,
      contentColorStatus:contentColorInfo.status,contentColorHex:contentColorInfo.hex,
      durationAdjustmentMinutes,untilDate,startsOn,
      note:[colorInfo.status==='yellow'?'[黃色確認中]':'',durationAdjustmentMinutes?'[指定日期加時30分鐘]':'',annotations.some(a=>/可能加半小|可能延長半小時|問要不要加\d+分/.test(a))?'[加時尚待確認]':'',annotations.length?'來源註記：'+annotationText:''].filter(Boolean).join('；')
    });
  }
  return out;
}

function parseRawPurpleCourse(item, year = new Date().getFullYear()){
  const annotations=(item.annotations||[]).map(str);
  const annotationText=annotations.join('；');
  const fullRange=item.endTime?item.time+'-'+item.endTime:item.time;
  let newDate='',newTime=fullRange,action='補課',originNote='';

  const weekdayOf=date=>date?weekdayLabel(date):'';
  const rowTexts=Array.isArray(item.rowCellTexts)?item.rowCellTexts:[];
  const moveTargetsForStudent=[];
  for(const cell of rowTexts){
    for(const line of String(cell.text||'').split(/\r?\n/)){
      if(!line.includes(str(item.student)))continue;
      const re=/(\d{1,2})\/(\d{1,2})[^()]*?調\s*(\d{1,2})\/(\d{1,2})/g;
      let m;
      while((m=re.exec(line))){
        const target=parseDateFlexible(m[3]+'/'+m[4],year);
        if(target&&weekdayOf(target)===item.weekday&&!moveTargetsForStudent.includes(target))moveTargetsForStudent.push(target);
      }
    }
  }

  // Purple notes such as "10/10p調10/9b" represent a one-off lesson on the target date.
  const moveRe=/(?:^|[^0-9])(\d{1,2})\/(\d{1,2})[^()]*?調\s*(\d{1,2})\/(\d{1,2})/;
  const moveMatch=annotationText.replace(/\s+/g,'').match(moveRe);
  if(moveMatch){
    const from=parseDateFlexible(moveMatch[1]+'/'+moveMatch[2],year);
    newDate=parseDateFlexible(moveMatch[3]+'/'+moveMatch[4],year);
    if(from)originNote='來源日期 '+from+'；';
    action='補課';
  }else{
    const timeMatch=annotationText.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})/);
    if(timeMatch){
      newDate=parseDateFlexible(timeMatch[1]+'/'+timeMatch[2],year);
      newTime=(timeKey(timeMatch[3])||item.time)+'-'+(timeKey(timeMatch[4])||item.endTime);
      action='補課';
    }else{
      const singleDate=parseSingleDateOnlyNote(annotations,year);
      const addDate=annotationText.match(/(\d{1,2})\/(\d{1,2})[^()（）]*?(?:補課|加課)/);
      const addCourse=annotationText.match(/(\d{1,2})\/(\d{1,2})\s*([^()（）]*?)\s*(?:補課|加課)/);
      if(singleDate){
        newDate=singleDate;
        action='補課';
      }else if(addDate){
        newDate=parseDateFlexible(addDate[1]+'/'+addDate[2],year);
        action='加課';
        if(addCourse&&str(addCourse[3]))item.course=str(addCourse[3]);
      }
    }
  }

  const isKnownSubstitute=item.teacher==='楊詔鈞'&&
    ['凱荻','昜寧'].includes(str(item.student).replace(/英文$/,''))&&
    /代戴老師/.test(annotationText)&&item.weekday==='五';
  const isPossibleExtension=/可能加半小|可能延長半小時/.test(annotationText)&&
    str(item.student).includes('郁翔')&&item.weekday==='五';

  if(!newDate&&isKnownSubstitute){
    // Use the explicit date anchor in this teacher's cell (e.g. another Friday class marked 10/9p).
    const anchors=[...String(item.cellText||'').matchAll(/(\d{1,2})\/(\d{1,2})p/gi)]
      .map(m=>parseDateFlexible(m[1]+'/'+m[2],year))
      .filter(d=>d&&weekdayOf(d)===item.weekday);
    newDate=anchors[0]||moveTargetsForStudent[0]||'';
    if(newDate){
      action='代課';
      originNote='同一來源儲存格的指定日期錨點 '+newDate+'；';
    }
  }
  if(!newDate&&isPossibleExtension){
    newDate=moveTargetsForStudent[0]||'';
    if(newDate){
      action='補課';
      originNote='依同一教師列、相同學生的調課目標日期推定 '+newDate+'；';
    }
  }
  if(!newDate)return [];

  const extensionNote=isPossibleExtension?'；[可能延長30分鐘，待確認；不變更原定時間]':'';
  const studentName=isKnownSubstitute?str(item.student).replace(/英文$/,''):item.student;
  const courseName=isKnownSubstitute?'英文':item.course;
  return [{
    id:'',fixedId:'',weekday:item.weekday,originalDate:'',originalTime:'',
    action,newDate,newTime,student:studentName,course:courseName,
    teacher:item.teacher,site:item.site,
    note:'[單次／紫色調課] '+originNote+'課程：'+(item.raw||item.student)+'；備註：'+(annotationText||'無')+'；字色 '+(item.colorHex||'未知')+extensionNote,
    source:'開學課表',colorStatus:item.colorStatus,colorHex:item.colorHex||''
  }];
}

function parseRawAdjustmentAnnotations(item, year = new Date().getFullYear()){
  const out=[];
  const seen=new Set();
  const fullRange=item.endTime?item.time+'-'+item.endTime:item.time;
  const add=values=>{
    const entry={
      id:'',fixedId:'',weekday:item.weekday,colorStatus:item.colorStatus,colorHex:item.colorHex,
      originalDate:'',originalTime:'',action:'',newDate:'',newTime:'',
      student:item.student,course:item.course,teacher:item.teacher,site:item.site,
      note:'來源：開學課表；'+values.note,source:'開學課表',...values
    };
    const key=[entry.action,entry.originalDate,entry.originalTime,entry.newDate,entry.newTime,compact(entry.student),entry.course||'',entry.teacher||''].join('|');
    if(seen.has(key))return;
    seen.add(key);
    out.push(entry);
  };

  for(const note of item.annotations||[]){
    const rawText=str(note);
    if(!rawText)continue;
    const override=sourceTeacherCourseOverride(rawText);
    const targetTeacher=override.teacher||item.teacher;
    const targetCourse=override.course||item.course;

    // Same-day time change: 10/9改1030~1230.
    const sameDay=parseSameDayTimeChangeNote(rawText,year);
    if(sameDay){
      add({
        originalDate:sameDay.date,originalTime:item.time,
        action:override.teacher?'代課':'改時間',
        newDate:sameDay.date,newTime:sameDay.start+'-'+sameDay.end,
        teacher:targetTeacher,course:targetCourse,
        note:rawText+'（調整後時段 '+sameDay.start+'-'+sameDay.end+'）'
      });
      continue;
    }

    // Date plus explicit time: 10/9 0900-1030. Keep the complete range and any substitute teacher.
    const datedTime=rawText.match(/^\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})(?:\s*(.*))?$/);
    if(datedTime){
      const d=parseDateFlexible(datedTime[1]+'/'+datedTime[2],year);
      const start=timeKey(datedTime[3]),end=timeKey(datedTime[4]);
      if(d&&start&&end){
        add({
          originalDate:d,originalTime:item.time,action:override.teacher?'代課':'改時間',
          newDate:d,newTime:start+'-'+end,
          teacher:targetTeacher,course:targetCourse,
          note:rawText+'（原時段 '+fullRange+'；調整後 '+start+'-'+end+'）'
        });
      }
      continue;
    }

    // A parenthetical can contain a move note and a second time override after a comma.
    const embeddedTimeRe=/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})/g;
    let embeddedTime;
    while((embeddedTime=embeddedTimeRe.exec(rawText))){
      const d=parseDateFlexible(embeddedTime[1]+'/'+embeddedTime[2],year);
      const start=timeKey(embeddedTime[3]),end=timeKey(embeddedTime[4]);
      if(d&&start&&end){
        add({
          originalDate:d,originalTime:item.time,action:override.teacher?'代課':'改時間',
          newDate:d,newTime:start+'-'+end,
          teacher:targetTeacher,course:targetCourse,
          note:rawText+'（調整後時段 '+start+'-'+end+'）'
        });
      }
    }

    // Explicit subject/course change on a date, e.g. 10/15改上地理.
    const courseChange=rawText.match(/(?:^|[^0-9])(\d{1,2})\/(\d{1,2})\s*改上\s*(.+)$/);
    if(courseChange){
      const d=parseDateFlexible(courseChange[1]+'/'+courseChange[2],year);
      const course=str(courseChange[3]).replace(/[）)]$/,'').trim();
      if(d&&course){
        add({
          originalDate:d,originalTime:item.time,action:'改課',
          newDate:d,newTime:fullRange,course,
          teacher:targetTeacher,
          note:rawText+'（該日課程改為 '+course+'）'
        });
      }
      continue;
    }

    // Move source date to one or more target dates; preserve any explicit substitute/subject suffix.
    const move=rawText.match(/(\d{1,2})\/(\d{1,2})[^()]*?調\s*(\d{1,2})\/(\d{1,2})/);
    if(move){
      const from=parseDateFlexible(move[1]+'/'+move[2],year);
      const firstTo=parseDateFlexible(move[3]+'/'+move[4],year);
      const duration=rawText.match(/[+＋]\s*(\d{1,3})\s*(?:min(?:ute)?s?|分)/i);
      const movedRange=duration&&item.endTime
        ? item.time+'-'+(addMinutesToTime(item.endTime,Number(duration[1]))||item.endTime)
        : fullRange;
      const targets=[];
      if(firstTo)targets.push(firstTo);
      const tail=rawText.slice(move.index+move[0].length);
      const tailRe=/[、,，]\s*(\d{1,2})\/(\d{1,2})(?:b)?/gi;
      let targetMatch;
      while((targetMatch=tailRe.exec(tail))){
        const after=tail.slice(tailRe.lastIndex);
        if(/^\s+\d{1,2}:?\d{2}\s*[-~～至]/.test(after))continue;
        const d=parseDateFlexible(targetMatch[1]+'/'+targetMatch[2],year);
        if(d&&!targets.includes(d))targets.push(d);
      }
      for(const to of targets){
        if(!from||!to)continue;
        add({
          originalDate:from,originalTime:item.time,action:'調課',
          newDate:to,newTime:movedRange,
          teacher:targetTeacher,course:targetCourse,
          note:rawText+(duration?'（調課後時段 '+movedRange+'）':'')
        });
      }
      continue;
    }

    // A plain "師p" marks teacher leave for this date. A "師p調..." move above
    // is already handled as a move and must not become a second cancellation.
    const teacherAbsenceDate=parseTeacherAbsenceNote(rawText,year);
    if(teacherAbsenceDate){
      add({
        originalDate:teacherAbsenceDate,originalTime:item.time,action:'停課',
        newDate:teacherAbsenceDate,newTime:fullRange,
        teacher:targetTeacher,course:targetCourse,
        note:'老師請假標記：'+rawText+'；本日不排課'
      });
      continue;
    }

    // Standalone p marks absence; p調 was already handled as a move.
    const absenceRe=/(\d{1,2})\/(\d{1,2})\s*p(?!\s*調)(?=$|[^a-z0-9])/gi;
    let m;
    while((m=absenceRe.exec(rawText))){
      const d=parseDateFlexible(m[1]+'/'+m[2],year);
      if(d)add({
        originalDate:d,originalTime:item.time,action:'請假',
        newDate:d,newTime:fullRange,teacher:targetTeacher,course:targetCourse,note:rawText
      });
    }

    // Definite date-specific extensions.
    const extension=rawText.match(/(?:加時(?:一次)?\s*(\d{1,3})\s*(?:min(?:ute)?s?|分)|加\s*(\d{1,3})\s*分)/i);
    if(extension&&!move){
      const dateMatch=rawText.match(/(\d{1,2})\/(\d{1,2})/);
      const minutes=Number(extension[1]||extension[2]||30);
      const d=dateMatch?parseDateFlexible(dateMatch[1]+'/'+dateMatch[2],year):'';
      const end=addMinutesToTime(item.endTime,minutes);
      if(d&&end)add({
        originalDate:d,originalTime:item.time,action:'延長時間',
        newDate:d,newTime:item.time+'-'+end,
        teacher:targetTeacher,course:targetCourse,
        note:rawText+'（加時 '+minutes+' 分鐘；調整後 '+item.time+'-'+end+'）'
      });
    }

    // Date-only make-up/addition is a one-off, never a recurring fixed class.
    const addMatch=rawText.match(/(\d{1,2})\/(\d{1,2})[^()（）]*?(?:補課|加課)/);
    if(addMatch){
      const d=parseDateFlexible(addMatch[1]+'/'+addMatch[2],year);
      const addCourseMatch=rawText.match(/(?:\d{1,2})\/(?:\d{1,2})\s*([^()（）]*?)(?:補課|加課)/);
      const oneOffCourse=str(addCourseMatch?.[1])||targetCourse;
      if(d)add({
        originalDate:'',originalTime:'',action:'補課',
        newDate:d,newTime:fullRange,teacher:targetTeacher,course:oneOffCourse,note:rawText
      });
    }
  }
  return out;
}

function rawFixedLogicalKey(x){
  const rawTime=str(x.time);
  const start=parseTimeRange(rawTime).start || timeKey(rawTime);
  let student=stripScheduleAnnotation(x.student);
  let course=str(x.course);
  const group=student.match(/^(.*?團班)\s*[（(]([^（）()]*)[）)]$/);
  if(group){course=course||group[1];student=group[2];}
  const normalizedStudent=normalizeStudentNameForContact(student);
  const groupCourse=/團班/.test(course)?course:'';
  return [norm(x.weekday),start,compact(groupCourse),compact(normalizedStudent),compact(stripScheduleAnnotation(x.teacher))].join('|');
}

function parseRawSchedule(rows, year = new Date().getFullYear(), themeColors = {}){
  if(!rows.length) throw new Error('找不到「開學課表」資料。');
  const header=rows[0]||[];
  const teacherAliases=new Set(['老師','授課老師','班別負責老師','負責老師']);
  const teacherCol=header.findIndex(x=>teacherAliases.has(normHeader(rawCellText(x))));
  const weekdayCols={};
  const weekdayMap={'1':'一','2':'二','3':'三','4':'四','5':'五','6':'六','日':'日','一':'一','二':'二','三':'三','四':'四','五':'五','六':'六'};
  for(let i=0;i<header.length;i++){
    const m=rawCellText(header[i]).replace(/\s+/g,'').match(/^星期([一二三四五六日1-7])$/);
    if(m)weekdayCols[i]=weekdayMap[m[1]];
  }
  if(teacherCol<0||!Object.keys(weekdayCols).length){
    const seenHeader=header.map(rawCellText).filter(Boolean).join('、');
    throw new Error('「開學課表」格式不符合目前預期：需要老師欄及星期欄位；目前讀到：'+(seenHeader||'空白標題列'));
  }

  const fixed=[],adjustments=[],redItems=[],unclassifiedItems=[],durationRows=[];
  const isEarlier=(a,b)=>!a?b:!b?a:a<b?a:b;
  const oneOffDateList=(annotations)=>{
    const output=[],seen=new Set();
    for(const raw of annotations||[]){
      const note=str(raw);
      if(!note||/(?:p|調|改|請假|加時|加課|補課|代課|可能|直到)/i.test(note))continue;
      const matches=[...note.matchAll(/(\d{1,2})\/(\d{1,2})/g)];
      if(matches.length<2)continue;
      const stripped=note.replace(/(\d{1,2})\/(\d{1,2})/g,'DATE').replace(/[、,，\s]/g,'');
      if(stripped!=='DATEDATE'&&stripped!=='DATEDATEDATE')continue;
      for(const m of matches){
        const d=parseDateFlexible(m[1]+'/'+m[2],year);
        if(d&&!seen.has(d)){seen.add(d);output.push(d);}
      }
    }
    return output;
  };
  const addOneOff=(item,date,note)=>{
    const range=item.endTime?item.time+'-'+item.endTime:item.time;
    adjustments.push({
      id:'',fixedId:'',weekday:item.weekday,originalDate:'',originalTime:'',
      action:'補課',newDate:date,newTime:range,student:item.student,
      course:item.course||'',teacher:item.teacher,site:item.site,
      note:'[單次課程] '+(note||item.raw||item.student)+'；原始時段 '+range,
      source:'開學課表',colorStatus:item.colorStatus,colorHex:item.colorHex
    });
  };

  for(let r=1;r<rows.length;r++){
    const row=rows[r]||[];
    const teacherCell=rawCellText(row[teacherCol]);
    const teacherLines=teacherCell.split(/\r?\n/);
    const teacher=stripScheduleAnnotation((teacherLines[0]||'').replace(/[（(][^）)]*[）)]/g,(whole,x,offset,before)=>/(?:團班|班別)/.test(before||'')&&!/[0-9]/.test(x)?whole:''));
    if(!teacher)continue;
    const teacherNote=teacherLines.slice(1).join(' ');
    const teacherUntil=parseTeacherConfirmUntil(teacherNote,year);
    const teacherAbsenceDate=parseTeacherAbsenceNote(teacherCell,year);
    const rowCellTexts=Object.entries(weekdayCols).map(([col,day])=>({weekday:day,text:rawCellText(row[Number(col)])}));

    for(const [col,weekday] of Object.entries(weekdayCols)){
      const cellText=rawCellText(row[Number(col)]);
      for(const rawItem of parseRawCourseCell(row[Number(col)],teacher,weekday,year,themeColors)){
        const item={
          ...rawItem,
          untilDate:isEarlier(rawItem.untilDate,teacherUntil),
          cellText,
          rowCellTexts
        };
        if(teacherAbsenceDate&&weekdayLabel(teacherAbsenceDate)===item.weekday&&item.colorStatus==='black'){
          adjustments.push({
            id:'',fixedId:'',weekday:item.weekday,
            originalDate:teacherAbsenceDate,originalTime:item.time,
            action:'停課',newDate:teacherAbsenceDate,
            newTime:item.endTime?item.time+'-'+item.endTime:item.time,
            student:item.student,course:item.course,teacher:item.teacher,site:item.site,
            note:'來源：老師欄請假註記；'+teacherCell.replace(/\s+/g,' ').trim()+'；該日不排課',
            source:'開學課表'
          });
        }
        if(item.durationAdjustmentMinutes&&['black','yellow','purple'].includes(item.colorStatus)){
          durationRows.push(item);
          continue;
        }

        // Yellow font means "pending confirmation": never enqueue its parsed absences or moves as active changes.
        if(item.colorStatus==='yellow'){
          fixed.push(item);
          continue;
        }

        const singleDate=parseSingleDateOnlyNote(item.annotations,year);
        const listedDates=singleDate?[]:oneOffDateList(item.annotations);
        if(singleDate){
          addOneOff(item,singleDate,item.annotations.join('；'));
          continue;
        }
        if(listedDates.length){
          for(const d of listedDates)addOneOff(item,d,item.annotations.join('；'));
          continue;
        }

        // A row placed in the target weekday cell for a cross-weekday move is a date-scoped target,
        // not a new recurring fixed class. Keep its adjustment so the source lesson can be moved here.
        const annotatedMoves=parseRawAdjustmentAnnotations(item,year).filter(a=>
          a.originalDate&&a.newDate&&a.originalDate!==a.newDate&&
          weekdayLabel(a.newDate)===item.weekday&&
          weekdayLabel(a.originalDate)!==item.weekday
        );
        if(annotatedMoves.length){
          adjustments.push(...annotatedMoves.map(a=>({
            ...a,
            note:'[單次課程] 目的日課程；'+str(a.note||item.raw||item.student)
          })));
          continue;
        }

        // The source timetable may put a substitution in a black-font target cell as well as a purple one.
        // Keep only the date-scoped replacement; do not accidentally turn "代戴老師" into a weekly class.
        if(/代戴老師/.test((item.annotations||[]).join('；'))&&item.teacher==='楊詔鈞'&&['凱荻','昜寧'].includes(str(item.student).replace(/英文$/,''))){
          const special=parseRawPurpleCourse(item,year);
          if(special.length){adjustments.push(...special);continue;}
        }

        if(item.colorStatus==='black'){
          fixed.push(item);
          adjustments.push(...parseRawAdjustmentAnnotations(item,year));
        }else if(item.colorStatus==='purple'){
          const oneTime=parseRawPurpleCourse(item,year);
          if(oneTime.length)adjustments.push(...oneTime);
          else unclassifiedItems.push({...item,note:'[紫色課程待確認] 無法從備註判定單次上課日期或原／新日期'});
        }else if(item.colorStatus==='red'){
          redItems.push({...item,note:'[紅色自爆] 已終止／停課取消；不列入固定課表'});
        }else{
          unclassifiedItems.push({...item,note:'[顏色無法判讀] 未自動歸類，避免誤入固定課表'});
        }
      }
    }
  }

  // Apply explicit date-only extension variants to the corresponding ordinary fixed course.
  for(const item of durationRows){
    const annotationText=(item.annotations||[]).join('；');
    const parsedDates=parseDurationTargetDates(annotationText,year);
    const dates=parsedDates.targetDates||[];
    const base=fixed.find(x=>
      x.weekday===item.weekday&&
      compact(x.student)===compact(item.student)&&
      x.time===item.time&&
      !x.durationAdjustmentMinutes
    );

    if(parsedDates.sourceDate&&base&&weekdayLabel(parsedDates.sourceDate)===item.weekday){
      adjustments.push({
        id:'',fixedId:base.id||'',weekday:item.weekday,
        originalDate:parsedDates.sourceDate,originalTime:item.time,
        action:'請假',newDate:parsedDates.sourceDate,
        newTime:base.endTime?base.time+'-'+base.endTime:base.time,
        student:item.student,course:base.course||item.course||'',
        teacher:item.teacher,site:item.site,
        note:'來源：開學課表；加時變體中的來源日期標示為請假：'+annotationText,
        source:'開學課表',colorStatus:item.colorStatus
      });
    }

    if(!dates.length||!base||!item.endTime){
      unclassifiedItems.push({...item,note:'[加時課程待確認] 找不到對應固定課程或有效日期清單；未自動套用'});
      continue;
    }
    for(const d of dates){
      const action=item.colorStatus==='yellow'?'延長時間待確認':'延長時間';
      const newEnd=addMinutesToTime(base.endTime,30)||item.endTime;
      adjustments.push({
        id:'',fixedId:base.id||'',weekday:item.weekday,
        originalDate:d,originalTime:base.time,action,newDate:d,
        newTime:base.time+'-'+newEnd,newEndTime:newEnd,
        student:item.student,course:base.course||item.course||'',
        teacher:item.teacher,site:item.site,
        note:'來源：開學課表；指定日期加時30分鐘；原定時段 '+base.time+'-'+base.endTime+'；加時後時段 '+base.time+'-'+newEnd+'；日期清單：'+annotationText,
        source:'開學課表',colorStatus:item.colorStatus
      });
    }
  }

  // Avoid duplicate destination lessons when both the source move and a destination row describe the same class.
  const deduped=[],byTarget=new Map();
  const priority=a=>
    (a.newDate&&a.weekday===weekdayLabel(a.newDate)?100:0)+
    (/\[單次課程\]|\[單次／紫色調課\]|\[紫色調課\]/.test(str(a.note))?30:0)+
    (str(a.course)?20:0)+
    (a.originalDate?10:0)+
    (a.action==='調課'?4:a.action==='改時間'?4:a.action==='代課'?3:a.action==='補課'?1:2);
  const isMoveOrigin=a=>
    a.originalDate&&a.newDate&&a.originalDate!==a.newDate&&
    /調課|移課|改課|代課/.test(norm(a.action));
  for(const adj of mergeExplicitMoveDestinationOverrides(adjustments)){
    if(!adj.newDate||!adj.student){deduped.push(adj);continue;}
    const isCancel=/^(請假|取消|停課)$/.test(adj.action);
    const startTime=parseTimeRange(adj.newTime).start||timeKey(adj.newTime)||str(adj.newTime);
    const key=[
      isCancel?'CANCEL':'TARGET',
      adj.newDate,startTime,
      compact(normalizeStudentNameForContact(adj.student)),
      compact(normalizeSite(adj.site))
    ].join('|');
    const oldIndex=byTarget.get(key);
    if(oldIndex===undefined){byTarget.set(key,deduped.length);deduped.push(adj);continue;}

    const previous=deduped[oldIndex];
    const winner=priority(adj)>priority(previous)?adj:previous;
    const originCandidates=[previous,adj].filter(isMoveOrigin);
    if(originCandidates.length){
      // Preserve the original date/time needed to replace the source lesson, while using
      // the destination cell's time/course/teacher where that row is more authoritative.
      originCandidates.sort((x,y)=>{
        const xIsSourceCell=x.weekday!==weekdayLabel(x.newDate)?1:0;
        const yIsSourceCell=y.weekday!==weekdayLabel(y.newDate)?1:0;
        return yIsSourceCell-xIsSourceCell;
      });
      const origin=originCandidates[0];
      const merged={
        ...winner,
        originalDate:origin.originalDate,
        originalTime:origin.originalTime,
        action:origin.action,
        fixedId:origin.fixedId||winner.fixedId||'',
        note:[str(winner.note),str(origin.note)&&str(origin.note)!==str(winner.note)?'原始調課：'+str(origin.note):''].filter(Boolean).join('；')
      };
      deduped[oldIndex]=merged;
    }else{
      deduped[oldIndex]=winner;
    }
  }
  return {fixed,adjustments:deduped,redItems,unclassifiedItems};
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
  const previewSafe=item=>{
    const {cellText,rowCellTexts,...safe}=item||{};
    return safe;
  };
  return {
    ok:true,mode:'preview-only',sourceSheetId,sourceSheetTitle,
    sourceSpreadsheetId,
    writesPerformed:false,colorRulesApplied:true,year,colorSummary,
    fixedCount:fixed.length,adjustmentCount:adjustments.length,
    redCount:parsed.redItems.length,unclassifiedCount:parsed.unclassifiedItems.length,
    fixed:fixed.slice(0,300).map(previewSafe),
    adjustments:adjustments.slice(0,300).map(previewSafe),
    redItems:parsed.redItems.slice(0,200).map(previewSafe),
    unclassifiedItems:parsed.unclassifiedItems.slice(0,200).map(previewSafe)
  };
}

app.get('/preview-source',async(req,res)=>{
  try{
    const year=Number(req.query.year||new Date().getFullYear());
    res.json(await buildSourcePreview(year));
  }catch(e){
    console.error('Source preview failed',e);
    res.status(500).json({ok:false,mode:'preview-only',writesPerformed:false,error:e.message});
  }
});



app.listen(PORT,()=>console.log(`LINE Course Schedule Manager v1.2 listening on ${PORT}`));
// Safety: do not build or write Google Sheets automatically at startup or on a timer.
// Use the explicit /build endpoint only after reviewing the source preview.
