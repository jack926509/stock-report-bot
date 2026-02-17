// ═══════════════════════════════════════════════════════════
// 美股日報機器人 v3.0
// 優化項目：
//   ① 串接 Yahoo Finance 抓取真實股價
//   ② 非交易日自動跳過（不發廢報告）
//   ③ API 失敗自動重試（最多 3 次）
//   ④ 環境變數啟動驗證（錯誤設定立即提示）
//   ⑤ 發送後確認機制（知道是否真的送達）
//   ⑥ Telegram 錯誤時改用純文字重發
//   ⑦ 完整結構化 Log（時間戳 + 狀態碼）
//   ⑧ 昨日焦點個股分析（依產業分類，GPT-4o 自動篩選）
// ═══════════════════════════════════════════════════════════

const OpenAI       = require('openai');
const cron         = require('node-cron');
const https        = require('https');
const yahooFinance = require('yahoo-finance2').default;

// ─────────────────────────────────────────────
// 環境變數驗證
// ─────────────────────────────────────────────
const REQUIRED_VARS = ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

function validateEnv() {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ 缺少必要的環境變數：${missing.join(', ')}`);
    console.error('請在 Zeabur 的 Variables 頁籤填入所有必要變數。');
    process.exit(1);
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
// 指數清單
// ─────────────────────────────────────────────
const INDICES = [
  { symbol: '^GSPC',  name: 'S&P 500'      },
  { symbol: '^DJI',   name: '道瓊工業'     },
  { symbol: '^IXIC',  name: '那斯達克'     },
  { symbol: '^VIX',   name: 'VIX 恐慌指數' },
];

const MAG7 = [
  { symbol: 'AAPL',  name: 'Apple'     },
  { symbol: 'MSFT',  name: 'Microsoft' },
  { symbol: 'GOOGL', name: 'Alphabet'  },
  { symbol: 'AMZN',  name: 'Amazon'    },
  { symbol: 'NVDA',  name: 'Nvidia'    },
  { symbol: 'META',  name: 'Meta'      },
  { symbol: 'TSLA',  name: 'Tesla'     },
];

// ─────────────────────────────────────────────
// 昨日焦點個股池（依產業分類）
// GPT-4o 會從這份資料中篩選當日真正有異動的個股
// 可依需求自行增減各類別的股票代碼
// ─────────────────────────────────────────────
const SECTOR_STOCKS = {
  '記憶體／半導體': [
    { symbol: 'MU',    name: 'Micron'             },
    { symbol: 'WDC',   name: 'Western Digital'    },
    { symbol: 'STX',   name: 'Seagate'            },
    { symbol: 'AMAT',  name: 'Applied Materials'  },
    { symbol: 'LRCX',  name: 'Lam Research'       },
    { symbol: 'KLAC',  name: 'KLA Corp'           },
    { symbol: 'ASML',  name: 'ASML'               },
    { symbol: 'TSM',   name: 'TSMC'               },
    { symbol: 'INTC',  name: 'Intel'              },
    { symbol: 'AMD',   name: 'AMD'                },
    { symbol: 'QCOM',  name: 'Qualcomm'           },
    { symbol: 'AVGO',  name: 'Broadcom'           },
  ],
  'AI／雲端基礎建設': [
    { symbol: 'SMCI',  name: 'Super Micro'        },
    { symbol: 'ARM',   name: 'ARM Holdings'       },
    { symbol: 'MRVL',  name: 'Marvell'            },
    { symbol: 'CRDO',  name: 'Credo Tech'         },
    { symbol: 'VRT',   name: 'Vertiv'             },
    { symbol: 'EQIX',  name: 'Equinix'            },
    { symbol: 'DLR',   name: 'Digital Realty'     },
    { symbol: 'DDOG',  name: 'Datadog'            },
    { symbol: 'SNOW',  name: 'Snowflake'          },
    { symbol: 'NET',   name: 'Cloudflare'         },
    { symbol: 'PLTR',  name: 'Palantir'           },
    { symbol: 'AI',    name: 'C3.ai'              },
  ],
  '低軌道衛星／太空': [
    { symbol: 'RKLB',  name: 'Rocket Lab'         },
    { symbol: 'ASTS',  name: 'AST SpaceMobile'    },
    { symbol: 'LUNR',  name: 'Intuitive Machines' },
    { symbol: 'RDW',   name: 'Redwire Space'      },
    { symbol: 'PL',    name: 'Planet Labs'        },
    { symbol: 'BA',    name: 'Boeing'             },
    { symbol: 'LMT',   name: 'Lockheed Martin'    },
    { symbol: 'NOC',   name: 'Northrop Grumman'   },
    { symbol: 'RTX',   name: 'RTX Corp'           },
    { symbol: 'KTOS',  name: 'Kratos Defense'     },
  ],
  '能源／油氣': [
    { symbol: 'XOM',   name: 'ExxonMobil'         },
    { symbol: 'CVX',   name: 'Chevron'            },
    { symbol: 'COP',   name: 'ConocoPhillips'     },
    { symbol: 'SLB',   name: 'SLB'               },
    { symbol: 'HAL',   name: 'Halliburton'        },
    { symbol: 'OXY',   name: 'Occidental'         },
    { symbol: 'MPC',   name: 'Marathon Petroleum' },
    { symbol: 'PSX',   name: 'Phillips 66'        },
    { symbol: 'VLO',   name: 'Valero Energy'      },
  ],
  '新能源／電動車': [
    { symbol: 'RIVN',  name: 'Rivian'             },
    { symbol: 'LCID',  name: 'Lucid Motors'       },
    { symbol: 'F',     name: 'Ford'               },
    { symbol: 'GM',    name: 'GM'                 },
    { symbol: 'ENPH',  name: 'Enphase'            },
    { symbol: 'FSLR',  name: 'First Solar'        },
    { symbol: 'NEE',   name: 'NextEra Energy'     },
    { symbol: 'PLUG',  name: 'Plug Power'         },
    { symbol: 'BE',    name: 'Bloom Energy'       },
    { symbol: 'CHPT',  name: 'ChargePoint'        },
  ],
  '金融／銀行': [
    { symbol: 'JPM',   name: 'JPMorgan'           },
    { symbol: 'BAC',   name: 'Bank of America'    },
    { symbol: 'GS',    name: 'Goldman Sachs'      },
    { symbol: 'MS',    name: 'Morgan Stanley'     },
    { symbol: 'WFC',   name: 'Wells Fargo'        },
    { symbol: 'C',     name: 'Citigroup'          },
    { symbol: 'BLK',   name: 'BlackRock'          },
    { symbol: 'V',     name: 'Visa'               },
    { symbol: 'MA',    name: 'Mastercard'         },
    { symbol: 'COIN',  name: 'Coinbase'           },
  ],
  '生技／醫療': [
    { symbol: 'LLY',   name: 'Eli Lilly'          },
    { symbol: 'NVO',   name: 'Novo Nordisk'       },
    { symbol: 'MRNA',  name: 'Moderna'            },
    { symbol: 'BNTX',  name: 'BioNTech'           },
    { symbol: 'REGN',  name: 'Regeneron'          },
    { symbol: 'VRTX',  name: 'Vertex'             },
    { symbol: 'ABBV',  name: 'AbbVie'             },
    { symbol: 'ISRG',  name: 'Intuitive Surgical' },
    { symbol: 'DXCM',  name: 'Dexcom'            },
    { symbol: 'HIMS',  name: 'Hims & Hers'        },
  ],
  '消費／零售': [
    { symbol: 'WMT',   name: 'Walmart'            },
    { symbol: 'COST',  name: 'Costco'             },
    { symbol: 'TGT',   name: 'Target'             },
    { symbol: 'HD',    name: 'Home Depot'         },
    { symbol: 'NKE',   name: 'Nike'               },
    { symbol: 'LULU',  name: 'Lululemon'          },
    { symbol: 'SBUX',  name: 'Starbucks'          },
    { symbol: 'MCD',   name: "McDonald's"         },
    { symbol: 'CMG',   name: 'Chipotle'           },
    { symbol: 'BABA',  name: 'Alibaba'            },
  ],
};

// ─────────────────────────────────────────────
// 從 Yahoo Finance 抓取單一報價
// ─────────────────────────────────────────────
async function fetchQuote(symbol) {
  try {
    const q = await yahooFinance.quote(symbol, {}, { validateResult: false });
    return {
      symbol,
      price:            q.regularMarketPrice,
      change:           q.regularMarketChange,
      changePct:        q.regularMarketChangePercent,
      prevClose:        q.regularMarketPreviousClose,
      open:             q.regularMarketOpen,
      high:             q.regularMarketDayHigh,
      low:              q.regularMarketDayLow,
      volume:           q.regularMarketVolume,
      avgVolume:        q.averageDailyVolume3Month,
      marketCap:        q.marketCap,
      fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
      fiftyTwoWeekLow:  q.fiftyTwoWeekLow,
      shortName:        q.shortName || symbol,
    };
  } catch (err) {
    console.warn(`  ⚠️  無法取得 ${symbol} 報價：${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// 抓取所有市場資料（含焦點個股池）
// ─────────────────────────────────────────────
async function fetchAllMarketData() {
  console.log('📡 正在抓取即時市場資料...');

  const [indexData, mag7Data] = await Promise.all([
    Promise.all(INDICES.map(s => fetchQuote(s.symbol))),
    Promise.all(MAG7.map(s => fetchQuote(s.symbol))),
  ]);

  // 各產業個股池（批次抓取，避免 rate limit）
  console.log('📡 正在抓取各產業個股資料...');
  const sectorResults = {};

  for (const [sector, stocks] of Object.entries(SECTOR_STOCKS)) {
    await sleep(300);  // 批次間稍作等待
    const quotes = await Promise.all(stocks.map(s => fetchQuote(s.symbol)));
    sectorResults[sector] = stocks
      .map((s, i) => ({ ...s, quote: quotes[i] }))
      .filter(x => x.quote);
  }

  const totalSectorStocks = Object.values(sectorResults).reduce((acc, arr) => acc + arr.length, 0);
  console.log(`  ✅ 各產業共取得 ${totalSectorStocks} 支個股資料`);

  return {
    indices:      INDICES.map((s, i) => ({ ...s, quote: indexData[i] })).filter(x => x.quote),
    mag7:         MAG7.map((s, i)    => ({ ...s, quote: mag7Data[i]  })).filter(x => x.quote),
    sectorStocks: sectorResults,
  };
}

// ─────────────────────────────────────────────
// 格式化工具
// ─────────────────────────────────────────────
function fmt(num, digits = 2) {
  if (num == null) return 'N/A';
  return num.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(num) {
  if (num == null) return 'N/A';
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

function trendEmoji(changePct) {
  if (changePct == null) return '⬜';
  if (changePct >= 3)    return '🚀';
  if (changePct >= 1)    return '🟢';
  if (changePct >= 0)    return '🔼';
  if (changePct >= -1)   return '🔽';
  if (changePct >= -3)   return '🔴';
  return '💀';
}

function formatVolume(vol) {
  if (!vol) return 'N/A';
  if (vol >= 1e9) return `${(vol / 1e9).toFixed(1)}B`;
  if (vol >= 1e6) return `${(vol / 1e6).toFixed(1)}M`;
  return vol.toLocaleString();
}

function volumeRatio(vol, avgVol) {
  if (!vol || !avgVol || avgVol === 0) return null;
  return (vol / avgVol).toFixed(1);
}

// ─────────────────────────────────────────────
// 組裝市場數據文字區塊（給 Prompt 用）
// ─────────────────────────────────────────────
function buildMarketDataSection(marketData) {
  const { indices, mag7, sectorStocks } = marketData;
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
    const vr = volumeRatio(q.volume, q.avgVolume);
    section += `${emoji} ${name} (${symbol}): $${fmt(q.price)} ${fmtPct(q.changePct)}\n`;
    section += `   量: ${formatVolume(q.volume)}${vr ? ` (均量 ${vr}x)` : ''}  前收: $${fmt(q.prevClose)}\n`;
  }

  // 各產業個股池（完整數據供 GPT-4o 分析篩選）
  section += '\n=== 各產業個股數據（請從中挑出昨日焦點） ===\n';
  for (const [sector, stocks] of Object.entries(sectorStocks)) {
    if (stocks.length === 0) continue;
    section += `\n【${sector}】\n`;
    for (const { name, symbol, quote: q } of stocks) {
      const emoji = trendEmoji(q.changePct);
      const vr = volumeRatio(q.volume, q.avgVolume);
      const distHigh = q.fiftyTwoWeekHigh
        ? `  距52週高: ${((q.price - q.fiftyTwoWeekHigh) / q.fiftyTwoWeekHigh * 100).toFixed(1)}%`
        : '';
      section += `${emoji} ${name} (${symbol}): $${fmt(q.price)} ${fmtPct(q.changePct)}`;
      section += `  量: ${formatVolume(q.volume)}${vr ? ` (均量 ${vr}x)` : ''}${distHigh}\n`;
    }
  }

  return section;
}

// ─────────────────────────────────────────────
// 組裝完整 Prompt
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
   - 指出今日市場的整體氛圍（風險偏好 / 規避）
   - 指數之間是否出現分化（例如道瓊漲但那斯達克跌）
   - VIX 對應解讀（恐慌升溫 / 趨於平靜）

2. 🔮 七巨頭動態
   - 直接引用上方真實數字
   - 點出今日最強 / 最弱的巨頭
   - 成交量異常（均量倍數高）的個股特別標記
   - 分析巨頭集體走勢對大盤的意涵

3. 🔥 昨日焦點個股（依產業分類）
   ★ 這是本報告的核心重點，請花最多篇幅 ★

   從「各產業個股數據」中，依照以下篩選邏輯，每個有亮點的產業各挑出 1–3 支焦點個股：

   【篩選優先順序】
   a. 漲跌幅絕對值 > 3%（明顯異動）
   b. 成交量為均量 2 倍以上（資金大舉進出）
   c. 接近 52 週高點（突破嘗試）或大幅偏離高點（超跌反彈機會）
   d. 同產業內相對強弱明顯（一枝獨秀或一隻黑羊）
   e. 結合你的知識，判斷該個股是否有近期催化劑（財報、升評、併購傳聞等）

   【每支焦點個股撰寫格式】
   📌 產業標籤｜股票名稱（代碼）
   ─ 昨日表現：價格、漲跌幅、成交量異常倍數
   ─ 焦點原因：為何值得關注？（一句話核心理由）
   ─ 背景補充：近期業務進展、同業比較、產業趨勢
   ─ 後市觀察：支撐位 / 阻力位，短線留意事項

   【注意】若某產業當日無明顯亮點，請直接跳過，不需強行湊數。
   重點是真正有異動的個股，不必每個產業都出現。

4. 📰 今日宏觀背景
   - Fed 政策立場、近期 CPI / PCE / 就業數據走勢
   - 重要企業財報或公告（若有）
   - 地緣政治、匯率、原油等外部因素

5. 🔄 產業輪動觀察
   - 今日哪些板塊領漲 / 領跌
   - 資金從哪裡流向哪裡
   - 防禦型 vs 成長型板塊的強弱對比

6. 🎯 後市三情境展望
   - 多頭情境：支撐條件 + 近期目標位
   - 空頭情境：觸發風險 + 關鍵支撐位
   - 中性情境：盤整區間

7. ⚠️ 本週風險雷達
   - 本週還有哪些重要數據公布（Fed 會議、財報週等）
   - 技術面警示

【格式規範】
- 直接用真實數字，不要說「根據上方數據」
- 數字要帶千位符號和漲跌方向符號：S&P 500: 6,882.72（▲35.09 / +0.51%）
- 章節標題用 emoji 加粗體感
- 焦點個股區塊請特別突出，是讀者最想看的部分
- 最後加：⚠️ 免責聲明：本報告由 AI 自動生成，數據來源 Yahoo Finance，僅供參考，不構成投資建議。`;
}

// ─────────────────────────────────────────────
// OpenAI API 呼叫（含重試邏輯）
// ─────────────────────────────────────────────
async function callOpenAI(prompt, retries = 3) {
  const openai = new OpenAI({ apiKey: OPENAI_KEY });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  🤖 呼叫 OpenAI GPT-4o（第 ${attempt} 次）...`);
      const completion = await openai.chat.completions.create({
        model:       'gpt-4o',
        messages: [
          {
            role:    'system',
            content: '你是資深美股分析師，擅長根據真實市場數據撰寫清晰易讀的市場分析報告。報告要有具體數字，有洞察，有行動指引，不要空泛。在昨日焦點個股環節，只挑出真正有異動或值得關注的個股，寧缺毋濫，不需每個產業都有代表。',
          },
          { role: 'user', content: prompt }
        ],
        max_tokens:  4500,
        temperature: 0.65,
      });

      return completion.choices[0].message.content;

    } catch (err) {
      console.warn(`  ⚠️  OpenAI 第 ${attempt} 次失敗：${err.message}`);
      if (attempt < retries) {
        const wait = attempt * 3000;
        console.log(`  ⏳ ${wait / 1000} 秒後重試...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

// ─────────────────────────────────────────────
// Telegram 發送（HTML 失敗時降級純文字）
// ─────────────────────────────────────────────
function sendRawTelegram(text, parseMode = 'HTML') {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: CHAT_ID, text };
    if (parseMode) payload.parse_mode = parseMode;

    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
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
    return await sendRawTelegram(text, 'HTML');
  } catch (err) {
    if (err.message.includes("can't parse") || err.message.includes('Bad Request')) {
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
  const chunks     = [];
  const paragraphs = text.split('\n\n');
  let current      = '';

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
// 非交易日偵測
// ─────────────────────────────────────────────
function isTradingDay() {
  const now = new Date();
  const day = now.getDay();

  if (day === 0 || day === 6) {
    console.log('📅 今日為週末，跳過執行。');
    return false;
  }

  const holidays = ['1/1', '7/4', '12/25'];
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

  if (!isTradingDay()) return;

  try {
    // Step 1：抓取所有市場資料
    const marketData = await fetchAllMarketData();
    const sectorCount = Object.values(marketData.sectorStocks).reduce((a, b) => a + b.length, 0);
    console.log(`  ✅ 取得 ${marketData.indices.length} 個指數、${marketData.mag7.length} 支七巨頭、${sectorCount} 支產業個股`);

    // Step 2：生成報告
    const prompt = buildPrompt(marketData);
    const report = await callOpenAI(prompt);
    console.log(`  ✅ 報告生成完成（${report.length} 字）`);

    // Step 3：組裝完整訊息
    const dateStr    = new Date().toLocaleDateString('zh-TW');
    const weekday    = new Date().toLocaleDateString('zh-TW', { weekday: 'long' });
    const header     = `📈 <b>美股日報｜${dateStr} ${weekday}</b>\n${'─'.repeat(24)}\n\n`;
    const footer     = `\n\n${'─'.repeat(24)}\n🤖 AI 生成 · 數據來源 Yahoo Finance · 僅供參考`;
    const fullReport = header + report + footer;

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

const totalSectorCount = Object.values(SECTOR_STOCKS).flat().length;
const sectorNames      = Object.keys(SECTOR_STOCKS).join('、');

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  美股日報機器人 v3.0  已啟動                      ║');
console.log('╠══════════════════════════════════════════════════╣');
console.log(`║  排程：${SCHEDULE} (${TIMEZONE})       ║`);
console.log(`║  模型：GPT-4o                                     ║`);
console.log(`║  資料：Yahoo Finance（即時）                      ║`);
console.log(`║  目標：Telegram ${CHAT_ID}                      ║`);
console.log(`║  個股池：${Object.keys(SECTOR_STOCKS).length} 大產業 / ${totalSectorCount} 支個股                    ║`);
console.log(`║  產業：${sectorNames.slice(0, 40)}...  ║`);
console.log('╚══════════════════════════════════════════════════╝');
