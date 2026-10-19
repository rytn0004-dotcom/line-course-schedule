# LINE Course Schedule Manager v1.2.1

> **唯一正式課表建置邏輯：** 本服務由 `server.js` 提供，Render 使用 `node server.js` 啟動，透過 `/build` 更新實際課程與提醒佇列。舊版獨立腳本 `schedule_builder.js` 已移除，因其欄位結構、確認狀態與調課判斷和現行服務不一致；請勿另行執行舊版建置邏輯。

用途：整理課程資料，將「固定課表 + 調課課程」整理成「實際課程」，並依既定規則準備「課程提醒」佇列寫入 Google Sheet。

## 與 lineme-service 的明確分工

### 本服務：line-course-schedule
只負責**課程資訊整理與提醒佇列準備**：
- 讀取固定課表、調課課程、聯絡人、訊息模板與系統設定。
- 產生「實際課程」。
- 產生／更新「課程提醒」資料，包含提醒ID、日期、時間、收件人、學生成員、訊息內容、確認發送。
- 同一位收件人、同一天、同時間、同老師、同校區的學生可合併成一筆 MERGED-... 提醒。
- **本服務不呼叫 LINE Messaging API，也不發送 LINE。**

### 發送服務：lineme-service
只負責**讀取 Google Sheet 的提醒並發送 LINE**：
- 讀取「課程提醒」。
- 依「確認發送」與發送日期／時間判斷是否到發送時間。
- 解析 MERGED-... 提醒並配對 LINE User ID。
- 執行 LINE Push。
- 寫入「發送紀錄」避免重複發送。
- **不負責固定課表、調課、實際課程或課表建構。**

## 核心資料流

固定課表 + 調課課程
        ↓
line-course-schedule
        ↓
實際課程
        ↓
課程提醒
        ↓
Google Sheet
        ↓
lineme-service
        ↓
LINE Push

## 管理端 API 安全設定

`/build` 會寫入「實際課程」與「課程提醒」；`/preview-source` 會回傳學生、老師及課表內容。兩個端點都要求設定環境變數 `SCHEDULE_ADMIN_TOKEN` 並通過驗證。

在 Render 的 **Environment** 新增 `SCHEDULE_ADMIN_TOKEN`，設定一組長且不重複的隨機字串。呼叫 API 時優先使用 `x-admin-token` HTTP 標頭。僅供瀏覽器手動測試的 `?token=` 查詢參數可能留在瀏覽器歷史與伺服器紀錄，不要分享含 token 的網址。未設定 token 時，管理端點會回傳 503；驗證失敗回傳 401。公開的 `/health` 不需要 token。

正式環境請勿直接用 `/build` 做測試；先用獨立 Render 測試服務，並讓測試服務連到試算表副本。

## /build

GET /build?from=2026-09-16&days=1

此 API 只整理／寫入課程資料與提醒佇列，**不發 LINE**。

## 「課程提醒」欄位

提醒ID、課程日期、上課時間、發送日期、發送時間、身分、收件人、學生/學生成員、課程、老師、校區、訊息內容、確認發送
