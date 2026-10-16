# 開學課表字色解析：只讀預覽部署說明

## 目的

本分支 `fix/source-schedule-font-color` 只用於連接來源試算表、讀取字體顏色並產生預覽。請建立獨立的 Render Web Service，不要將此分支切換到既有正式服務。

## Render 設定

建立新的 Web Service，Repository 選擇 `rytn0004-dotcom/line-course-schedule`，Branch 選擇 `fix/source-schedule-font-color`。

- Build Command：`npm install`
- Start Command：`npm start`
- Runtime：Node
- 不要把服務連到正式服務相同的部署設定，避免改動正式環境。

在新服務新增以下環境變數：

| Key | Value |
|---|---|
| `GOOGLE_SHEET_ID` | `1YYv8FvEZQpItprB8cIFnZT9dzqsvpuUqSzsTFsmSUIA` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 沿用原本服務帳戶 JSON；不要貼到聊天或 GitHub |
| `SCHEDULE_PREVIEW_ONLY` | `true` |
| `PREVIEW_SOURCE_SHEET_ID` | `1YYv8FvEZQpItprB8cIFnZT9dzqsvpuUqSzsTFsmSUIA` |
| `PREVIEW_SOURCE_GID` | `1625335145` |
| `PREVIEW_SOURCE_TAB_NAME` | `開學課表`（gid 找不到時才使用的備援） |

程式需要 `GOOGLE_SERVICE_ACCOUNT_JSON` 中既有的 `client_email`。請只複製該服務帳戶的電子郵件到 Google 試算表分享對話框，將來源文件分享給它並設定為「檢視者」。不要把整份 JSON 貼出，也不要給服務帳戶編輯權限。檢視者權限會再多一層防護，確保預覽連線不能寫入來源文件。

## 執行預覽

部署成功後，用瀏覽器開啟：

`https://<這個獨立預覽服務的網址>/preview-source?year=2026`

成功時應看到：

- `mode: "preview-only"`
- `writesPerformed: false`
- `colorRulesApplied: true`
- `sourceSpreadsheetId` 與 `sourceSheetId`
- `colorSummary`（黑字固定、黃字待確認、紫字單次課程、紅字取消、未分類數量）

如遇到無法讀取錯誤，先檢查服務帳戶是否有來源文件的檢視者權限，以及 gid 是否等於 `1625335145`。若顏色未辨識或出現未分類項目，不要合併到 main 或執行正式 build。

## 安全保護

- `SCHEDULE_PREVIEW_ONLY=true` 時，`/build` 會回傳 403 並標記 `writesPerformed:false`。
- build 函式本身也有只讀模式防護。
- 預覽只讀來源格線格式，不執行課表重建、提醒寫入或 LINE 發送。
- 請保持此服務的服務帳戶對來源文件為「檢視者」；不要提升為編輯者。
