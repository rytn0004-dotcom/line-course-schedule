# 課表管理模組（獨立版）

用途：只負責「固定課表 + 調課課程 → 實際課程」的產生，不發送 LINE。

Google Sheet 工作表：
- 固定課表
- 調課課程
- 實際課程

執行：
`npm run build:schedule -- 2026-09-14`

未提供日期時會依 TIMEZONE 產生當天實際課表。

Render：使用 render.yaml 建立獨立 Cron；目前排程為台灣時間每日 00:05（Render 使用 UTC，因此設定 16:05 UTC）。
