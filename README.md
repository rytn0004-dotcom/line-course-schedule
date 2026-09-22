# LINE Course Schedule Manager v1.2.0

用途：固定課表 + 調課課程 → 實際課程 → 自動建立「課程提醒」佇列。此服務不發 LINE。

## v1.2.0 新增
- 支援沒有原固定課表 ID 的「新增／補課／體驗課」調課。
- `/build` 產生「實際課程」後，同步建立／更新「課程提醒」工作表資料。
- 家長／老師依「聯絡人」中的「學生姓名/關聯」與「通知啟用」自動配對。
- 發送日期／時間依「系統設定」中的各星期發送時間自動計算；週日不發時會提前到週六時段。
- 訊息內容依「固定課表」的「通知模板」自動套用，找不到指定模板時使用預設「家長一般／老師通知」。
- 「發送前需確認=是」時，新產生的提醒預設為「確認發送=否」，避免課表更新直接觸發 LINE。
- 已存在的提醒會更新課程與排程資料；人工修改過的「訊息內容」與「確認發送」會保留。
- 已不再存在、且位於本次 build 範圍內的自動產生提醒會設為「確認發送=否」，避免停課／調課後誤發。
- 若 Google Sheet 沒有「課程提醒」工作表，會自動建立並建立標題列。

## 模組分工
- `line-course-schedule-manager`：固定課表 → 調課 → 實際課程 → 課程提醒佇列。
- `line-course-reminder`：讀取「課程提醒」→ 到指定時間 → 發送 LINE。
- 本服務本身不呼叫 LINE Messaging API。

## Render
Build Command: `npm install`
Start Command: `node server.js`
Health Check Path: `/health`

## Environment Variables
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `TIMEZONE=Asia/Taipei`
- `GOOGLE_API_MAX_RETRIES=4`
- `SCHEDULE_BUILD_DAYS=30`
- `SCHEDULE_AUTO_CREATE_REMINDERS=是`（預設啟用；設定為 `否` 可暫停自動建立提醒）

## 手動重建
`GET /build?from=2026-09-16&days=1`

## 產生提醒的資料來源
- `系統設定`：家長通知、老師通知、發送前需確認、各星期發送時間。
- `固定課表`：學生、課程、老師、校區、通知模板。
- `調課課程`：只使用「確認=是」的資料。
- `聯絡人`：通知啟用=是的家長／老師。
- `訊息模板`：家長一般、老師通知等模板。
- `實際課程`：本服務產生的正式課程資料。

## 注意
目前「課程提醒」工作表沿用既有 13 欄格式：`提醒ID、課程日期、上課時間、發送日期、發送時間、身分、收件人、學生/學生成員、課程、老師、校區、訊息內容、確認發送`。
