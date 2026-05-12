# Stock Report Bot

美股日報 + 新聞快訊機器人 — Yahoo Finance / Finnhub / GPT-4o / Telegram 或 Discord

> 訊息平台可二選一：**Telegram** 或 **Discord**。報告內容、排程、指令都相同，只差在「發到哪裡」。

## 功能概覽

| 報告 | 排程 | 說明 |
|------|------|------|
| **美股日報** | 週一至週五 07:30 (Asia/Taipei) | 三大指數 + 七巨頭 + 8 大產業 + 技術指標 + 市場廣度 + GPT-4o 分析 |
| **美股新聞快訊** | 週一至週五 07:35 | 指數快照 + Finnhub/Yahoo 新聞 + GPT-4o-mini 重要性篩選 |

### 指令

| Telegram | Discord | 功能 |
|----------|---------|------|
| `/ping`  | `/ping`（或 `!ping`）  | 系統狀態（版本、平台、記憶體、運行時間） |
| `/stock` | `/stock`（或 `!stock`） | 手動觸發美股日報 |
| `/flash` | `/flash`（或 `!flash`） | 手動觸發美股新聞快訊 |

> Telegram 用 `/` 前綴（Bot polling）。Discord 啟動時會自動註冊原生斜線指令 `/ping` `/stock` `/flash`；另外預設也支援 `!` 前綴訊息指令（需 MESSAGE CONTENT INTENT，可用 `DISCORD_ENABLE_PREFIX_COMMANDS=false` 關閉）。指令只在設定的聊天室／頻道內生效。

## 技術架構

```
                    ┌─────────────┐
                    │  node-cron  │  排程觸發
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        ┌───────────┐           ┌───────────┐
        │ 美股日報  │           │ 新聞快訊  │
        └─────┬─────┘           └─────┬─────┘
              │                       │
     ┌────────┼────────┐        ┌─────┴─────┐
     ▼        ▼        ▼        ▼           ▼
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  ┌──────┐
  │Yahoo │ │Finn  │ │技術  │ │Finn  │  │Yahoo │
  │Fin.  │ │hub   │ │指標  │ │hub   │  │Fin.  │
  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘  └──┬───┘
     │        │        │        │          │
     │   ┌────┴────┐   │   ┌────┴──────────┘
     │   │市場廣度 │   │   │
     │   │產業排行 │   │   │
     │   └────┬────┘   │   │
     └────────┼────────┘   │
              ▼            ▼
         ┌────────┐   ┌────────┐
         │ GPT-4o │   │GPT-4o  │
         │        │   │ -mini  │
         └───┬────┘   └───┬────┘
             └──────┬──────┘
                    ▼
             ┌─────────────┐
             │  Telegram   │
             │     或      │
             │   Discord   │
             └─────────────┘
```

### 資料來源

- **Yahoo Finance** — 即時股價、技術指標歷史數據
- **Finnhub** — 備援報價、市場新聞、個股新聞
- **OpenAI GPT-4o** — 美股日報撰寫（含廣度分析引用）
- **OpenAI GPT-4o-mini** — 新聞快訊評分篩選

### 監控的股票池（~90 支）

- **三大指數**：S&P 500、道瓊、那斯達克、VIX
- **七巨頭 (MAG7)**：AAPL、MSFT、GOOGL、AMZN、NVDA、META、TSLA
- **8 大產業**：記憶體/半導體、AI/雲端、低軌道衛星/太空、能源/油氣、新能源/電動車、金融/銀行、生技/醫療、消費/零售

### 數據摘要能力

美股日報會自動計算以下摘要指標（程式端計算，非 GPT 生成）：

| 指標 | 說明 |
|------|------|
| **漲跌比** | 上漲/下跌/持平家數 + 漲跌比率 |
| **池均漲跌幅** | 全池 ~90 支個股的平均漲跌幅 |
| **大幅異動** | 漲 ≥3% 和跌 ≤-3% 的個股數量 |
| **RSI 超買超賣** | RSI ≥70 和 ≤30 的個股數量 |
| **量能異常** | 成交量 ≥ 均量 2 倍的個股清單 |
| **產業強弱排行** | 8 大產業依平均漲跌幅排序 + 上漲比例 |
| **漲跌幅 TOP5** | 全池漲幅/跌幅前五名（含技術指標） |
| **財報預告** | 本週即將公布財報的池內個股 |

這些數據同時餵給 GPT-4o，要求其結合廣度分析判斷市場真實強弱（如偵測指數與個股的背離）。

## 環境變數

| 變數 | 必要 | 說明 |
|------|------|------|
| `OPENAI_API_KEY` | **必要** | OpenAI API 金鑰 |
| `MESSAGING_PLATFORM` | 選用 | `telegram`（預設）或 `discord`。未設定時，若有 `DISCORD_BOT_TOKEN` 會自動切換成 `discord` |
| `TELEGRAM_BOT_TOKEN` | Telegram 模式必要 | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram 模式必要 | 目標 Telegram 聊天室 ID |
| `DISCORD_BOT_TOKEN` | Discord 模式必要 | Discord Bot Token |
| `DISCORD_CHANNEL_ID` | Discord 模式必要 | 目標 Discord 文字頻道 ID |
| `DISCORD_GUILD_ID` | 選用（建議） | 伺服器 ID。設定後斜線指令會「即時」註冊到該伺服器；不設定則註冊為全域指令（最多約 1 小時才生效） |
| `DISCORD_ENABLE_PREFIX_COMMANDS` | 選用 | 預設 `true`。是否啟用 `!ping` / `!stock` / `!flash` 前綴指令（需開 MESSAGE CONTENT INTENT）。只用斜線指令的話設 `false`，就不必開那個 privileged intent |
| `FINNHUB_API_KEY` | 選用 | Finnhub API 金鑰（備援報價 + 新聞快訊功能） |
| `PERPLEXITY_API_KEY` | 選用 | Perplexity Sonar 金鑰（日報的宏觀即時資訊 + 異動股催化劑） |
| `DISABLE_PERPLEXITY` | 選用 | 設為 `true` 可在有金鑰時仍關閉 Perplexity |
| `FMP_API_KEY` | 選用 | Financial Modeling Prep 金鑰（AI 投資人 Agent：基本面 / Buffett / Graham） |
| `DISABLE_AGENTS` | 選用 | 設為 `true` 可在有金鑰時仍關閉投資人 Agent |
| `PORT` | 選用 | HTTP 健康檢查 port（預設 3000） |
| `RUN_NOW` | 選用 | 設為 `true` 啟動後立即執行報告 |
| `RUN_NOW_TARGET` | 選用 | 搭配 `RUN_NOW`，可選 `stock` / `flash` |

> 訊息平台只需設定其中一組（Telegram **或** Discord）。兩組都設定時，由 `MESSAGING_PLATFORM` 決定用哪一個。完整範本見 [`.env.example`](.env.example)。
>
> 最小可跑設定：
> - Telegram：`OPENAI_API_KEY` + `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
> - Discord：`OPENAI_API_KEY` + `MESSAGING_PLATFORM=discord` + `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`（建議再加 `DISCORD_GUILD_ID`）

## Discord 設定教學

### 1. 建立 Discord 應用程式與 Bot

1. 前往 <https://discord.com/developers/applications> → 右上角 **New Application**，取個名字（例如 `Stock Report Bot`）。
2. 左側選單進入 **Bot** 分頁 → **Add Bot** → 確認。
3. 在 **Bot** 分頁點 **Reset Token** → 複製產生的 Token，這就是 `DISCORD_BOT_TOKEN`（只會顯示一次，請妥善保存）。
4. 往下找到 **Privileged Gateway Intents**：
   - 如果要用 `!ping` 這類**前綴指令** → **開啟 `MESSAGE CONTENT INTENT`**。
   - 如果**只用斜線指令**（`/ping` 等）→ 不必開；並把環境變數 `DISCORD_ENABLE_PREFIX_COMMANDS=false`（沒關掉的話程式會嘗試用前綴指令，未開 intent 會在啟動時報錯）。
   - `SERVER MEMBERS INTENT` / `PRESENCE INTENT` 都不需要。
5. （可選）在 **Bot** 分頁把 `PUBLIC BOT` 關掉，避免別人把你的 Bot 加進其他伺服器。

### 2. 把 Bot 邀請進你的伺服器

1. 左側選單進入 **OAuth2 → URL Generator**。
2. **Scopes** 勾選 `bot` **和** `applications.commands`（後者是斜線指令必需）。
3. 下方 **Bot Permissions** 勾選：`View Channels`、`Send Messages`、`Embed Links`、`Read Message History`。
4. 複製最下方產生的網址，在瀏覽器打開，選擇你的伺服器並授權。

### 3. 取得頻道 ID（`DISCORD_CHANNEL_ID`）與伺服器 ID（`DISCORD_GUILD_ID`）

1. Discord App → **設定 → 進階 → 開發者模式** 打開。
2. 在你要接收報告的文字頻道上按右鍵 → **複製頻道 ID** → 這是 `DISCORD_CHANNEL_ID`。
3. 在伺服器名稱（左上角）按右鍵 → **複製伺服器 ID** → 這是 `DISCORD_GUILD_ID`（選用，但強烈建議設定，斜線指令才會即時生效）。
4. 確認該頻道允許 Bot 發言（頻道權限或角色權限）。

### 4. 設定環境變數並啟動

```bash
MESSAGING_PLATFORM=discord
DISCORD_BOT_TOKEN=你的BotToken
DISCORD_CHANNEL_ID=你的頻道ID
DISCORD_GUILD_ID=你的伺服器ID            # 選用，建議填，斜線指令即時生效
DISCORD_ENABLE_PREFIX_COMMANDS=true     # 只用斜線指令可改 false（就不必開 MESSAGE CONTENT INTENT）
OPENAI_API_KEY=sk-...
# FINNHUB_API_KEY=...   # 選用，見 .env.example
```

```bash
npm install
npm start    # 環境變數可寫進 .env（自行載入）或由部署平台提供
```

啟動後 Bot 會在指定頻道發一則「Bot 已啟動」訊息，並自動註冊斜線指令。之後在該頻道輸入 `/ping`、`/stock`、`/flash`（或備援的 `!ping` / `!stock` / `!flash`）即可使用。

> **斜線指令多久生效？** 有設 `DISCORD_GUILD_ID` → 重啟後幾秒內生效；沒設（全域指令）→ 最多約 1 小時。若打 `/` 沒看到指令，先確認邀請時有勾 `applications.commands` scope，再等一下或重新整理 Discord（Ctrl+R）。

> 部署到 Zeabur / Railway 等平台時，把上述變數填到平台的環境變數設定即可，流程與 Telegram 版相同。

## 部署方式（Zeabur）

1. 把 repo push 到 GitHub，在 Zeabur 建立新專案並連結該 repo。
2. 在 Zeabur 的「環境變數」設定填入需要的變數（見上表）：
   - Telegram 版：`OPENAI_API_KEY` + `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
   - Discord 版：`OPENAI_API_KEY` + `MESSAGING_PLATFORM=discord` + `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`（建議再加 `DISCORD_GUILD_ID`；只用斜線指令可加 `DISCORD_ENABLE_PREFIX_COMMANDS=false`）
   - 視需要再加 `FINNHUB_API_KEY` / `PERPLEXITY_API_KEY` / `FMP_API_KEY`
3. Zeabur 會自動偵測 Node.js 專案 → `npm install` → `npm start`（會一併安裝 `discord.js`）。
4. 內建 HTTP 健康檢查 server（`PORT`，預設 3000）可供 Zeabur keepalive 使用。
5. Discord bot 用 Gateway 長連線（非 webhook），常駐環境即可運作，不需要對外網址；重新部署時 `SIGTERM` 會等進行中的報告跑完再退出，斜線指令會在重啟後自動重新註冊。

### 本機開發

```bash
# 安裝依賴
npm install

# 設定環境變數
cp .env.example .env   # 填入你的 API keys

# 啟動（Node 20.6+ 可用 --env-file 載入 .env）
node --env-file=.env index.js
# 或在部署平台已提供環境變數時：
npm start

# 測試模式（啟動後立即執行一次報告）
RUN_NOW=true RUN_NOW_TARGET=stock node --env-file=.env index.js
```

## 修改歷程（Changelog）

### v5.4.0（2026-05-12）

**新增 Discord 支援**
- 訊息平台抽象層：新增 `MESSAGING_PLATFORM` 環境變數，可選 `telegram`（預設）或 `discord`
- Discord 模式使用 `discord.js`：登入 Bot、發送報告到指定文字頻道
- **原生斜線指令**：啟動時自動註冊 `/ping`、`/stock`、`/flash`；設定 `DISCORD_GUILD_ID` 則即時註冊到該伺服器，否則註冊為全域指令
- `!ping` / `!stock` / `!flash` 前綴指令改為**可選**（`DISCORD_ENABLE_PREFIX_COMMANDS`）：關閉時不需要 MESSAGE CONTENT INTENT，純斜線指令部署不會因未開 intent 而崩潰
- 報告內容仍以 Telegram HTML 撰寫，Discord 模式自動轉成 Markdown（`<b>`→`**`、`<i>`→`*`、`<code>`→`` ` ``）
- 訊息分段上限改為依平台自動調整（Telegram 3800 / Discord 1900）
- `gracefulShutdown` 會一併關閉 Discord client

**效能與整理**
- 產業個股改為**分組並行抓取**（每批 3 個產業），技術指標也改為分批並行（每批 5 支），縮短日報資料抓取時間
- 版本字串統一為 `APP_VERSION` 常數；健康檢查端點加上 `platform` 欄位
- FMP 快取：移除每次 Agent 執行時的 `clearCache()`，讓 1 小時 TTL 真正生效（同小時內重複觸發直接命中）
- 移除死碼：`agents/perplexity.js` 的 `fetchAINews`、`agents/fmp.js` 的 `pruneExpiredCache` / `clearCache`
- 新增 [`.env.example`](.env.example)，README 補上 `PERPLEXITY_API_KEY` / `FMP_API_KEY` / `DISABLE_*` 等變數說明

### v5.3.0（2026-04-23）

**功能調整**
- **移除 AI 科技新聞**：刪除 PART 2 AI 科技新聞摘要功能（RSS 抓取 + GPT 評分），減少每日 API 呼叫量
- **移除 rss-parser 依賴**：不再需要 RSS 解析，精簡 `node_modules`
- **快訊排程提前**：從 07:40 調整至 07:35，緊接日報發送

**數據分析強化**
- **市場廣度摘要**：新增 `buildMarketBreadth()` 自動計算上漲/下跌家數、漲跌比、池均漲幅、大幅異動統計、RSI 超買超賣統計、量能異常個股
- **產業表現排行**：8 大產業依平均漲跌幅排序，顯示各產業上漲比例
- **GPT prompt 強化**：將廣度統計數據注入 prompt，要求 GPT 結合廣度判斷真實強弱、偵測指數與個股背離、引用產業輪動數據
- **新聞快訊指數快照**：快訊訊息頂部加入三大指數 + VIX 即時報價，一眼掌握大盤方向

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

**UX/UI 設計優化**
- **統一視覺語言**：所有報告改用 `━` 分隔線、`<code>` 標籤突出關鍵數字
- **美股日報 Header**：新增三大指數 + VIX 快速摘要行
- **系統訊息**：`/ping` 加入 uptime 和結構化表格；啟動訊息改為排程表格式
- **分段頁碼**：改為簡潔的 `━ 1/3 ━ 續下則 ▸` 樣式

### v5.0.0

- 移除 Notion 整合（簡化依賴）
- 加入 uncaughtException / unhandledRejection 全局防護
- 看門狗心跳 log（每分鐘，方便 Zeabur 監控）
- HTTP 健康檢查 server（供 Zeabur keepalive）
- Telegram 訊息超長自動切分（4096 字元限制）
- 整合進單一進程，不再需要 n8n
- 新增美股新聞快訊和 `/flash` 指令

## 未來可優化項目（Roadmap）

### 高優先

- [ ] **模組化拆分**：將 `index.js` 拆分為獨立模組（config、fetchers、reports、services、utils），提高可維護性和可測試性
- [ ] **使用 Node.js 內建 `fetch`**：替換原生 `https` 模組（Telegram / Finnhub 的 HTTP 請求），大幅簡化程式碼
- [ ] **GPT prompt 模板化**：將硬編碼的 prompt 提取為外部 JSON/模板檔案，方便調整報告格式而不需改動程式碼
- [ ] **加入單元測試**：為技術指標計算、假日判斷、格式化函式等純函式撰寫測試

### 中優先

- [ ] **產業個股並行抓取**：目前 8 大產業仍逐一產業 `await`，可改為 2~3 組並行以加速 `fetchAllMarketData`
- [ ] **快取機制**：對 Finnhub 新聞加入短期快取（例如 10 分鐘），避免手動觸發時重複請求
- [ ] **報告歷史記錄**：將每次報告存入本地 JSON/SQLite，方便回溯和比對
- [ ] **自訂股票池**：支援透過 Telegram 指令或環境變數動態增減監控的股票
- [ ] **技術指標增強**：加入 MACD、KD 指標，並在報告中呈現交叉訊號

### 低優先

- [ ] **TypeScript 遷移**：提供型別安全，減少執行期錯誤
- [ ] **Docker 化**：提供 Dockerfile 方便本地開發和多平台部署
- [ ] **Web Dashboard**：簡易的 Web 介面查看報告歷史和 Bot 狀態
- [ ] **Webhook 模式**：替換 Telegram polling 為 webhook，減少資源消耗

## License

MIT
