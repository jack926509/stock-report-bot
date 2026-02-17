// ═══════════════════════════════════════════════════
// 美股日報機器人 v1.0
// 每天台北時間早上 09:30（週一～五）自動執行
// 使用 OpenAI GPT-4o-mini 生成報告並推送到 Telegram
// ═══════════════════════════════════════════════════

const OpenAI = require('openai');
const cron   = require('node-cron');
const https  = require('https');

// ── 從環境變數讀取金鑰（在 Zeabur 介面設定，勿寫在這裡）
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

// ── 排程：台北時間 週一到五 早上 09:30
const SCHEDULE = '30 9 * * 1-5';
const TIMEZONE = 'Asia/Taipei';

// ── 報告生成 Prompt
function buildPrompt() {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  return `你是專業的美股市場分析師，請針對今天（${today}）生成一份美股市場日報。

【報告格式要求】
請依序包含以下章節，使用繁體中文，適合 Telegram 閱讀：

1. 📊 三大指數概況
   - S&P 500、道瓊工業、那斯達克
   - 各指數收盤價、漲跌點數、漲跌幅
   - 與 52 週高低點的相對位置

2. 🔮 七巨頭動態
   - AAPL、MSFT、GOOGL、AMZN、NVDA、META、TSLA
   - 各股今日表現與近期趨勢

3. 📰 今日重要事件
   - 3～5 條影響市場的重要新聞
   - 總經數據（如 CPI、就業、Fed 動向）
   - 企業財報與重要公告

4. 🔄 產業輪動觀察
   - 強勢與弱勢板塊
   - 資金流向分析

5. 🎯 後市三情境展望
   - 多頭情境：觸發條件與目標位
   - 空頭情境：風險點與支撐位
   - 中性情境：盤整區間與觀察指標

6. ⚠️ 風險提醒
   - 本週待公布的重要數據
   - 技術面關鍵支撐/壓力位

【格式規範】
- 使用 emoji 提升可讀性
- 數字格式：S&P 500: 6,882.72（+35.09 / +0.51%）🟢
- 每個章節之間空一行
- 最後加上免責聲明（投資有風險，本報告僅供參考）

注意：請基於你的知識庫提供分析框架與歷史背景，
若無法確認今日實際數據，請明確說明並提供分析視角。`;
}

// ── 主執行函數
async function generateAndSend() {
  console.log(`[${new Date().toLocaleString('zh-TW')}] 🚀 開始生成報告...`);

  try {
    // 1. 呼叫 OpenAI API
    const openai = new OpenAI({ apiKey: OPENAI_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',   // 省錢版；換 gpt-4o 品質更好
      messages: [
        {
          role: 'system',
          content: '你是資深美股分析師，擅長撰寫清晰易讀的市場分析報告。'
        },
        {
          role: 'user',
          content: buildPrompt()
        }
      ],
      max_tokens: 3000,
      temperature: 0.7,
    });

    const report = completion.choices[0].message.content;
    console.log(`✅ 報告生成完成（${report.length} 字）`);

    // 2. 加上標題與時間戳記
    const dateStr = new Date().toLocaleDateString('zh-TW');
    const header  = `📈 <b>美股日報｜${dateStr}</b>\n${'─'.repeat(24)}\n\n`;
    const footer  = `\n\n${'─'.repeat(24)}\n🤖 由 AI 自動生成 · 投資有風險`;
    const fullReport = header + report + footer;

    // 3. 分段發送（Telegram 單則上限 4096 字）
    const chunks = splitMessage(fullReport, 3800);
    console.log(`📤 準備發送 ${chunks.length} 段...`);

    for (let i = 0; i < chunks.length; i++) {
      await sendToTelegram(chunks[i]);
      if (i < chunks.length - 1) await sleep(1200);
    }

    console.log('🎉 全部推送完成！');

  } catch (err) {
    console.error('❌ 執行失敗：', err.message);
    // 發送錯誤通知到 Telegram
    await sendToTelegram(`⚠️ 今日報告生成失敗：\n${err.message}`).catch(() => {});
  }
}

// ── 將長文字切分成不超過 maxLen 的段落（依雙換行切分）
function splitMessage(text, maxLen) {
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

// ── 發送訊息到 Telegram（使用 Node.js 內建 https）
function sendToTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) resolve(result);
          else reject(new Error(`Telegram 錯誤: ${result.description}`));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 等待工具函數
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 啟動排程（每天台北時間 09:30 週一至週五）
cron.schedule(SCHEDULE, generateAndSend, { timezone: TIMEZONE });
console.log(`✅ 排程已啟動：台北時間週一至週五 09:30 自動執行`);
console.log(`🕒 伺服器時間：${new Date().toLocaleString('zh-TW')}`);
