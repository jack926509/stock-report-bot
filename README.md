# Stock Report Bot

美股日報 + AI 科技新聞整合機器人 — Yahoo Finance / Finnhub / GPT-4o / Telegram

## 功能概覽

| 報告 | 排程 | 說明 |
|------|------|------|
| **美股日報** | 週一至週五 07:30 (Asia/Taipei) | 三大指數 + 七巨頭 + 8 大產業個股 + 技術指標 + GPT-4o 分析 |
| **AI 科技新聞** | 每天 07:35 | 4 大 RSS 來源 + GPT-4o-mini 摘要評分 |
| **美股新聞快訊** | 週一至週五 07:40 | Finnhub / Yahoo 個股新聞 + 重要性篩選 |

### Telegram 指令

| 指令 | 功能 |
|------|------|
| `/ping` | 確認 Bot 存活狀態 |
| `/stock` | 手動觸發美股日報 |
| `/news` | 手動觸發 AI 科技新聞 |
| `/flash` | 手動觸發美股新聞快訊 |

## 技術架構

```
                    ┌─────────────┐
                    │  node-cron  │  排程觸發
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   ┌───────────┐   ┌───────────┐   ┌───────────┐
   │ 美股日報  │   │ AI 新聞   │   │ 新聞快訊  │
   └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
         │               │               │
    ┌────┴────┐     ┌────┴────┐     ┌────┴────┐
    │Yahoo    │     │RSS      │     │Finnhub  │
    │Finance  │     │Parser   │     │+ Yahoo  │
    │+ Finnhub│     └────┬────┘     └────┬────┘
    └────┬────┘          │               │
         │          ┌────┴────┐     ┌────┴────┐
    ┌────┴────┐     │GPT-4o   │     │GPT-4o   │
    │GPT-4o   │     │-mini    │     │-mini    │
    └────┬────┘     └────┬────┘     └────┬────┘
         │               │               │
         └───────────────┬┘───────────────┘
                         ▼
                  ┌─────────────┐
                  │  Telegram   │
                  │  Bot API    │
                  └─────────────┘
```

### 資料來源

- **Yahoo Finance** — 即時股價、技術指標歷史數據
- **Finnhub** — 備援報價、市場新聞、個股新聞
- **RSS** — OpenAI Blog、MIT Tech Review、The Verge AI、TechCrunch AI
- **OpenAI GPT-4o / GPT-4o-mini** — 報告撰寫、新聞分析評分

### 監控的股票池（~90 支）

- **三大指數**：S&P 500、道瓊、那斯達克、VIX
- **七巨頭 (MAG7)**：AAPL、MSFT、GOOGL、AMZN、NVDA、META、TSLA
- **8 大產業**：記憶體/半導體、AI/雲端、低軌道衛星/太空、能源/油氣、新能源/電動車、金融/銀行、生技/醫療、消費/零售

## 環境變數

| 變數 | 必要 | 說明 |
|------|------|------|
| `OPENAI_API_KEY` | **必要** | OpenAI API 金鑰 |
| `TELEGRAM_BOT_TOKEN` | **必要** | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | **必要** | 目標 Telegram 聊天室 ID |
| `FINNHUB_API_KEY` | 選用 | Finnhub API 金鑰（備援報價 + 新聞功能） |
| `PORT` | 選用 | HTTP 健康檢查 port（預設 3000） |
| `RUN_NOW` | 選用 | 設為 `true` 啟動後立即執行報告 |
| `RUN_NOW_TARGET` | 選用 | 搭配 `RUN_NOW`，可選 `stock` / `news` / `flash` |

## 部署方式（Zeabur）

1. 在 Zeabur 建立新專案，連結 GitHub repo
2. 設定環境變數（見上表）
3. Zeabur 會自動偵測 Node.js 專案並部署
4. 內建 HTTP 健康檢查 server 可供 Zeabur keepalive 使用

### 本機開發

```bash
# 安裝依賴
npm install

# 設定環境變數
cp .env.example .env  # 填入你的 API keys

# 啟動
npm start

# 測試模式（立即執行報告）
RUN_NOW=true RUN_NOW_TARGET=stock node index.js
```

## 修改歷程（Changelog）

### v5.2.0（2026-03-12）

**效能優化**
- **OpenAI client 單例化**：移除每次呼叫重新建立 OpenAI 實例的浪費，改為全域單例
- **Finnhub HTTP 請求去重**：提取共用 `finnhubGet()` 工具函式，消除 3 處重複的 HTTP 請求樣板程式碼
- **批次並行抓取**：`collectFlashNews` 和 `fetchKeyStockNews` 從逐一串行改為每批 5 支並行，新聞快訊抓取時間從 ~22 秒降至 ~5 秒
- **日期格式化去重**：提取共用 `fmtDateHeader()` 函式，消除 4 處重複的日期格式化邏輯

**可靠性提升**
- **Telegram 發送重試**：加入指數退避重試機制（最多 3 次，間隔 2s/4s/6s），避免因偶發網路錯誤導致報告發送失敗
- **完善美股休市日**：從只有 3 個固定假日擴充為完整的美股休市日計算，包含 MLK Day、總統日、耶穌受難日、陣亡將士紀念日、六月節、勞動節、感恩節，並處理假日遇週末的順延邏輯
- **報告執行鎖**：加入 `runningLocks` 機制，防止 cron 排程與手動指令同時觸發同一報告
- **Graceful shutdown**：新增 SIGTERM/SIGINT 信號處理，Zeabur 重新部署時會等待進行中的報告完成後再退出（最多等 60 秒）

**程式碼品質**
- **版本號統一**：統一 `package.json`、健康檢查 API、Telegram 訊息、`/ping` 回覆的版本號為 v5.2

**UX/UI 設計優化**
- **統一視覺語言**：所有報告改用 `━` 分隔線、`<code>` 標籤突出關鍵數字（價格、漲跌幅、股票代碼）
- **美股日報 Header**：新增三大指數 + VIX 快速摘要行，一眼掌握大盤方向
- **GPT prompt 排版指引**：新增完整排版規範（數字格式、段落長度、留白規則），提升 AI 輸出一致性
- **AI 新聞摘要**：新增文章統計摘要（必讀/重要計數），用 🔺/▸/· 區分三級重要性
- **新聞快訊**：Footer 顯示新聞總數和發布時間
- **系統訊息**：`/ping` 加入 uptime 和結構化表格；啟動訊息改為排程表格式
- **錯誤訊息**：統一 `❌` 前綴 + `<code>` 包裹錯誤內容，提升可讀性
- **分段頁碼**：改為簡潔的 `━ 1/3 ━ 續下則 ▸` 樣式

### v5.0.0

- 移除 Notion 整合（簡化依賴）
- 加入 uncaughtException / unhandledRejection 全局防護
- 看門狗心跳 log（每分鐘，方便 Zeabur 監控）
- `/ping` `/stock` `/news` 指令（隨時確認存活 + 手動觸發）
- HTTP 健康檢查 server（供 Zeabur keepalive）
- Telegram 訊息超長自動切分（4096 字元限制）
- 整合進單一進程，不再需要 n8n
- 新增美股新聞快訊（07:40）和 `/flash` 指令

## 未來可優化項目（Roadmap）

### 高優先

- [ ] **模組化拆分**：將 1300+ 行的 `index.js` 拆分為獨立模組（config、fetchers、reports、services、utils），提高可維護性和可測試性
- [ ] **使用 Node.js 內建 `fetch`**：替換原生 `https` 模組（Telegram / Finnhub 的 HTTP 請求），大幅簡化程式碼
- [ ] **GPT prompt 模板化**：將硬編碼的 prompt 提取為外部 JSON/模板檔案，方便調整報告格式而不需改動程式碼
- [ ] **加入單元測試**：為技術指標計算、假日判斷、格式化函式等純函式撰寫測試

### 中優先

- [ ] **產業個股並行抓取**：目前 8 大產業仍逐一產業 `await`，可改為 2~3 組並行以加速 `fetchAllMarketData`
- [ ] **快取機制**：對 Finnhub 新聞加入短期快取（例如 10 分鐘），避免手動觸發時重複請求
- [ ] **報告歷史記錄**：將每次報告存入本地 JSON/SQLite，方便回溯和比對
- [ ] **自訂股票池**：支援透過 Telegram 指令或環境變數動態增減監控的股票

### 低優先

- [ ] **TypeScript 遷移**：提供型別安全，減少執行期錯誤
- [ ] **多語言支援**：報告內容支援英文/簡中切換
- [ ] **Docker 化**：提供 Dockerfile 方便本地開發和多平台部署
- [ ] **Web Dashboard**：簡易的 Web 介面查看報告歷史和 Bot 狀態
- [ ] **Webhook 模式**：替換 Telegram polling 為 webhook，減少資源消耗

## License

MIT
