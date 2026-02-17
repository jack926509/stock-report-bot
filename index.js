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

════════════════════════════════
報告撰寫要求
════════════════════════════════

請用繁體中文撰寫，輸出格式必須是 Telegram HTML（僅限 <b>、<i>、<code>、<pre> 標籤）。

嚴格禁止輸出：
✗ Markdown（**粗體**、# 標題、--- 分隔線）
✗ 任何在 Telegram HTML 模式下不合法的標籤
✗ 開頭或結尾加上多餘的說明文字（直接輸出報告本文）

────────────────────────────────
報告結構與格式範本
────────────────────────────────

【第一段：三大指數總覽】
輸出格式範本：
<b>📊 三大指數總覽</b>
▸ <b>S&P 500</b>：6,882.72（▲35.09 / <b>+0.51%</b>）
▸ <b>道瓊工業</b>：43,461.21（▲247.15 / <b>+0.57%</b>）
▸ <b>那斯達克</b>：21,574.86（▲115.33 / <b>+0.54%</b>）
▸ <b>VIX 恐慌指數</b>：17.23（▼1.05）→ 恐慌情緒趨緩，市場風險偏好回升

<i>[一段話：今日整體氛圍，指數之間是否分化，VIX 解讀]</i>

【第二段：七巨頭動態】
輸出格式範本：
<b>🔮 七巨頭動態</b>
🥇 最強：<b>Nvidia（NVDA）</b> $875.43 <b>+3.21%</b>｜量能爆發 2.8x 均量
🥉 最弱：<b>Tesla（TSLA）</b> $248.10 <b>-2.14%</b>
▸ Apple $198.20 +0.41%
▸ Microsoft $415.32 +0.89%
▸ Alphabet $172.45 +0.63%
▸ Amazon $196.78 +1.12%
▸ Meta $551.20 +0.74%

<i>[一段話：巨頭整體偏多/偏空，對大盤的意涵，量能異常個股點評]</i>

【第三段：昨日焦點個股】★ 本報告篇幅最重的區塊 ★
篩選邏輯（依優先順序）：
  a. 漲跌幅絕對值 > 3%
  b. 成交量 ≥ 均量 2 倍
  c. 接近或突破 52 週高點，或大幅超跌
  d. 同產業內相對強弱分化明顯
  e. 結合你的知識判斷近期催化劑（財報、升評、併購傳聞等）

每支焦點個股輸出格式範本：
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
📌 <b>[產業標籤]｜[股票名稱]（[代碼]）</b>
💰 <b>$[價格]</b>　[漲跌emoji] <b>[漲跌幅]</b>　📦 量能 <b>[均量倍數]x</b>
🔍 <b>焦點：</b>[一句話核心原因]
📋 <b>背景：</b>[近期業務進展 / 同業比較 / 產業趨勢，2–3 句]
🎯 <b>後市：</b>支撐 <code>$[價格]</code>，阻力 <code>$[價格]</code>，[短線留意事項]

注意：若某產業當日無明顯亮點，直接跳過該產業，不需強行湊數。

輸出範本：
<b>🔥 昨日焦點個股</b>

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
📌 <b>記憶體／半導體｜Micron（MU）</b>
💰 <b>$112.45</b>　🚀 <b>+5.82%</b>　📦 量能 <b>3.1x</b>
🔍 <b>焦點：</b>HBM 出貨量超預期，AI 伺服器需求帶動業績上修
📋 <b>背景：</b>Q2 財報預期優於市場，SK Hynix 漲勢外溢，DRAM 現貨價回升趨勢確立。
🎯 <b>後市：</b>支撐 <code>$108</code>，阻力 <code>$118</code>，留意費半指數同步性

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
📌 <b>低軌道衛星／太空｜Rocket Lab（RKLB）</b>
💰 <b>$23.18</b>　🟢 <b>+4.33%</b>　📦 量能 <b>2.4x</b>
🔍 <b>焦點：</b>Neutron 火箭進度披露，衛星製造訂單創新高
📋 <b>背景：</b>…
🎯 <b>後市：</b>…

【第四段：宏觀背景】
<b>📰 今日宏觀背景</b>
▸ <b>Fed：</b>[當前立場，近期發言重點]
▸ <b>數據：</b>[近期 CPI / PCE / 就業數據關鍵數字]
▸ <b>財報：</b>[昨日重要財報結果，若無則寫「本日無重大財報」]
▸ <b>外部因素：</b>[地緣、匯率、油價等關鍵動態]

【第五段：產業輪動】
<b>🔄 產業輪動觀察</b>
🟢 <b>領漲板塊：</b>[板塊名稱] — [原因]
🔴 <b>領跌板塊：</b>[板塊名稱] — [原因]
💸 <b>資金流向：</b>[從哪流向哪，防禦 vs 成長的強弱]

【第六段：後市三情境】
<b>🎯 後市三情境展望</b>
🟩 <b>多頭情境：</b>[支撐條件]，目標 <code>[點位]</code>
🟥 <b>空頭情境：</b>[觸發條件]，關鍵支撐 <code>[點位]</code>
🟨 <b>中性情境：</b>區間震盪 <code>[低點]–[高點]</code>

【第七段：風險雷達】
<b>⚠️ 本週風險雷達</b>
▸ [日期]：[重要事件，例如 Fed 會議、CPI 公布、大型財報]
▸ [日期]：[重要事件]
▸ <b>技術警示：</b>[關鍵支撐或超買超賣訊號]

────────────────────────────────
最後一行固定輸出（不可省略）：
<i>⚠️ 本報告由 AI 自動生成，數據來源 Yahoo Finance，僅供參考，不構成投資建議。</i>`;
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
            content: `你是資深美股分析師，同時精通 Telegram HTML 排版。

撰寫規則：
1. 輸出格式：只能使用 Telegram 支援的 HTML 標籤（<b>、<i>、<code>、<pre>），禁止任何 Markdown 語法
2. 數字要精確：直接引用資料數字，帶千位符號與漲跌符號（▲▼）
3. 焦點個股：只挑真正有異動或催化劑的個股，寧缺毋濫，無亮點的產業直接跳過
4. 文字風格：簡潔有力，適合早晨快速瀏覽，避免廢話和重複說明
5. 數字保留兩位小數，百分比前加 + 或 -，價格前加 $`,
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
// 切分長訊息（依章節標題斷點，保持每段完整）
// ─────────────────────────────────────────────
function splitMessage(text, maxLen = 3800) {
  // 章節標題識別（以 emoji 開頭的 <b> 標籤行）
  const SECTION_RE = /(?=\n<b>[📊🔮🔥📰🔄🎯⚠️])/g;

  // 先嘗試依章節切分
  const sections = text.split(SECTION_RE);
  const chunks   = [];
  let current    = '';

  for (const section of sections) {
    const candidate = current + section;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current.trim()) chunks.push(current.trim());
      // 單一章節超過 maxLen 時，再按段落切
      if (section.length > maxLen) {
        const paras = section.split('\n\n');
        let sub = '';
        for (const p of paras) {
          const c2 = sub ? sub + '\n\n' + p : p;
          if (c2.length <= maxLen) {
            sub = c2;
          } else {
            if (sub.trim()) chunks.push(sub.trim());
            sub = p.slice(0, maxLen);
          }
        }
        current = sub;
      } else {
        current = section;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());

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
    const now      = new Date();
    const dateStr  = now.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekday  = now.toLocaleDateString('zh-TW', { weekday: 'long' });
    const timeStr  = now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

    // 計算指數概況做為副標題摘要
    const spx    = marketData.indices.find(x => x.symbol === '^GSPC');
    const vix    = marketData.indices.find(x => x.symbol === '^VIX');
    const spxStr = spx?.quote ? `S&P ${spx.quote.changePct >= 0 ? '▲' : '▼'}${Math.abs(spx.quote.changePct).toFixed(2)}%` : '';
    const vixStr = vix?.quote ? `VIX ${fmt(vix.quote.price)}` : '';
    const summary = [spxStr, vixStr].filter(Boolean).join('　');

    const header = `<b>📈 美股日報｜${dateStr} ${weekday}</b>
<i>${summary}　${timeStr} 發布</i>
${'─'.repeat(28)}

`;
    const footer = `

${'─'.repeat(28)}
<i>🤖 GPT-4o 生成 · 數據來源 Yahoo Finance · 僅供參考</i>`;

    const fullReport = header + report + footer;

    // Step 4：分段發送
    const chunks = splitMessage(fullReport, 3800);
    console.log(`  📤 發送 ${chunks.length} 段訊息...`);

    let successCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      // 多段時在每段末尾加提示（第一段不加，最後一段不加「待續」）
      let msg = chunks[i];
      if (chunks.length > 1) {
        if (i < chunks.length - 1) {
          msg += `\n\n<i>── 第 ${i + 1} / ${chunks.length} 段，續下則 ──</i>`;
        } else {
          msg += `\n\n<i>── 第 ${i + 1} / ${chunks.length} 段（完）──</i>`;
        }
      }
      const result = await sendToTelegram(msg);
      if (result.ok) successCount++;
      console.log(`    段落 ${i + 1}/${chunks.length} → ✅ message_id: ${result.messageId}`);
      if (i < chunks.length - 1) await sleep(1500);
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
