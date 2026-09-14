require('dotenv').config();
const { google } = require('googleapis');
for(const key of ['GOOGLE_SHEET_ID','GOOGLE_SERVICE_ACCOUNT_JSON']) if(!process.env[key]) throw new Error(`Missing ${key}`);
const SHEET_ID=process.env.GOOGLE_SHEET_ID;
const auth=new google.auth.GoogleAuth({credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),scopes:['https://www.googleapis.com/auth/spreadsheets']});
const sheets=google.sheets({version:'v4',auth});
function esc(n){return `'${String(n).replace(/'/g,"''")}'`;}
function norm(v){return String(v??'').trim().replace(/\s+/g,'');}
function uniq(a){return [...new Set(a)];}
function hmap(h){return Object.fromEntries((h||[]).map((x,i)=>[String(x),i]));}
function wd(date){return ['日','一','二','三','四','五','六'][new Date(`${date}T00:00:00Z`).getUTCDay()];}
async function vals(sheet,range){const r=await sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:`${esc(sheet)}!${range}`});return r.data.values||[];}
async function appendRows(sheet,rows){if(!rows.length)return;sheets.spreadsheets.values.append({spreadsheetId:SHEET_ID,range:`${esc(sheet)}!A:Z`,valueInputOption:'USER_ENTERED',insertDataOption:'INSERT_ROWS',requestBody:{values:rows}});}
function taipeiToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:process.env.TIMEZONE||'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function dateArg(){const d=process.argv[2]||process.env.TARGET_DATE||taipeiToday();if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d))throw new Error('Usage: npm run build:schedule -- 2026-09-14');return d;}
async function main(){const target=dateArg();const [f,a,r]=await Promise.all([vals('固定課表','A:I'),vals('調課課程','A:M'),vals('實際課程','A:M')]);const fh=hmap(f[0]||[]),ah=hmap(a[0]||[]),rh=hmap(r[1]&&r[1][0]==='Course ID'?r[1]:r[0]||[]);const existing=new Set();const start=r[0]&&r[0][0]==='Course ID'?1:2;for(let i=start;i<r.length;i++){const id=String(r[i]?.[rh['Course ID']]||'');if(id)existing.add(id);}
const adjs=[];for(let i=1;i<a.length;i++){const x=a[i]||[];if(norm(x[ah['確認']])!=='已確認')continue;adjs.push({id:x[ah['調課ID']]||'',fixedId:x[ah['原固定課表ID']]||'',oldDate:x[ah['原日期']]||'',oldTime:x[ah['原時間']]||'',action:x[ah['動作']]||'',newDate:x[ah['新日期']]||'',newTime:x[ah['新時間']]||'',student:x[ah['學生']]||'',course:x[ah['新課程']]||'',teacher:x[ah['新老師']]||'',venue:x[ah['新校區']]||''});}
const out=[];const day=wd(target);for(let i=1;i<f.length;i++){const x=f[i]||[];if(norm(x[fh['啟用']])!=='是'||norm(x[fh['星期']])!==day)continue;const end=String(x[fh['有效迄日']]||'');if(end&&target>end)continue;const hit=adjs.filter(a=>a.fixedId===x[fh['固定課表ID']]&&a.oldDate===target&&(!a.oldTime||a.oldTime===x[fh['上課時間']]));if(hit.some(a=>['停課','改課'].includes(a.action)))continue;out.push([`${x[fh['固定課表ID']]}-${target}`,target,day,x[fh['上課時間']]||'',x[fh['學生']]||'',x[fh['課程']]||'',x[fh['老師']]||'',x[fh['校區']]||'','固定課表',x[fh['固定課表ID']]||'','','無','']);}
for(const a of adjs){if(!['改課','加課'].includes(a.action)||a.newDate!==target)continue;out.push([`${a.fixedId||a.id}-${target}`,target,day,a.newTime||'',a.student||'',a.course||'',a.teacher||'',a.venue||'','調課',a.fixedId||'',a.id,a.action,`由 ${a.id} 產生`]);}
const newRows=out.filter(x=>!existing.has(x[0]));if(newRows.length)await appendRows('實際課程',newRows);console.log(`Schedule Builder complete: target=${target}, created=${newRows.length}`);}
main().catch(e=>{console.error(e);process.exit(1);});
