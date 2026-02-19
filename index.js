// ═══════════════════════════════════════════════════════════
// 美股日報機器人 v4.1
// ─── 沿用 v3.0 功能 ─────────────────────────────────────
//   ① Yahoo Finance 即時股價
//   ② 非交易日自動跳過
//   ③ API 失敗自動重試（最多 3 次）
//   ④ 環境變數啟動驗證
//   ⑤ 發送後確認機制
//   ⑥ Telegram HTML 失敗降級純文字
//   ⑦ 結構化 Log
//   ⑧ 昨日焦點個股（8 大產業分類）
// ─── v4.0 新增優化 ──────────────────────────────────────
//   ⑨  Finnhub 財經新聞串接（焦點個股「催化劑」有所本）
//   ⑩  程式計算漲跌幅排行榜 Top5 / Bottom5（不靠 GPT 猜）
//   ⑪  Yahoo Finance 財報日曆（本週池內個股出財報預告）
//   ⑫  移除 GPT 偽支撐/阻力位 → 改為真實「後市關注點」
//   ⑬  修正矛盾篇幅指令（最多 5 支焦點個股，無亮點可為 0）
//   ⑭  宏觀背景改引用今日真實新聞標題，禁止 GPT 引用舊數字
// ─── v4.1 技術指標引擎 ──────────────────────────────────
//   ⑮  RSI(14)、MA20、MA50、布林通道（程式計算，真實數據）
//       計算對象：MAG7 + 指數 + 當日漲跌幅前後各 10 名個股
//       指標注入 GPT Prompt，並顯示於 Telegram 排行榜
//   ⑯  yahoo-finance2 v3 API 升級修正（new YahooFinance()）
//   ⑰  Finnhub 股票報價備援 + 8 秒請求逾時保護
// ═══════════════════════════════════════════════════════════

const OpenAI       = require('openai');
const cron         = require('node-cron');
const https        = require('https');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ─────────────────────────────────────────────
// 環境變數驗證
// FINNHUB_API_KEY 可選（沒填就跳過新聞功能）
// ─────────────────────────────────────────────
const REQUIRED_VARS = ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

function validateEnv() {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ 缺少必要的環境變數：${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.FINNHUB_API_KEY) {
    console.warn('⚠️  FINNHUB_API_KEY 未設定，新聞功能將停用（不影響其他功能）');
    console.warn('   → 免費申請：https://finnhub.io/register');
  }
}

validateEnv();

const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID       = process.env.TELEGRAM_CHAT_ID;
const FINNHUB_KEY   = process.env.FINNHUB_API_KEY || null;

// ─────────────────────────────────────────────
// 排程設定
// ─────────────────────────────────────────────
const SCHEDULE = '30 7 * * 1-5';   // 台北時間週一至週五 07:30
const TIMEZONE = 'Asia/Taipei';

// ─────────────────────────────────────────────
// 指數清單
// ─────────────────────────────────────────────
const INDICES = [
  { symbol: '^GSPC', name: 'S&P 500'       },
  { symbol: '^DJI',  name: '道瓊工業'      },
  { symbol: '^IXIC', name: '那斯達克'      },
  { symbol: '^VIX',  name: 'VIX 恐慌指數'  },
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
// 產業個股池（GPT-4o 從中篩選焦點個股）
// ─────────────────────────────────────────────
const SECTOR_STOCKS = {
  '記憶體／半導體': [
    { symbol: 'MU',   name: 'Micron'            },
    { symbol: 'WDC',  name: 'Western Digital'   },
    { symbol: 'STX',  name: 'Seagate'           },
    { symbol: 'AMAT', name: 'Applied Materials' },
    { symbol: 'LRCX', name: 'Lam Research'      },
    { symbol: 'KLAC', name: 'KLA Corp'          },
    { symbol: 'ASML', name: 'ASML'              },
    { symbol: 'TSM',  name: 'TSMC'              },
    { symbol: 'INTC', name: 'Intel'             },
    { symbol: 'AMD',  name: 'AMD'               },
    { symbol: 'QCOM', name: 'Qualcomm'          },
    { symbol: 'AVGO', name: 'Broadcom'          },
  ],
  'AI／雲端基礎建設': [
    { symbol: 'SMCI', name: 'Super Micro'    },
    { symbol: 'ARM',  name: 'ARM Holdings'   },
    { symbol: 'MRVL', name: 'Marvell'        },
    { symbol: 'CRDO', name: 'Credo Tech'     },
    { symbol: 'VRT',  name: 'Vertiv'         },
    { symbol: 'EQIX', name: 'Equinix'        },
    { symbol: 'DLR',  name: 'Digital Realty' },
    { symbol: 'DDOG', name: 'Datadog'        },
    { symbol: 'SNOW', name: 'Snowflake'      },
    { symbol: 'NET',  name: 'Cloudflare'     },
    { symbol: 'PLTR', name: 'Palantir'       },
    { symbol: 'AI',   name: 'C3.ai'          },
  ],
  '低軌道衛星／太空': [
    { symbol: 'RKLB', name: 'Rocket Lab'          },
    { symbol: 'ASTS', name: 'AST SpaceMobile'     },
    { symbol: 'LUNR', name: 'Intuitive Machines'  },
    { symbol: 'RDW',  name: 'Redwire Space'       },
    { symbol: 'PL',   name: 'Planet Labs'         },
    { symbol: 'BA',   name: 'Boeing'              },
    { symbol: 'LMT',  name: 'Lockheed Martin'     },
    { symbol: 'NOC',  name: 'Northrop Grumman'    },
    { symbol: 'RTX',  name: 'RTX Corp'            },
    { symbol: 'KTOS', name: 'Kratos Defense'      },
  ],
  '能源／油氣': [
    { symbol: 'XOM', name: 'ExxonMobil'         },
    { symbol: 'CVX', name: 'Chevron'            },
    { symbol: 'COP', name: 'ConocoPhillips'     },
    { symbol: 'SLB', name: 'SLB'               },
    { symbol: 'HAL', name: 'Halliburton'        },
    { symbol: 'OXY', name: 'Occidental'         },
    { symbol: 'MPC', name: 'Marathon Petroleum' },
    { symbol: 'PSX', name: 'Phillips 66'        },
    { symbol: 'VLO', name: 'Valero Energy'      },
  ],
  '新能源／電動車': [
    { symbol: 'RIVN', name: 'Rivian'         },
    { symbol: 'LCID', name: 'Lucid Motors'   },
    { symbol: 'F',    name: 'Ford'           },
    { symbol: 'GM',   name: 'GM'             },
    { symbol: 'ENPH', name: 'Enphase'        },
    { symbol: 'FSLR', name: 'First Solar'    },
    { symbol: 'NEE',  name: 'NextEra Energy' },
    { symbol: 'PLUG', name: 'Plug Power'     },
    { symbol: 'BE',   name: 'Bloom Energy'   },
    { symbol: 'CHPT', name: 'ChargePoint'    },
  ],
  '金融／銀行': [
    { symbol: 'JPM',  name: 'JPMorgan'        },
    { symbol: 'BAC',  name: 'Bank of America' },
    { symbol: 'GS',   name: 'Goldman Sachs'   },
    { symbol: 'MS',   name: 'Morgan Stanley'  },
    { symbol: 'WFC',  name: 'Wells Fargo'     },
    { symbol: 'C',    name: 'Citigroup'       },
    { symbol: 'BLK',  name: 'BlackRock'       },
    { symbol: 'V',    name: 'Visa'            },
    { symbol: 'MA',   name: 'Mastercard'      },
    { symbol: 'COIN', name: 'Coinbase'        },
  ],
  '生技／醫療': [
    { symbol: 'LLY',  name: 'Eli Lilly'           },
    { symbol: 'NVO',  name: 'Novo Nordisk'        },
    { symbol: 'MRNA', name: 'Moderna'             },
    { symbol: 'BNTX', name: 'BioNTech'            },
    { symbol: 'REGN', name: 'Regeneron'           },
    { symbol: 'VRTX', name: 'Vertex'              },
    { symbol: 'ABBV', name: 'AbbVie'              },
    { symbol: 'ISRG', name: 'Intuitive Surgical'  },
    { symbol: 'DXCM', name: 'Dexcom'             },
    { symbol: 'HIMS', name: 'Hims & Hers'         },
  ],
  '消費／零售': [
    { symbol: 'WMT',  name: 'Walmart'     },
    { symbol: 'COST', name: 'Costco'      },
    { symbol: 'TGT',  name: 'Target'      },
    { symbol: 'HD',   name: 'Home Depot'  },
    { symbol: 'NKE',  name: 'Nike'        },
    { symbol: 'LULU', name: 'Lululemon'   },
    { symbol: 'SBUX', name: 'Starbucks'   },
    { symbol: 'MCD',  name: "McDonald's"  },
    { symbol: 'CMG',  name: 'Chipotle'    },
    { symbol: 'BABA', name: 'Alibaba'     },
  ],
};

// ─────────────────────────────────────────────
// ⑨ Finnhub 財經新聞（免費 API，每分鐘 60 次）
// 抓取昨日市場新聞標題，讓 GPT 有真實背景可引用
// ─────────────────────────────────────────────
function fetchFinnhubNews() {
  return new Promise((resolve) => {
    if (!FINNHUB_KEY) {
      resolve([]);
      return;
    }

    // 取昨日日期範圍（美東時間）
    const now   = new Date();
    const today = now.toISOString().split('T')[0];
    const yesterday = new Date(now - 86400000).toISOString().split('T')[0];

    const path = `/api/v1/news?category=general&from=${yesterday}&to=${today}&token=${FINNHUB_KEY}`;

    https.get({ hostname: 'finnhub.io', path }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const articles = JSON.parse(data);
          if (!Array.isArray(articles)) { resolve([]); return; }

          // 只取標題，過濾掉雜訊，最多 20 條
          const headlines = articles
            .filter(a => a.headline && a.headline.length > 10)
            .slice(0, 20)
            .map(a => `• ${a.headline}`);

          console.log(`  ✅ 取得 ${headlines.length} 條市場新聞標題`);
          resolve(headlines);
        } catch {
          console.warn('  ⚠️  Finnhub 新聞解析失敗，跳過');
          resolve([]);
        }
      });
    }).on('error', () => {
      console.warn('  ⚠️  Finnhub 連線失敗，跳過');
      resolve([]);
    });
  });
}

// 針對特定個股抓取新聞（只在焦點個股上用）
function fetchStockNews(symbol) {
  return new Promise((resolve) => {
    if (!FINNHUB_KEY) { resolve([]); return; }

    const now       = new Date();
    const today     = now.toISOString().split('T')[0];
    const yesterday = new Date(now - 86400000).toISOString().split('T')[0];
    const path      = `/api/v1/company-news?symbol=${symbol}&from=${yesterday}&to=${today}&token=${FINNHUB_KEY}`;

    https.get({ hostname: 'finnhub.io', path }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const articles = JSON.parse(data);
          if (!Array.isArray(articles)) { resolve([]); return; }
          resolve(articles.slice(0, 3).map(a => a.headline).filter(Boolean));
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// ─────────────────────────────────────────────
// Finnhub 股票報價備援（Yahoo Finance 失敗時使用）
// GET /api/v1/quote?symbol=AAPL&token=KEY
// c=現價 d=漲跌 dp=漲跌% h=最高 l=最低 o=開盤 pc=前收
// ─────────────────────────────────────────────
function fetchQuoteFromFinnhub(symbol) {
  return new Promise((resolve) => {
    if (!FINNHUB_KEY) { resolve(null); return; }
    const path = `/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
    https.get({ hostname: 'finnhub.io', path }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const q = JSON.parse(data);
          // c === 0 代表找不到該 symbol 或盤後無資料
          if (!q || q.c == null || q.c === 0) { resolve(null); return; }
          resolve({
            symbol,
            price:            q.c,
            change:           q.d   ?? null,
            changePct:        q.dp  ?? null,
            prevClose:        q.pc  ?? null,
            open:             q.o   ?? null,
            high:             q.h   ?? null,
            low:              q.l   ?? null,
            volume:           null,        // Finnhub 免費版無成交量
            avgVolume:        null,
            marketCap:        null,
            fiftyTwoWeekHigh: null,
            fiftyTwoWeekLow:  null,
            earningsDate:     null,
            shortName:        symbol,
            _source:          'Finnhub',  // 標記備援來源
          });
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─────────────────────────────────────────────
// Yahoo Finance 報價（8 秒逾時 + Finnhub 備援）
// ─────────────────────────────────────────────
async function fetchQuote(symbol) {
  // ── 嘗試 Yahoo Finance（8 秒逾時）──
  try {
    const quotePromise   = yahooFinance.quote(symbol, {}, { validateResult: false });
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Yahoo 請求逾時 8s')), 8000)
    );
    const q = await Promise.race([quotePromise, timeoutPromise]);

    if (q?.regularMarketPrice != null) {
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
        earningsDate:     q.earningsTimestamp ?? q.earningsTimestampStart ?? null,
        shortName:        q.shortName || symbol,
      };
    }
    throw new Error(`Yahoo 回傳空值 (price=${q?.regularMarketPrice})`);

  } catch (yahooErr) {
    // ── 備援：改用 Finnhub 免費報價 ──
    if (FINNHUB_KEY) {
      const fallback = await fetchQuoteFromFinnhub(symbol);
      if (fallback) return fallback;
    }
    console.warn(`  ⚠️  ${symbol} 報價失敗：${yahooErr.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// 歷史收盤價（供技術指標計算，Yahoo Finance chart API）
// 回傳收盤價陣列（舊→新），失敗則回傳 null（指標跳過，不影響報告）
// ─────────────────────────────────────────────
async function fetchHistoricalCloses(symbol) {
  try {
    const r = await yahooFinance.chart(
      symbol,
      { range: '3mo', interval: '1d' },
      { validateResult: false }
    );
    const closes = (r?.quotes || [])
      .filter(q => q.close != null)
      .map(q => q.close);
    return closes.length >= 15 ? closes : null;
  } catch {
    return null;  // 歷史數據失敗不影響基本報表功能
  }
}

// ─────────────────────────────────────────────
// 抓取所有市場資料
// ─────────────────────────────────────────────
async function fetchAllMarketData() {
  console.log('📡 正在抓取市場資料...');

  const [indexData, mag7Data] = await Promise.all([
    Promise.all(INDICES.map(s => fetchQuote(s.symbol))),
    Promise.all(MAG7.map(s => fetchQuote(s.symbol))),
  ]);

  console.log('📡 正在抓取各產業個股資料...');
  const sectorResults = {};
  for (const [sector, stocks] of Object.entries(SECTOR_STOCKS)) {
    await sleep(300);
    const quotes = await Promise.all(stocks.map(s => fetchQuote(s.symbol)));
    sectorResults[sector] = stocks
      .map((s, i) => ({ ...s, quote: quotes[i] }))
      .filter(x => x.quote);
  }

  const totalSectorStocks = Object.values(sectorResults).reduce((a, b) => a + b.length, 0);
  console.log(`  ✅ 各產業共取得 ${totalSectorStocks} 支個股資料`);

  // ── ⑮ 技術指標：計算 MAG7 + 指數 + 漲跌幅前後各 10 名 ──
  const allQuotedRaw = [
    ...INDICES.map((s, i) => ({ ...s, quote: indexData[i] })).filter(x => x.quote),
    ...MAG7.map((s, i) =>    ({ ...s, quote: mag7Data[i]  })).filter(x => x.quote),
    ...Object.values(sectorResults).flat(),
  ];
  const sortedByPct = [...allQuotedRaw]
    .filter(s => s.quote?.changePct != null)
    .sort((a, b) => b.quote.changePct - a.quote.changePct);

  const indicatorTargets = new Set([
    ...INDICES.map(s => s.symbol),
    ...MAG7.map(s => s.symbol),
    ...sortedByPct.slice(0, 10).map(s => s.symbol),   // 漲幅前 10
    ...sortedByPct.slice(-10).map(s => s.symbol),      // 跌幅前 10
  ]);

  console.log(`📊 計算技術指標（${indicatorTargets.size} 支）...`);
  const indicatorMap = {};
  for (const symbol of indicatorTargets) {
    const closes = await fetchHistoricalCloses(symbol);
    if (closes) indicatorMap[symbol] = calculateIndicators(closes);
    await sleep(150);  // 避免 Yahoo Finance 限速
  }
  console.log(`  ✅ 取得 ${Object.keys(indicatorMap).length} 支技術指標`);

  // 附加 indicators 欄位到各股票物件
  const attach = arr => arr.map(s => ({ ...s, indicators: indicatorMap[s.symbol] ?? null }));

  return {
    indices:      attach(INDICES.map((s, i) => ({ ...s, quote: indexData[i] })).filter(x => x.quote)),
    mag7:         attach(MAG7.map((s, i)    => ({ ...s, quote: mag7Data[i]  })).filter(x => x.quote)),
    sectorStocks: Object.fromEntries(
      Object.entries(sectorResults).map(([k, v]) => [k, attach(v)])
    ),
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
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
}
function trendEmoji(pct) {
  if (pct == null) return '⬜';
  if (pct >= 3)    return '🚀';
  if (pct >= 1)    return '🟢';
  if (pct >= 0)    return '🔼';
  if (pct >= -1)   return '🔽';
  if (pct >= -3)   return '🔴';
  return '💀';
}
function formatVolume(vol) {
  if (!vol) return 'N/A';
  if (vol >= 1e9) return `${(vol / 1e9).toFixed(1)}B`;
  if (vol >= 1e6) return `${(vol / 1e6).toFixed(1)}M`;
  return vol.toLocaleString();
}
function volumeRatio(vol, avg) {
  if (!vol || !avg || avg === 0) return null;
  return (vol / avg).toFixed(1);
}

// ─────────────────────────────────────────────
// ⑮ 技術指標計算（RSI / 均線 / 布林通道）
// 輸入：收盤價陣列（舊→新）
// ─────────────────────────────────────────────

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = changes.slice(0, period).map(c => Math.max(c, 0)).reduce((a, b) => a + b, 0) / period;
  let avgLoss = changes.slice(0, period).map(c => Math.max(-c, 0)).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(changes[i],  0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-changes[i], 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const ma    = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, c) => s + (c - ma) ** 2, 0) / period);
  return { upper: ma + 2 * std, lower: ma - 2 * std, ma };
}

// 整合計算所有指標，回傳 null 或指標物件
function calculateIndicators(closes) {
  if (!closes || closes.length < 15) return null;
  const last    = closes[closes.length - 1];
  const rsi14   = calcRSI(closes, 14);
  const ma20    = calcSMA(closes, 20);
  const ma50    = calcSMA(closes, 50);
  const boll    = calcBollinger(closes, 20);
  const ma20pct = ma20 ? ((last - ma20) / ma20 * 100) : null;
  const ma50pct = ma50 ? ((last - ma50) / ma50 * 100) : null;
  const bollPct = boll && boll.upper !== boll.lower
    ? ((last - boll.lower) / (boll.upper - boll.lower) * 100) : null;
  const rsiTag  = rsi14 == null ? '' : rsi14 >= 70 ? '【超買⚠️】' : rsi14 <= 30 ? '【超賣⚠️】' : '';
  return { rsi14, ma20, ma50, ma20pct, ma50pct, bollPct, rsiTag };
}

// 格式化指標文字（給 GPT prompt 用）
function fmtIndicatorLine(ind) {
  if (!ind) return '';
  const parts = [];
  if (ind.rsi14   != null) parts.push(`RSI(14)=${ind.rsi14.toFixed(1)}${ind.rsiTag}`);
  if (ind.ma20pct != null) parts.push(`MA20 ${ind.ma20pct >= 0 ? '+' : ''}${ind.ma20pct.toFixed(1)}%`);
  if (ind.ma50pct != null) parts.push(`MA50 ${ind.ma50pct >= 0 ? '+' : ''}${ind.ma50pct.toFixed(1)}%`);
  if (ind.bollPct != null) parts.push(`布林帶 ${ind.bollPct.toFixed(0)}%（0%=下軌 100%=上軌）`);
  return parts.length ? `   📊 ${parts.join('  ')}\n` : '';
}

// ─────────────────────────────────────────────
// ⑩ 漲跌幅排行榜（程式直接計算，不靠 GPT）
// 回傳一段 Telegram HTML 字串，直接貼入報告
// ─────────────────────────────────────────────
function buildRankingSection(marketData) {
  // 把所有產業個股 + MAG7 合成一個清單
  const allStocks = [];

  for (const [sector, stocks] of Object.entries(marketData.sectorStocks)) {
    for (const s of stocks) {
      if (s.quote?.changePct != null) {
        allStocks.push({ ...s, sector });
      }
    }
  }
  for (const s of marketData.mag7) {
    if (s.quote?.changePct != null) {
      // MAG7 已在上面各產業池出現過，標記來源避免重複
      allStocks.push({ ...s, sector: '七巨頭' });
    }
  }

  // 去重（同一 symbol 只保留一筆）
  const seen = new Set();
  const unique = allStocks.filter(s => {
    if (seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });

  const sorted = [...unique].sort((a, b) => b.quote.changePct - a.quote.changePct);
  const top5    = sorted.slice(0, 5);
  const bottom5 = sorted.slice(-5).reverse();

  let section = '<b>🏆 昨日全池漲跌幅排行</b>\n';

  const fmtRankIndicators = (ind) => {
    if (!ind) return '';
    let tag = '';
    if (ind.rsi14   != null) tag += `  RSI <b>${ind.rsi14.toFixed(0)}</b>${ind.rsi14 >= 70 ? '🔥' : ind.rsi14 <= 30 ? '🧊' : ''}`;
    if (ind.ma20pct != null) tag += `  MA20 <b>${ind.ma20pct >= 0 ? '+' : ''}${ind.ma20pct.toFixed(1)}%</b>`;
    return tag;
  };

  section += '\n📈 <b>漲幅前五名</b>\n';
  top5.forEach((s, i) => {
    const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i];
    const vr    = volumeRatio(s.quote.volume, s.quote.avgVolume);
    section += `${medal} <b>${s.name}（${s.symbol}）</b> <b>${fmtPct(s.quote.changePct)}</b>`;
    section += `  $${fmt(s.quote.price)}`;
    if (vr && parseFloat(vr) >= 1.5) section += `  📦${vr}x量`;
    section += fmtRankIndicators(s.indicators);
    section += `  <i>${s.sector}</i>\n`;
  });

  section += '\n📉 <b>跌幅前五名</b>\n';
  bottom5.forEach((s, i) => {
    const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][i];
    const vr  = volumeRatio(s.quote.volume, s.quote.avgVolume);
    section += `${num} <b>${s.name}（${s.symbol}）</b> <b>${fmtPct(s.quote.changePct)}</b>`;
    section += `  $${fmt(s.quote.price)}`;
    if (vr && parseFloat(vr) >= 1.5) section += `  📦${vr}x量`;
    section += fmtRankIndicators(s.indicators);
    section += `  <i>${s.sector}</i>\n`;
  });

  return section;
}

// ─────────────────────────────────────────────
// ⑪ 財報日曆（本週 + 下週初 即將出財報的池內個股）
// earningsDate 來自 Yahoo Finance，程式直接計算
// ─────────────────────────────────────────────
function buildEarningsSection(marketData) {
  const now      = new Date();
  const msInDay  = 86400000;
  // 往後 7 天以內的財報
  const cutoff   = now.getTime() + 7 * msInDay;

  const upcoming = [];

  const allStocks = [
    ...marketData.mag7,
    ...Object.values(marketData.sectorStocks).flat(),
  ];

  const seen = new Set();
  for (const s of allStocks) {
    if (!s.quote?.earningsDate || seen.has(s.symbol)) continue;
    seen.add(s.symbol);

    const ts = s.quote.earningsDate * 1000;  // Yahoo 回傳 Unix 秒
    if (ts > now.getTime() && ts <= cutoff) {
      const dateStr = new Date(ts).toLocaleDateString('zh-TW', {
        month: 'numeric', day: 'numeric', weekday: 'short'
      });
      upcoming.push({ ...s, dateStr, ts });
    }
  }

  if (upcoming.length === 0) return null;  // 本週無財報就不輸出

  // 依日期排序
  upcoming.sort((a, b) => a.ts - b.ts);

  let section = '<b>📅 本週財報預告</b>（池內個股）\n';
  for (const s of upcoming) {
    section += `▸ <b>${s.name}（${s.symbol}）</b> — ${s.dateStr} 出財報\n`;
  }

  return section;
}

// ─────────────────────────────────────────────
// VIX 自動解讀（程式判斷，不靠 GPT）
// ─────────────────────────────────────────────
function vixComment(vix) {
  if (vix == null) return '';
  if (vix > 35) return '🆘 極度恐慌，歷史上常見於短線低點附近';
  if (vix > 25) return '😰 市場明顯緊張，波動加劇';
  if (vix > 18) return '😐 波動偏高，市場存在不確定性';
  if (vix > 13) return '😌 市場平靜，風險偏好正常';
  return '😎 市場過度樂觀，注意潛在回調風險';
}

// ─────────────────────────────────────────────
// 組裝市場數據（傳給 GPT 的原始數字區塊）
// ─────────────────────────────────────────────
function buildMarketDataSection(marketData) {
  const { indices, mag7, sectorStocks } = marketData;
  let section = '=== 今日真實市場數據 ===\n\n';

  section += '【三大指數 + VIX】\n';
  for (const { name, quote: q } of indices) {
    section += `${trendEmoji(q.changePct)} ${name}: ${fmt(q.price)} (${fmtPct(q.changePct)}, ${q.change >= 0 ? '+' : ''}${fmt(q.change)})\n`;
    if (q.fiftyTwoWeekHigh) {
      const pct = ((q.price - q.fiftyTwoWeekHigh) / q.fiftyTwoWeekHigh * 100);
      section += `   52週高: ${fmt(q.fiftyTwoWeekHigh)}  低: ${fmt(q.fiftyTwoWeekLow)}  距高點: ${pct.toFixed(1)}%\n`;
    }
  }

  section += '\n【七巨頭個股】\n';
  for (const { name, symbol, quote: q, indicators: ind } of mag7) {
    const vr = volumeRatio(q.volume, q.avgVolume);
    section += `${trendEmoji(q.changePct)} ${name} (${symbol}): $${fmt(q.price)} ${fmtPct(q.changePct)}\n`;
    section += `   量: ${formatVolume(q.volume)}${vr ? ` (均量 ${vr}x)` : ''}  前收: $${fmt(q.prevClose)}\n`;
    section += fmtIndicatorLine(ind);
  }

  section += '\n=== 各產業個股數據（供篩選焦點個股） ===\n';
  for (const [sector, stocks] of Object.entries(sectorStocks)) {
    if (!stocks.length) continue;
    section += `\n【${sector}】\n`;
    for (const { name, symbol, quote: q, indicators: ind } of stocks) {
      const vr      = volumeRatio(q.volume, q.avgVolume);
      const dist52H = q.fiftyTwoWeekHigh
        ? `  距52週高: ${((q.price - q.fiftyTwoWeekHigh) / q.fiftyTwoWeekHigh * 100).toFixed(1)}%`
        : '';
      section += `${trendEmoji(q.changePct)} ${name} (${symbol}): $${fmt(q.price)} ${fmtPct(q.changePct)}`;
      section += `  量: ${formatVolume(q.volume)}${vr ? ` (均量 ${vr}x)` : ''}${dist52H}\n`;
      section += fmtIndicatorLine(ind);
    }
  }

  return section;
}

// ─────────────────────────────────────────────
// 組裝完整 Prompt（v4.0 修正版）
// ─────────────────────────────────────────────
function buildPrompt(marketData, newsHeadlines) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const dataSection = buildMarketDataSection(marketData);

  // ⑭ 新聞區塊：有新聞就貼真實標題，沒有就明確告知
  const newsSection = newsHeadlines.length > 0
    ? `=== 今日財經新聞標題（昨日真實頭條，請據此推論市場背景）===\n${newsHeadlines.join('\n')}`
    : `=== 今日財經新聞 ===\n（本日新聞資料未取得，宏觀背景段落請只描述市場氛圍和整體趨勢，不要引用任何具體數字或事件名稱）`;

  return `你是專業的美股市場分析師，以下是今天（${today}）的真實市場數據，請撰寫完整的美股市場日報。

${dataSection}

${newsSection}

════════════════════════════════════════
報告撰寫要求
════════════════════════════════════════

語言：繁體中文
格式：只能用 Telegram HTML 標籤（<b> <i> <code>）
禁止：任何 Markdown 語法（**粗體**、# 標題、--- 分隔線）
禁止：在開頭或結尾加說明文字，直接輸出報告本文

────────────────────────────────────────
章節一｜📊 三大指數總覽
────────────────────────────────────────
格式範本（照抄格式，填入真實數字）：

<b>📊 三大指數總覽</b>
▸ <b>S&P 500</b>：6,882.72（▲35.09 / <b>+0.51%</b>）
▸ <b>道瓊工業</b>：43,461.21（▲247.15 / <b>+0.57%</b>）
▸ <b>那斯達克</b>：21,574.86（▲115.33 / <b>+0.54%</b>）
▸ <b>VIX 恐慌指數</b>：17.23（▼1.05）

<i>一段話：今日整體氛圍、指數分化情況（例如道瓊漲但那斯達克跌）、VIX 意涵。</i>

────────────────────────────────────────
章節二｜🔮 七巨頭動態
────────────────────────────────────────
格式範本：

<b>🔮 七巨頭動態</b>
🥇 最強：<b>Nvidia（NVDA）</b> $875.43 <b>+3.21%</b>　📦 量能爆發 2.8x
🥉 最弱：<b>Tesla（TSLA）</b> $248.10 <b>-2.14%</b>
▸ Apple $198.20 <b>+0.41%</b>　▸ Microsoft $415.32 <b>+0.89%</b>
▸ Alphabet $172.45 <b>+0.63%</b>　▸ Amazon $196.78 <b>+1.12%</b>
▸ Meta $551.20 <b>+0.74%</b>

<i>一段話：巨頭整體偏多/偏空、量能異常點評、對大盤意涵。</i>

────────────────────────────────────────
章節三｜🔥 昨日焦點個股
────────────────────────────────────────
【篩選規則】
從各產業個股數據中，依以下優先順序挑選焦點個股：
  ① 漲跌幅絕對值 > 3%
  ② 成交量 ≥ 均量 2 倍
  ③ 距 52 週高點 ±3% 以內（突破或接近高點）
  ④ 若有對應的新聞標題，優先列入
  ⑤ RSI(14) ≥ 70【超買⚠️】或 ≤ 30【超賣⚠️】（有提供時才使用）
  ⑥ 價格站上 MA50（由下往上突破）或跌破 MA50（由上往下）——重要結構訊號

【技術指標說明（數據若存在即可引用）】
- RSI(14)：動能指標。70 以上超買（短線有壓），30 以下超賣（反彈機率高）
- MA20 ±%：距 20 日均線百分比，反映短線乖離
- MA50 ±%：距 50 日均線百分比，反映中期趨勢強弱
- 布林帶 %：0% 為下軌，100% 為上軌；>90% 或 <10% 代表極端位置

【數量上限】
- 整份報告焦點個股合計最多 5 支
- 無符合條件的個股可以是 0 支（直接寫「今日各產業無顯著異動」）
- 不可為了「有內容」而硬湊無意義的個股

【每支個股格式範本】
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
📌 <b>[產業標籤]｜[股票名稱]（[代碼]）</b>
💰 <b>$[價格]</b>  [漲跌emoji] <b>[漲跌幅]</b>  📦 量能 <b>[均量倍數]x</b>
📊 RSI <b>[數值]</b>[若超買⚠️/超賣⚠️]  MA20 <b>[±%]</b>  MA50 <b>[±%]</b>（若有數據則輸出此行，若無數據則略去）
🔍 <b>焦點：</b>[一句話，說明為何今日值得關注——可結合技術指標+量能+漲跌幅，必須有根據]
📋 <b>背景：</b>[產業趨勢或同業比較，2 句話，可引用技術面結構（如站上MA50）或新聞標題]
👁 <b>後市關注：</b>[技術面下一個觀察點（如 RSI 能否回落、是否守住 MA20）+ 基本面事件]

【⚠️ 重要禁止事項】
✗ 禁止寫「支撐 $xxx，阻力 $xxx」——精確技術位數字你沒有根據，不要瞎填
✗ 禁止說「近期財報優於預期」「上週升評」等具體事件，除非新聞標題有明確依據
✓ 技術面可引用：RSI 值、MA20/MA50 相對位置、布林帶位置，這些是程式計算的真實數據

────────────────────────────────────────
章節四｜📰 宏觀背景
────────────────────────────────────────
【規則】
- 如果上方有提供新聞標題，請根據標題內容分析市場背景
- 如果沒有新聞標題，只描述今日指數走勢反映的市場情緒，不要引用任何具體的 CPI、PCE、利率數字
- 財報欄位：根據新聞標題判斷，若無相關訊息寫「本日無重大財報資訊」

格式範本：
<b>📰 宏觀背景</b>
▸ <b>市場情緒：</b>[根據指數走勢與 VIX 描述今日資金偏好]
▸ <b>總經動態：</b>[根據新聞標題摘要，若無新聞則寫市場普遍關注方向]
▸ <b>財報：</b>[根據新聞判斷，若無則寫「本日無重大財報資訊」]
▸ <b>外部因素：</b>[地緣、匯率、原油等，有新聞依據再寫，否則略去]

────────────────────────────────────────
章節五｜🔄 產業輪動觀察
────────────────────────────────────────
格式範本：
<b>🔄 產業輪動觀察</b>
🟢 <b>領漲：</b>[板塊名稱] — [原因，一句話]
🔴 <b>領跌：</b>[板塊名稱] — [原因，一句話]
💸 <b>資金流向：</b>[防禦 vs 成長的強弱，資金從哪流向哪]

────────────────────────────────────────
章節六｜🎯 後市三情境
────────────────────────────────────────
格式範本：
<b>🎯 後市三情境展望</b>
🟩 <b>多頭：</b>[成立條件] → 關注 S&P <code>[整數關卡]</code> 能否守住
🟥 <b>空頭：</b>[觸發條件] → 注意 <code>[整數關卡]</code> 支撐是否失守
🟨 <b>中性：</b>[震盪條件] → 預期區間 <code>[低]–[高]</code>

【注意】這裡的點位用整數關卡（例如 6,800、6,900），不是精確的技術位

────────────────────────────────────────
章節七｜⚠️ 本週風險雷達
────────────────────────────────────────
格式範本：
<b>⚠️ 本週風險雷達</b>
▸ [星期幾]：[重要事件——Fed 會議、CPI、財報等，若不確定就不寫]
▸ <b>本週整體關注：</b>[一句話說明本週最大的不確定性來源]

────────────────────────────────────────
最後一行固定輸出（不可省略、不可修改）：
<i>⚠️ 本報告由 AI 自動生成，數據來源 Yahoo Finance / Finnhub，僅供參考，不構成投資建議。</i>`;
}

// ─────────────────────────────────────────────
// OpenAI API 呼叫
// ─────────────────────────────────────────────
async function callOpenAI(prompt, retries = 3) {
  const openai = new OpenAI({ apiKey: OPENAI_KEY });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  🤖 呼叫 GPT-4o（第 ${attempt} 次）...`);
      const completion = await openai.chat.completions.create({
        model:       'gpt-4o',
        messages: [
          {
            role:    'system',
            content: `你是資深美股分析師，同時精通 Telegram HTML 排版。

核心規則：
1. 格式：只用 <b> <i> <code>，禁止所有 Markdown
2. 數字：引用提供的真實數據，帶千位符號與漲跌符號（▲▼）
3. 焦點個股：整份報告最多 5 支，沒有亮點就填 0 支
4. 禁止偽造：支撐阻力位數字、具體財報日期、升降評事件——沒有來源就不寫
5. 宏觀背景：無新聞資料時，只描述情緒和方向，不引用具體舊數字`,
          },
          { role: 'user', content: prompt }
        ],
        max_tokens:  4500,
        temperature: 0.6,
      });

      return completion.choices[0].message.content;

    } catch (err) {
      console.warn(`  ⚠️  GPT-4o 第 ${attempt} 次失敗：${err.message}`);
      if (attempt < retries) {
        const wait = attempt * 3000;
        console.log(`  ⏳ ${wait / 1000}s 後重試...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

// ─────────────────────────────────────────────
// Telegram 發送（HTML 失敗降級純文字）
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
          const r = JSON.parse(data);
          if (r.ok) resolve({ ok: true, messageId: r.result?.message_id });
          else      reject(new Error(`${r.error_code}: ${r.description}`));
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
      console.warn('  ⚠️  HTML 解析失敗，降級純文字...');
      return await sendRawTelegram(text.replace(/<[^>]+>/g, ''), null);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// 切分長訊息（依章節 emoji 斷點）
// ─────────────────────────────────────────────
function splitMessage(text, maxLen = 3800) {
  const SECTION_RE = /(?=\n<b>[📊🔮🏆🔥📅📰🔄🎯⚠️])/g;
  const sections   = text.split(SECTION_RE);
  const chunks     = [];
  let current      = '';

  for (const section of sections) {
    const candidate = current + section;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current.trim()) chunks.push(current.trim());
      if (section.length > maxLen) {
        const paras = section.split('\n\n');
        let sub = '';
        for (const p of paras) {
          const c2 = sub ? sub + '\n\n' + p : p;
          if (c2.length <= maxLen) { sub = c2; }
          else {
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
  const now  = new Date();
  const day  = now.getDay();
  if (day === 0 || day === 6) { console.log('📅 週末，跳過。'); return false; }

  const holidays = ['1/1', '7/4', '12/25'];
  const md = `${now.getMonth() + 1}/${now.getDate()}`;
  if (holidays.includes(md)) { console.log(`📅 公假（${md}），跳過。`); return false; }

  return true;
}

// ─────────────────────────────────────────────
// 主執行函數
// ─────────────────────────────────────────────
async function generateAndSend() {
  const startTime = Date.now();
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`[${new Date().toLocaleString('zh-TW')}] 🚀 開始執行`);

  if (!isTradingDay()) return;

  try {
    // Step 1：並行抓取市場資料 + 新聞
    console.log('📡 並行取得市場資料與新聞...');
    const [marketData, newsHeadlines] = await Promise.all([
      fetchAllMarketData(),
      fetchFinnhubNews(),
    ]);
    const sectorCount = Object.values(marketData.sectorStocks).reduce((a, b) => a + b.length, 0);
    const finnhubCount = [
      ...marketData.indices, ...marketData.mag7,
      ...Object.values(marketData.sectorStocks).flat(),
    ].filter(s => s.quote?._source === 'Finnhub').length;
    console.log(`  ✅ ${marketData.indices.length} 指數、${marketData.mag7.length} 巨頭、${sectorCount} 個股、${newsHeadlines.length} 則新聞${finnhubCount ? `（其中 ${finnhubCount} 支使用 Finnhub 備援）` : ''}`);

    // ── 若完全無數據則中斷，避免送出空白報告浪費 GPT 費用 ──
    const totalFetched = marketData.indices.length + marketData.mag7.length + sectorCount;
    if (totalFetched === 0) {
      console.error('  ❌ 所有數據源均失敗，中斷報告生成');
      await sendToTelegram(
        `⚠️ <b>美股日報無法生成</b>\n` +
        `原因：Yahoo Finance 與 Finnhub 股價均無法取得\n` +
        `時間：${new Date().toLocaleString('zh-TW')}\n\n` +
        `請至 Zeabur 查看日誌，確認 API 連線狀態。`
      ).catch(() => {});
      return;
    }

    // Step 2：程式計算排行榜與財報日曆（不靠 GPT）
    const rankingSection  = buildRankingSection(marketData);
    const earningsSection = buildEarningsSection(marketData);

    // Step 3：生成 GPT 報告
    const prompt = buildPrompt(marketData, newsHeadlines);
    const report = await callOpenAI(prompt);
    console.log(`  ✅ GPT 報告完成（${report.length} 字）`);

    // Step 4：組裝完整訊息
    // 排行榜 + 財報日曆由程式產生，插在 GPT 報告之後
    const now     = new Date();
    const dateStr = now.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekday = now.toLocaleDateString('zh-TW', { weekday: 'long' });
    const timeStr = now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

    const spx    = marketData.indices.find(x => x.symbol === '^GSPC');
    const vix    = marketData.indices.find(x => x.symbol === '^VIX');
    const spxStr = spx?.quote ? `S&P ${spx.quote.changePct >= 0 ? '▲' : '▼'}${Math.abs(spx.quote.changePct).toFixed(2)}%` : '';
    const vixVal = vix?.quote?.price;
    const vixStr = vixVal ? `VIX ${fmt(vixVal)}` : '';
    const summary = [spxStr, vixStr].filter(Boolean).join('  ');

    const header = `<b>📈 美股日報｜${dateStr} ${weekday}</b>\n<i>${summary}  ${timeStr} 發布</i>\n${'─'.repeat(28)}\n\n`;
    const footer = `\n\n${'─'.repeat(28)}\n<i>🤖 GPT-4o 生成 · Yahoo Finance / Finnhub · 僅供參考</i>`;

    // 插入排行榜（在 GPT 報告之後），財報日曆（在 footer 之前）
    const programSection = [
      '\n\n' + rankingSection,
      earningsSection ? '\n\n' + earningsSection : '',
    ].join('');

    const fullReport = header + report + programSection + footer;

    // Step 5：分段發送
    const chunks = splitMessage(fullReport, 3800);
    console.log(`  📤 發送 ${chunks.length} 段訊息...`);

    let successCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      let msg = chunks[i];
      if (chunks.length > 1) {
        msg += i < chunks.length - 1
          ? `\n\n<i>── 第 ${i + 1} / ${chunks.length} 段，續下則 ──</i>`
          : `\n\n<i>── 第 ${i + 1} / ${chunks.length} 段（完）──</i>`;
      }
      const result = await sendToTelegram(msg);
      if (result.ok) successCount++;
      console.log(`    段落 ${i + 1}/${chunks.length} → ✅ message_id: ${result.messageId}`);
      if (i < chunks.length - 1) await sleep(1500);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  🎉 完成！${successCount}/${chunks.length} 段發送成功，耗時 ${elapsed}s`);

  } catch (err) {
    console.error(`  ❌ 執行失敗：${err.message}`);
    console.error(err.stack);
    const errMsg = `⚠️ 美股日報生成失敗\n時間：${new Date().toLocaleString('zh-TW')}\n錯誤：${err.message}`;
    await sendToTelegram(errMsg).catch(e => console.error('錯誤通知也失敗：', e.message));
  }

  console.log(`${'═'.repeat(52)}\n`);
}

// ─────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// 啟動
// ─────────────────────────────────────────────
cron.schedule(SCHEDULE, generateAndSend, { timezone: TIMEZONE });

const totalStocks = Object.values(SECTOR_STOCKS).flat().length;
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  美股日報機器人 v4.1  已啟動                          ║');
console.log('╠══════════════════════════════════════════════════════╣');
console.log(`║  排程  ：${SCHEDULE} (${TIMEZONE})         ║`);
console.log(`║  模型  ：GPT-4o                                       ║`);
console.log(`║  股價  ：Yahoo Finance（即時）                        ║`);
console.log(`║  新聞  ：Finnhub ${FINNHUB_KEY ? '✅ 已啟用' : '❌ 未設定（功能停用）'}                      ║`);
console.log(`║  個股池：${Object.keys(SECTOR_STOCKS).length} 大產業 / ${totalStocks} 支個股                        ║`);
console.log(`║  技術指標：RSI(14) / MA20 / MA50 / 布林通道          ║`);
console.log('╚══════════════════════════════════════════════════════╝');
