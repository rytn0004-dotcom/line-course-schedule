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
function parseDateFlexible(v, fallbackYear=new Date().toLocaleString('en-US',{timeZone:TZ,year:'numeric'})){ if(typeof v==='number')return dateKey(v); const x=str(v),full=dateKey(x); if(/^\d{4}-\d{2}-\d{2}$/.test(full))return full; const m=x.match(/^(\d{1,2})[\/\.\-](\d{1,2})$/); return m?fallbackYear+'-'+String(+m[1]).padStart(2,'0')+'-'+String(+m[2]).padStart(2,'0'):full; }
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
  if(exists)return;
  await retry('create sheet '+title,()=>sheets.spreadsheets.batchUpdate({spreadsheetId:SHEET_ID,requestBody:{requests:[{addSheet:{properties:{title}}}]}}));
}
async function ensureSheetHeaders(title,headers){
  await ensureSheet(title); const end=String.fromCharCode(64+headers.length);
  const r=await retry('read '+title+' headers',()=>sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:qsheet(title)+'!A1:'+end+'5'}));
  if(findHeaderRow(r.data.values||[],headers)>=0)return;
  await retry('write '+title+' headers',()=>sheets.spreadsheets.values.update({spreadsheetId:SHEET_ID,range:qsheet(title)+'!A1:'+end+'1',valueInputOption:'RAW',requestBody:{values:[headers]}}));
}
async function readSheets(){
  return retry('schedule batchGet', async()=>{
    const ranges=[
      `${qsheet('系統設定')}!A:Z`,
      `${qsheet('固定課表')}!A:K`,
      `${qsheet('調課課程')}!A:M`,
      `${qsheet('課程校正')}!A:H`,
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
  const enabledIssues=[];
  const teacherDiagnostics=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const id=str(r[h['固定課表ID']]); if(!id) continue;
    const enabledRaw=str(r[h['啟用']]);
    const enabled=norm(enabledRaw);
    if(enabled!=='是' && enabled!=='否'){
      enabledIssues.push({row:i+1,id,student:str(r[h['學生']]),teacher:str(r[h['老師']]),enabledRaw});
    }
    const teacherRaw=str(r[h['老師']]);
    if(teacherRaw && /陳少禹|少禹/.test(teacherRaw)){
      teacherDiagnostics.push({row:i+1,id,student:str(r[h['學生']]),teacher:teacherRaw,enabled:enabledRaw,weekday:str(r[h['星期']]),rawTime:str(r[h['上課時間']),course:str(r[h['課程']]),site:str(r[h['校區']]),until:str(r[h['有效迄日']])});
    }
    if(enabled!=='是') continue;
    const weekday=norm(r[h['星期']]); const rawTime=str(r[h['上課時間']]); const range=parseTimeRange(rawTime); const time=range.start||timeKey(rawTime);
    if(!weekday||!time) continue;
    out.push({id,weekday,time,endTime:range.end,student:str(r[h['學生']])||extractStudentFromTime(rawTime),course:str(r[h['課程']]),teacher:str(r[h['老師']]),site:str(r[h['校區']]),until:dateKey(r[h['有效迄日']]),template:str(r[h['通知模板']]),note:str(r[h['備註']]),rawTime});
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
function parseAdjust(rows, correctionRows=[]){
  const legacyHr=findHeaderRow(rows,['調課ID','原固定課表ID','原日期','原時間','動作','新日期','新時間','學生','確認']);
  const simpleHr=findHeaderRow(rows,['原日期','原時間','動作','新日期','新時間','學生','新課程','新老師']);
  const out=[];
  if(legacyHr>=0){
    const h=hmap(rows[legacyHr]);
    for(let i=legacyHr+1;i<rows.length;i++){
      const r=rows[i]||[],id=str(r[h['調課ID']]); if(!id)continue;
      if(h['確認']!==undefined&&norm(r[h['確認']])!=='是')continue;
      out.push({id,fixedId:str(r[h['原固定課表ID']]),originalDate:parseDateFlexible(r[h['原日期']]),originalTime:parseTimeRange(r[h['原時間']]).start||timeKey(r[h['原時間']]),action:str(r[h['動作']]),newDate:parseDateFlexible(r[h['新日期']]),newTime:parseTimeRange(r[h['新時間']]).start||timeKey(r[h['新時間']]),student:str(r[h['學生']]),course:str(r[h['新課程']]),teacher:str(r[h['新老師']]),site:str(r[h['新校區']]),note:str(r[h['備註']]),source:'調課課程'});
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
      out.push({id:'',fixedId:'',originalDate:d,originalTime:t,action,newDate:parseDateFlexible(r[h['新日期']]),newTime:parseTimeRange(r[h['新時間']]).start||timeKey(r[h['新時間']]),student,course:str(r[h['新課程']]),teacher:str(r[h['新老師']]),site:'',note:'',source:'調課課程'});
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
          newTime:parseTimeRange(r[h['新時間']]).start||timeKey(r[h['新時間']]),
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
          const timeMoveRe=/(\\d{1,2}:?\\d{2})\\s*[-~～至]\\s*(\\d{1,2}:?\\d{2})\\s*([^()（）]+?)\\s*[（(]\\s*(\\d{4}[-\\/.]\\d{1,2}[-\\/.]\\d{1,2}|\\d{1,2}[-\\/.]\\d{1,2})\\s+(\\d{1,2}:?\\d{2})\\s*[-~～至]\\s*(\\d{1,2}:?\\d{2})\\s*[）)]/;
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
      if(f.until&&/^\d{4}-\d{2}-\d{2}$/.test(f.until)&&d>f.until)continue;
      if(norm(f.weekday)!==norm(wd))continue;

      const base={date:d,weekday:wd,time:f.time,student:f.student,course:f.course,teacher:f.teacher,site:f.site,source:'固定課表',fixedId:f.id,adjustId:'',adjustResult:'無',note:f.note||'',template:f.template||''};
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
          if(action==='取消'||action==='停課'||/請假/.test(action)){
            out.push({...base,source:a.source||'調課課程',adjustId:a.id||f.id+'-'+d,adjustResult:'取消',note:a.note||'取消'});
            handled=true;
            break;
          }
          if(/改時間|改課|調課|移課/.test(action)){
            const nd=a.newDate||d,nt=a.newTime||f.time;
            out.push({
              ...base,date:nd,weekday:weekdayLabel(nd),time:nt,
              student:a.student||f.student,course:a.course||f.course,teacher:a.teacher||f.teacher,
              site:a.site||f.site,source:a.source||'調課課程',fixedId:f.id,
              adjustId:a.id||f.id+'-'+d,adjustResult:'已調課',note:a.note||''
            });
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
            ...base,date:nd,weekday:weekdayLabel(nd),time:a.newTime||f.time,
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

  // 「新增／補課／體驗」仍沿用原本的新增課程機制。
  for(const a of adjusts){
    if(!a.newDate||a.originalDate||/取消|停課/.test(a.action))continue;
    if(a.newDate<fromDate||a.newDate>toDate)continue;
    const fb=fixed.find(x=>x.id===a.fixedId),isAdd=/新增|補課|體驗/.test(a.action)||!a.fixedId;
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
    const key=item.role==='老師'
      ? [item.role,compact(item.recipient),item.date,compact(item.teacher),compact(item.site)].join('|')
      : [item.role,compact(item.recipient),item.date,item.time,compact(item.teacher),compact(item.site)].join('|');
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(item);
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
        const time=timeKey(item.time) || str(item.time);
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
    const slot=previousReminderSlot(c.date,settings);
    if(!slot.sendDate || !slot.sendTime) continue;
    const dateLabel=c.date.replaceAll('-','/');

    if(settings.parentNotify==='是'){
      // 團班可能同時包含多位學生；家長匹配必須逐一拆開學生姓名，
      // 否則「葉依柔、陳翊森」會被當成單一姓名，導致兩位學生的家長都收不到通知。
      const studentMembers = normalizeMemberList(c.student);
      const parentStudents = studentMembers.length ? studentMembers : [c.student];
      for(const studentMember of parentStudents){
        for(const person of contacts.filter(x=>x.role==='家長' && includesStudent(x.related,studentMember))){
        const preferred = fixedTemplateById.get(c.fixedId) || '';
        const template=chooseTemplate(templates,'家長',preferred);
        raw.push({
          id:'',
          courseId:c.courseId,
          date:c.date,
          time:c.time,
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
          time:c.time,
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
        時間:x.time,
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
  const expected=makeReminderRows(actualObjects(actualRows),contacts,templates,settings,fixedTemplateById);
  const expectedKeys=new Set(expected.map(x=>x.id+'|'+x.role+'|'+x.recipient));
  const expectedLogicalKeys=new Set(expected.map(x=>{
    if(x.role==='老師'){
      return [x.role,compact(x.recipient),x.date,compact(x.teacher),compact(x.site)].join('|');
    }
    return [x.role,compact(x.recipient),x.date,x.time,compact(x.teacher),compact(x.site)].join('|');
  }));
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
    const isGenerated = /-(?:P|T)$/.test(old.id) || old.id.startsWith('MERGED-');
    const inWindow = old.date && old.date>=fromDate && old.date<=addDays(fromDate,days-1);
    const oldLogicalKey=old.role==='老師'
      ? [old.role,compact(old.recipient),old.date,compact(String(old.values[h['老師']]||'')),compact(String(old.values[h['校區']]||''))].join('|')
      : [old.role,compact(old.recipient),old.date,old.time,compact(String(old.values[h['老師']]||'')),compact(String(old.values[h['校區']]||''))].join('|');
    const replacedByMerged = expectedLogicalKeys.has(oldLogicalKey) && !expectedKeys.has(old.id+'|'+old.role+'|'+old.recipient);
    if((!isGenerated && !replacedByMerged) || !inWindow) continue;
    const row=old.values.slice(); while(row.length<width) row.push('');
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
  return {expectedCount:expected.length,created,updated,disabled,reminderServiceEnabled:settings.enabled==='是',lineSending:false};
}

async function build({fromDate=todayKey(),days=DEFAULT_DAYS}={}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error('fromDate 必須是 YYYY-MM-DD');
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
  await writeActual(actual);
  const reminder=AUTO_CREATE_REMINDERS
    ? await syncReminders(actual,reminderRows,contacts,templates,settings,fromDate,days,fixedTemplateByIdInput)
    : {expectedCount:0,created:0,updated:0,disabled:0,reminderServiceEnabled:settings.enabled==='是',autoCreateReminders:false,lineSending:false};
  return {ok:true,fromDate,toDate:addDays(fromDate,days-1),fixedCount:fixed.length,adjustCount:adjusts.length,actualCount:actual.length,reminder};
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

app.listen(PORT,()=>console.log(`LINE Course Schedule Manager v1.2 listening on ${PORT}`));
// Light automatic refresh: rebuild once at startup, then every 6 hours. No LINE sending.
(async()=>{
  try { lastBuild=await buildOnce({fromDate:todayKey(),days:DEFAULT_DAYS}); lastBuild.at=new Date().toISOString(); console.log('Initial schedule build complete',lastBuild); }
  catch(e){ lastBuild={status:'error',error:e.message,at:new Date().toISOString()}; console.error('Initial schedule build failed',e); }
  setInterval(async()=>{
    try { lastBuild=await buildOnce({fromDate:todayKey(),days:DEFAULT_DAYS}); lastBuild.at=new Date().toISOString(); console.log('Scheduled schedule rebuild complete',lastBuild); }
    catch(e){ lastBuild={status:'error',error:e.message,at:new Date().toISOString()}; console.error('Scheduled schedule rebuild failed',e); }
  }, 6*60*60*1000).unref?.();
})();
