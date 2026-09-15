# LINE Course Schedule Manager v1.2

用途：固定課表 + 調課課程 → 實際課程。此服務不發 LINE。

## v1.2 新增
- 支援沒有原固定課表 ID 的「新增／補課／體驗課」調課。
- 明天的體驗課、提前補課可直接放在「調課課程」中，由系統產生「實際課程」。
- 保留日期、時間、學生排序與手動 `/build`。

## Render
Build Command: `npm install`
Start Command: `node server.js`
Health Check Path: `/health`

## Environment Variables
- GOOGLE_SHEET_ID
- GOOGLE_SERVICE_ACCOUNT_JSON
- TIMEZONE=Asia/Taipei
- GOOGLE_API_MAX_RETRIES=4
- SCHEDULE_BUILD_DAYS=30

## 手動重建
`GET /build?from=2026-09-16&days=1`
