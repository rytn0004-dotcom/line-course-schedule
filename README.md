# LINE Course Schedule Manager v1.2.1

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

## /build

GET /build?from=2026-09-16&days=1

此 API 只整理／寫入課程資料與提醒佇列，**不發 LINE**。

## 「課程提醒」欄位

提醒ID、課程日期、上課時間、發送日期、發送時間、身分、收件人、學生/學生成員、課程、老師、校區、訊息內容、確認發送
