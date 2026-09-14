# LINE Course Schedule Manager v1.1

獨立課表管理 Web Service：只處理「固定課表 + 調課課程 -> 實際課程」，不發送 LINE。

## Render
- Build Command: `npm install`
- Start Command: `node server.js`
- Health Check Path: `/health`

## Environment Variables
- GOOGLE_SHEET_ID
- GOOGLE_SERVICE_ACCOUNT_JSON
- TIMEZONE=Asia/Taipei
- GOOGLE_API_MAX_RETRIES=4
- SCHEDULE_BUILD_DAYS=30

## Endpoints
- `GET /health`
- `GET /build`
- `GET /build?from=2026-09-14&days=30`
