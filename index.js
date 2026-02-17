// ═══════════════════════════════════════════════════════════
// 美股日報機器人 v2.0
// 優化項目：
//   ① 串接 Yahoo Finance 抓取真實股價
//   ② 非交易日自動跳過（不發廢報告）
//   ③ API 失敗自動重試（最多 3 次）
//   ④ 環境變數啟動驗證（錯誤設定立即提示）
//   ⑤ 發送後確認機制（知道是否真的送達）
//   ⑥ Telegram 錯誤時改用純文字重發
//   ⑦ 完整結構化 Log（時間戳 + 狀態碼）
// ═══════════════════════════════════════════════════════════

const OpenAI       = require('openai');
const cron         = require('node-cron');
const https        = require('https');
const yahooFinance = require('yahoo-finance2').default;

// ─────────────────────────────────────────────
// ① 環境變數驗證（啟動時即時發現設定錯誤）
// ─────────────────────────────────────────────
const REQUIRED_VARS = ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

function validateEnv() {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ 缺少必要的環境變數：${missing.join(', ')}`);
    console.error('請在 Zeabur 的 Variables 頁籤填入所有必要變數。');
    process.exit(1);   // 立刻停止，不讓排程跑起來
  }
}

validateEnv();

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

// ─────────────────────────────────────────────
// 排程設定
// ─────────────────────────────────────────────
const SCHEDULE = '30 7 * * 1-5';   // 台北時間週一至週五 07:30
const TIMEZONE = 'Asia/Taipei';

// ─────────────────────────────────────────────
// ② 股票代碼清單（可自行增減）
// ─────────────────────────────────────────────
const INDICES = [
  { symbol: '^GSPC',  name: 'S&P 500'    },
  { symbol: '^DJI',   name: '道瓊工業'   },
  { symbol: '^IXIC',  name: '那斯達克'   },
  { symbol: '^VIX',   name: 'VIX 恐慌指數' },
];

const MAG7 = [
  { symbol: 'AAPL',  name: 'Apple'   },
  { symbol: 'MSFT',  name: 'Microsoft' },
  { symbol: 'GOOGL', name: 'Alphabet' },
  { symbol: 'AMZN',  name: 'Amazon'  },
  { symbol: 'NVDA',  name: 'Nvidia'  },
  { symbol: 'META',  name: 'Meta'    },
  { symbol: 'TSLA',  name: 'Tesla'   },
];

// ─────────────────────────────────────────────
// ③ 從 Yahoo Finance 抓取真實股價
// ─────────────────────────────────────────────
async function fetchQuote(symbol) {
  try {
    const q = await yahooFinance.quote(symbol, {}, { validateResult: false });
    return {
      symbol,
      price:       q.regularMarketPrice,
      change:      q.regularMarketChange,
      changePct:   q.regularMarketChangePercent,
      prevClose:   q.regularMarketPreviousClose,
      open:        q.regularMarketOpen,
      high:        q.regularMarketDayHigh,
      low:         q.regularMarketDayLow,
      volume:      q.regularMarketVolume,
      marketCap:   q.marketCap,
      fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
      fiftyTwoWeekLow:  q.fiftyTwoWeekLow,
      shortName:   q.shortName || symbol,
    };
  } catch (err) {
    console.warn(`  ⚠️  無法取得 ${symbol} 報價：${err.message}`);
    return null;  // 失敗時回傳 null，不中斷整體流程
  }
}

async function fetchAllMarketData() {
  console.log('📡 正在抓取即時市場資料...');

  const [indexData, mag7Data] = await Promise.all([
    Promise.all(INDICES.map(s => fetchQuote(s.symbol))),
    Promise.all(MAG7.map(s => fetchQuote(s.symbol))),
  ]);

  // 過濾掉抓取失敗的
  return {
    indices: INDICES.map((s, i) => ({ ...s, quote: indexData[i] })).filter(x => x.quote),
    mag7:    MAG7.map((s, i) => ({ ...s, quote: mag7Data[i] })).filter(x => x.quote),
  };
}

// ─────────────────────────────────────────────
// 格式化工具函數
// ─────────────────────────────────────────────
function fmt(num, digits = 2) {
  if (num == null) return 'N/A';
  return num.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(num) {
  if (num == null) return 'N/A';
  const sign = num >= 0 ? '+' : '';
  return `${sign}${(num).toFixed(2)}%`;
}

function trendEmoji(changePct) {
  if (changePct == null) return '⬜';
  if (changePct >= 2)    return '🚀';
  if (changePct >= 0.5)  return '🟢';
  if (changePct >= 0)    return '🟡';
  if (changePct >= -0.5) return '🟡';
  if (changePct >= -2)   return '🔴';
  return '💀';
}

function formatVolume(vol) {
  if (!vol) return 'N/A';
  if (vol >= 1e9) return `${(vol / 1e9).toFixed(1)}B`;
  if (vol >= 1e6) return `${(vol / 1e6).toFixed(1)}M`;
  return vol.toLocaleString();
}

// ─────────────────────────────────────────────
// ④ 將真實資料組成結構化文字，傳給 OpenAI
// ─────────────────────────────────────────────
function buildMarketDataSection(marketData) {
  const { indices, mag7 } = marketData;

  let section = '=== 今日真實市場數據 ===\n\n';

  // 三大指數 + VIX
  section += '【三大指數 + VIX】\n';
  for (const { name, quote: q } of indices) {
    const emoji = trendEmoji(q.changePct);
    section += `${emoji} ${name}: ${fmt(q.price)} (${fmtPct(q.changePct)}, ${q.change >= 0 ? '+' : ''}${fmt(q.change)})\n`;
    if (q.fiftyTwoWeekHigh) {
      const pct52H = ((q.price - q.fiftyTwoWeekHigh) / q.fiftyTwoWeekHigh * 100);
      section += `   52週高: ${fmt(q.fiftyTwoWeekHigh)}  低: ${fmt(q.fiftyTwoWeekLow)}  距高點: ${pct52H.toFixed(1)}%\n`;
    }
  }

  // 七巨頭
  section += '\n【七巨頭個股】\n';
  for (const { name, symbol, quote: q } of mag7) {
    const emoji = trendEmoji(q.changePct);
    section += `${emoji} ${name} (${symbol}): $${fmt(q.price)} ${fmtPct(q.changePct)}\n`;
    section += `   量: ${formatVolume(q.volume)}  前收: $${fmt(q.prevClose)}\n`;
  }

  return section;
}

// ─────────────────────────────────────────────
// ⑤ 組裝完整 Prompt（真實數據 + 分析要求）
// ─────────────────────────────────────────────
function buildPrompt(marketData) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const dataSection = buildMarketDataSection(marketData);

  return `你是專業的美股市場分析師，以下是今天（${today}）的真實市場數據，請根據這些數據撰寫完整的美股市場日報。

${dataSection}

=== 報告撰寫要求 ===

請依照以下格式，用繁體中文撰寫適合 Telegram 閱讀的市場日報：

1. 📊 三大指數總覽
   - 直接引用上方真實數字
   - 指出今日市場的整體氛圍（風險偏好/規避）
   - 指數之間是否出現分化（例如道瓊漲但那斯達克跌）

2. 🔮 七巨頭動態
   - 直接引用上方真實數字
   - 點出今日最強 / 最弱的巨頭
   - 分析巨頭集體走勢對大盤的意涵

3. 📰 今日重要背景事件
   - 結合你的知識，補充可能影響今日走勢的總經因素
   - Fed 政策立場、近期 CPI/PCE 數據走勢
   - 重要企業財報或公告（若有）

4. 🔄 產業輪動觀察
   - 根據巨頭個股表現推測板塊強弱
   - 防禦型 vs 成長型板塊的資金動向

5. 🎯 後市三情境展望
   - 多頭情境：支撐條件 + 近期目標位
   - 空頭情境：觸發風險 + 關鍵支撐位
   - 中性情境：盤整區間

6. ⚠️ 本週風險雷達
   - 本週還有哪些重要數據公布（Fed 會議、財報週等）
   - 技術面警示

【格式規範】
- 直接用真實數字，不要說「根據上方數據」
- 數字要帶千位符號和漲跌方向符號：S&P 500: 6,882.72（▲35.09 / +0.51%）
- 章節標題用 emoji 加粗體感
- 最後加：⚠️ 免責聲明：本報告由 AI 自動生成，數據來源 Yahoo Finance，僅供參考，不構成投資建議。`;
}

// ─────────────────────────────────────────────
// ⑥ OpenAI API 呼叫（含重試邏輯）
// ─────────────────────────────────────────────
async function callOpenAI(prompt, retries = 3) {
  const openai = new OpenAI({ apiKey: OPENAI_KEY });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  🤖 呼叫 OpenAI（第 ${attempt} 次）...`);
      const completion = await openai.chat.completions.create({
        model:       'gpt-4o',
        messages: [
          {
            role: 'system',
            content: '你是資深美股分析師，擅長根據真實市場數據與股價撰寫清晰易讀的市場分析報告。報告要有具體數字，有洞察，有行動指引，不要空泛。'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens:  3500,
        temperature: 0.65,
      });

      return completion.choices[0].message.content;

    } catch (err) {
      console.warn(`  ⚠️  OpenAI 第 ${attempt} 次失敗：${err.message}`);
      if (attempt < retries) {
        const wait = attempt * 3000;  // 3s, 6s 遞增等待
        console.log(`  ⏳ ${wait / 1000} 秒後重試...`);
        await sleep(wait);
      } else {
        throw err;  // 全部重試失敗，向上拋出
      }
    }
  }
}

// ─────────────────────────────────────────────
// ⑦ Telegram 發送（含 HTML 失敗時降級純文字）
// ─────────────────────────────────────────────
function sendRawTelegram(text, parseMode = 'HTML') {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: CHAT_ID, text };
    if (parseMode) payload.parse_mode = parseMode;

    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            resolve({ ok: true, messageId: result.result?.message_id });
          } else {
            reject(new Error(`${result.error_code}: ${result.description}`));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendToTelegram(text) {
  try {
    // 先嘗試 HTML 模式
    const result = await sendRawTelegram(text, 'HTML');
    return result;
  } catch (err) {
    if (err.message.includes("can't parse") || err.message.includes('Bad Request')) {
      // HTML 解析失敗 → 降級為純文字（去掉所有 HTML 標籤）
      console.warn('  ⚠️  HTML 格式解析失敗，改用純文字模式...');
      const plainText = text.replace(/<[^>]+>/g, '');
      return await sendRawTelegram(plainText, null);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// 切分長訊息
// ─────────────────────────────────────────────
function splitMessage(text, maxLen = 3800) {
  const chunks = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = para.length <= maxLen ? para : para.slice(0, maxLen);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ─────────────────────────────────────────────
// ⑧ 非交易日偵測（自動跳過）
// ─────────────────────────────────────────────
function isTradingDay() {
  const now = new Date();
  const day = now.getDay();  // 0=日, 6=六

  if (day === 0 || day === 6) {
    console.log('📅 今日為週末，跳過執行。');
    return false;
  }

  // 美股主要公假（月/日，簡版）
  const holidays = [
    '1/1',   // 元旦
    '7/4',   // 獨立紀念日
    '12/25', // 耶誕節
  ];
  const md = `${now.getMonth() + 1}/${now.getDate()}`;
  if (holidays.includes(md)) {
    console.log(`📅 今日（${md}）為美股公假，跳過執行。`);
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────
// 主執行函數
// ─────────────────────────────────────────────
async function generateAndSend() {
  const startTime = Date.now();
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`[${new Date().toLocaleString('zh-TW')}] 🚀 開始執行`);

  // 非交易日跳過
  if (!isTradingDay()) return;

  try {
    // Step 1：抓取真實股價
    const marketData = await fetchAllMarketData();
    console.log(`  ✅ 取得 ${marketData.indices.length} 個指數，${marketData.mag7.length} 支個股資料`);

    // Step 2：生成報告
    const prompt = buildPrompt(marketData);
    const report = await callOpenAI(prompt);
    console.log(`  ✅ 報告生成完成（${report.length} 字）`);

    // Step 3：組裝完整訊息
    const dateStr      = new Date().toLocaleDateString('zh-TW');
    const weekday      = new Date().toLocaleDateString('zh-TW', { weekday: 'long' });
    const header       = `📈 <b>美股日報｜${dateStr} ${weekday}</b>\n${'─'.repeat(24)}\n\n`;
    const footer       = `\n\n${'─'.repeat(24)}\n🤖 AI 生成 · 數據來源 Yahoo Finance · 僅供參考`;
    const fullReport   = header + report + footer;

    // Step 4：分段發送
    const chunks = splitMessage(fullReport, 3800);
    console.log(`  📤 發送 ${chunks.length} 段訊息...`);

    let successCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const result = await sendToTelegram(chunks[i]);
      if (result.ok) successCount++;
      console.log(`    段落 ${i + 1}/${chunks.length} → ✅ message_id: ${result.messageId}`);
      if (i < chunks.length - 1) await sleep(1200);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  🎉 完成！成功發送 ${successCount}/${chunks.length} 段，耗時 ${elapsed}s`);

  } catch (err) {
    console.error(`  ❌ 執行失敗：${err.message}`);
    console.error(err.stack);

    // 發送錯誤通知（不帶 parse_mode，避免格式問題）
    const errMsg = `⚠️ 美股日報生成失敗\n時間：${new Date().toLocaleString('zh-TW')}\n錯誤：${err.message}`;
    await sendToTelegram(errMsg).catch(e => console.error('錯誤通知也失敗了：', e.message));
  }

  console.log(`${'═'.repeat(50)}\n`);
}

// ─────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// 啟動
// ─────────────────────────────────────────────
cron.schedule(SCHEDULE, generateAndSend, { timezone: TIMEZONE });

console.log('╔══════════════════════════════════════╗');
console.log('║  美股日報機器人 v2.0  已啟動          ║');
console.log('╠══════════════════════════════════════╣');
console.log(`║  排程：${SCHEDULE} (${TIMEZONE})`);
console.log(`║  模型：GPT-4o`);
console.log(`║  資料：Yahoo Finance (即時)`);
console.log(`║  目標：Telegram ${CHAT_ID}`);
console.log('╚══════════════════════════════════════╝');
generateAndSend();
