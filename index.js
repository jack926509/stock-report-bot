// ═══════════════════════════════════════════════════════════
// 美股日報 + AI 科技新聞 整合機器人 v5.0
//
// ─── 雙通報架構 ─────────────────────────────────────────
//  📊 訊息一：美股日報（07:30，週一至週五）
//     沿用 v4.3 全功能：
//     ① Yahoo Finance 即時股價 + Finnhub 備援
//     ② 非交易日自動跳過
//     ③ API 失敗自動重試
//     ④ RSI / MA20 / MA50 / 布林通道技術指標
//     ⑤ 漲跌幅排行榜（程式計算，Top5/Bottom5）
//     ⑥ 財報日曆（本週池內個股）
//     ⑦ Finnhub 財經新聞分析（MAG7 + 異動個股）
//     ⑧ GPT-4o 宏觀分析（8 章節格式）
//
//  📰 訊息二：AI 科技新聞摘要（07:35，每天含週末）
//     ① 4 大 RSS 來源（各自限制 5 篇，修正原 n8n Bug）
//     ② 過濾 now-24hr 內新文章（修正時區 Bug）
//     ③ URL 去重（比 title 去重更準確）
//     ④ GPT-4o-mini 繁中摘要 + 1-5 重要性評分
//     ⑤ 依必讀/重要/一般分組推播
//
// ─── v5.0 改善 ──────────────────────────────────────────
//  ✅ 移除 Notion 整合（簡化依賴）
//  ✅ 加入 uncaughtException / unhandledRejection 全局防護
//  ✅ 看門狗心跳 log（每分鐘，方便 Zeabur 監控）
//  ✅ /ping /stock /news 指令（隨時確認存活 + 手動觸發）
//  ✅ HTTP 健康檢查 server（供 Zeabur keepalive）
//  ✅ Telegram 訊息超長自動切分（4096 字元限制）
//  ✅ 整合進單一進程，不再需要 n8n
// ═══════════════════════════════════════════════════════════

'use strict';

const OpenAI       = require('openai');
const cron         = require('node-cron');
const https        = require('https');
const http         = require('http');
const RssParser    = require('rss-parser');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ─────────────────────────────────────────────
// 環境變數驗證
// ─────────────────────────────────────────────
const REQUIRED_VARS = ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

function validateEnv() {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ 缺少必要的環境變數：${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.FINNHUB_API_KEY) {
    console.warn('⚠️  FINNHUB_API_KEY 未設定，Finnhub 新聞功能停用（不影響其他功能）');
  }
}

validateEnv();

const OPENAI_KEY  = process.env.OPENAI_API_KEY;
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || null;
const TIMEZONE    = 'Asia/Taipei';

const STOCK_SCHEDULE = '30 7 * * 1-5';
const NEWS_SCHEDULE  = '35 7 * * *';
const NEWS_MARKET_LIMIT = 20;
const NEWS_STOCK_LIMIT  = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

// ═══════════════════════════════════════════════════════════
// PART 1：美股日報
// ═══════════════════════════════════════════════════════════

const INDICES = [
  { symbol: '^GSPC', name: 'S&P 500'      },
  { symbol: '^DJI',  name: '道瓊工業'     },
  { symbol: '^IXIC', name: '那斯達克'     },
  { symbol: '^VIX',  name: 'VIX 恐慌指數' },
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
    { symbol: 'RKLB', name: 'Rocket Lab'         },
    { symbol: 'ASTS', name: 'AST SpaceMobile'    },
    { symbol: 'LUNR', name: 'Intuitive Machines' },
    { symbol: 'RDW',  name: 'Redwire Space'      },
    { symbol: 'PL',   name: 'Planet Labs'        },
    { symbol: 'BA',   name: 'Boeing'             },
    { symbol: 'LMT',  name: 'Lockheed Martin'    },
    { symbol: 'NOC',  name: 'Northrop Grumman'   },
    { symbol: 'RTX',  name: 'RTX Corp'           },
    { symbol: 'KTOS', name: 'Kratos Defense'     },
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
    { symbol: 'LLY',  name: 'Eli Lilly'          },
    { symbol: 'NVO',  name: 'Novo Nordisk'       },
    { symbol: 'MRNA', name: 'Moderna'            },
    { symbol: 'BNTX', name: 'BioNTech'           },
    { symbol: 'REGN', name: 'Regeneron'          },
    { symbol: 'VRTX', name: 'Vertex'             },
    { symbol: 'ABBV', name: 'AbbVie'             },
    { symbol: 'ISRG', name: 'Intuitive Surgical' },
    { symbol: 'DXCM', name: 'Dexcom'            },
    { symbol: 'HIMS', name: 'Hims & Hers'        },
  ],
  '消費／零售': [
    { symbol: 'WMT',  name: 'Walmart'    },
    { symbol: 'COST', name: 'Costco'     },
    { symbol: 'TGT',  name: 'Target'     },
    { symbol: 'HD',   name: 'Home Depot' },
    { symbol: 'NKE',  name: 'Nike'       },
    { symbol: 'LULU', name: 'Lululemon'  },
    { symbol: 'SBUX', name: 'Starbucks'  },
    { symbol: 'MCD',  name: "McDonald's" },
    { symbol: 'CMG',  name: 'Chipotle'   },
    { symbol: 'BABA', name: 'Alibaba'    },
  ],
};

// ─────────────────────────────────────────────
// Finnhub 新聞
// ─────────────────────────────────────────────
function fetchFinnhubNews() {
  return new Promise((resolve) => {
    if (!FINNHUB_KEY) { resolve([]); return; }
    const now       = new Date();
    const today     = now.toISOString().split('T')[0];
    const yesterday = new Date(now - 86400000).toISOString().split('T')[0];
    const path = `/api/v1/news?category=general&from=${yesterday}&to=${today}&token=${FINNHUB_KEY}`;
    https.get({ hostname: 'finnhub.io', path }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const articles = JSON.parse(data);
          if (!Array.isArray(articles)) { resolve([]); return; }
          const headlines = articles
            .filter(a => a.headline && a.headline.length > 10)
            .slice(0, NEWS_MARKET_LIMIT)
            .map(a => `• ${a.headline}`);
          log('FINNHUB', `取得 ${headlines.length} 條市場新聞`);
          resolve(headlines);
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

function fetchStockNews(symbol) {
  return new Promise((resolve) => {
    if (!FINNHUB_KEY) { resolve([]); return; }
    const now       = new Date();
    const today     = now.toISOString().split('T')[0];
    const yesterday = new Date(now - 86400000).toISOString().split('T')[0];
    const path = `/api/v1/company-news?symbol=${symbol}&from=${yesterday}&to=${today}&token=${FINNHUB_KEY}`;
    https.get({ hostname: 'finnhub.io', path }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const articles = JSON.parse(data);
          if (!Array.isArray(articles)) { resolve([]); return; }
          resolve(articles.slice(0, NEWS_STOCK_LIMIT).map(a => a.headline).filter(Boolean));
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

async function fetchKeyStockNews(marketData) {
  if (!FINNHUB_KEY) return {};
  const allSectorStocks = Object.values(marketData.sectorStocks).flat();
  const sorted = [...allSectorStocks]
    .filter(s => s.quote?.changePct != null)
    .sort((a, b) => b.quote.changePct - a.quote.changePct);
  const topMovers = [...sorted.slice(0, 3), ...sorted.slice(-3)];
  const targets = new Map();
  for (const s of MAG7)      targets.set(s.symbol, s.name);
  for (const s of topMovers) targets.set(s.symbol, s.name);
  const newsMap = {};
  for (const [symbol, name] of targets) {
    const headlines = await fetchStockNews(symbol);
    if (headlines.length > 0) newsMap[symbol] = { name, headlines };
    await sleep(300);
  }
  log('FINNHUB', `取得 ${Object.keys(newsMap).length} 支個股新聞`);
  return newsMap;
}

// ─────────────────────────────────────────────
// Finnhub 股票報價備援
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
          if (!q || q.c == null || q.c === 0) { resolve(null); return; }
          resolve({
            symbol, price: q.c, change: q.d ?? null, changePct: q.dp ?? null,
            prevClose: q.pc ?? null, open: q.o ?? null, high: q.h ?? null, low: q.l ?? null,
            volume: null, avgVolume: null, marketCap: null,
            fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, earningsDate: null,
            shortName: symbol, _source: 'Finnhub',
          });
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─────────────────────────────────────────────
// Yahoo Finance 報價（8秒逾時 + Finnhub 備援）
// ─────────────────────────────────────────────
async function fetchQuote(symbol) {
  try {
    const quotePromise   = yahooFinance.quote(symbol, {}, { validateResult: false });
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('Yahoo 逾時 8s')), 8000));
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
    throw new Error('Yahoo 回傳空值');
  } catch (yahooErr) {
    if (FINNHUB_KEY) {
      const fallback = await fetchQuoteFromFinnhub(symbol);
      if (fallback) return fallback;
    }
    log('WARN', `${symbol} 報價失敗：${yahooErr.message}`);
    return null;
  }
}

async function fetchHistoricalCloses(symbol) {
  try {
    const r = await yahooFinance.chart(symbol, { range: '3mo', interval: '1d' }, { validateResult: false });
    const closes = (r?.quotes || []).filter(q => q.close != null).map(q => q.close);
    return closes.length >= 15 ? closes : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// 抓取所有市場資料
// ─────────────────────────────────────────────
async function fetchAllMarketData() {
  log('STOCK', '抓取市場資料中...');
  const [indexData, mag7Data] = await Promise.all([
    Promise.all(INDICES.map(s => fetchQuote(s.symbol))),
    Promise.all(MAG7.map(s => fetchQuote(s.symbol))),
  ]);

  log('STOCK', '抓取各產業個股...');
  const sectorResults = {};
  for (const [sector, stocks] of Object.entries(SECTOR_STOCKS)) {
    await sleep(300);
    const quotes = await Promise.all(stocks.map(s => fetchQuote(s.symbol)));
    sectorResults[sector] = stocks.map((s, i) => ({ ...s, quote: quotes[i] })).filter(x => x.quote);
  }
  const sectorCount = Object.values(sectorResults).reduce((a, b) => a + b.length, 0);
  log('STOCK', `取得：${indexData.filter(Boolean).length} 指數 / ${mag7Data.filter(Boolean).length} 巨頭 / ${sectorCount} 個股`);

  const allQuotedRaw = [
    ...INDICES.map((s, i) => ({ ...s, quote: indexData[i] })).filter(x => x.quote),
    ...MAG7.map((s, i)    => ({ ...s, quote: mag7Data[i]  })).filter(x => x.quote),
    ...Object.values(sectorResults).flat(),
  ];
  const sortedByPct = [...allQuotedRaw]
    .filter(s => s.quote?.changePct != null)
    .sort((a, b) => b.quote.changePct - a.quote.changePct);
  const indicatorTargets = new Set([
    ...INDICES.map(s => s.symbol),
    ...MAG7.map(s => s.symbol),
    ...sortedByPct.slice(0, 10).map(s => s.symbol),
    ...sortedByPct.slice(-10).map(s => s.symbol),
  ]);

  log('STOCK', `計算技術指標（${indicatorTargets.size} 支）...`);
  const indicatorMap = {};
  for (const symbol of indicatorTargets) {
    const closes = await fetchHistoricalCloses(symbol);
    if (closes) indicatorMap[symbol] = calculateIndicators(closes);
    await sleep(150);
  }
  log('STOCK', `技術指標完成：${Object.keys(indicatorMap).length} 支`);

  const attach = arr => arr.map(s => ({ ...s, indicators: indicatorMap[s.symbol] ?? null }));
  return {
    indices:      attach(INDICES.map((s, i) => ({ ...s, quote: indexData[i] })).filter(x => x.quote)),
    mag7:         attach(MAG7.map((s, i)    => ({ ...s, quote: mag7Data[i]  })).filter(x => x.quote)),
    sectorStocks: Object.fromEntries(Object.entries(sectorResults).map(([k, v]) => [k, attach(v)])),
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
  if (pct >= 3) return '🚀'; if (pct >= 1) return '🟢';
  if (pct >= 0) return '🔼'; if (pct >= -1) return '🔽';
  if (pct >= -3) return '🔴'; return '💀';
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
// 技術指標
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
// 漲跌幅排行榜（程式計算）
// ─────────────────────────────────────────────
function buildRankingSection(marketData) {
  const allStocks = [];
  for (const [sector, stocks] of Object.entries(marketData.sectorStocks)) {
    for (const s of stocks) {
      if (s.quote?.changePct != null) allStocks.push({ ...s, sector });
    }
  }
  for (const s of marketData.mag7) {
    if (s.quote?.changePct != null) allStocks.push({ ...s, sector: '七巨頭' });
  }
  const seen   = new Set();
  const unique = allStocks.filter(s => { if (seen.has(s.symbol)) return false; seen.add(s.symbol); return true; });
  const sorted = [...unique].sort((a, b) => b.quote.changePct - a.quote.changePct);
  const top5   = sorted.slice(0, 5);
  const bot5   = sorted.slice(-5).reverse();

  const fmtRankInd = (ind) => {
    if (!ind) return '';
    let tag = '';
    if (ind.rsi14   != null) tag += `  RSI <b>${ind.rsi14.toFixed(0)}</b>${ind.rsi14 >= 70 ? '🔥' : ind.rsi14 <= 30 ? '🧊' : ''}`;
    if (ind.ma20pct != null) tag += `  MA20 <b>${ind.ma20pct >= 0 ? '+' : ''}${ind.ma20pct.toFixed(1)}%</b>`;
    return tag;
  };

  let section = '<b>🏆 昨日全池漲跌幅排行</b>\n\n📈 <b>漲幅前五名</b>\n';
  top5.forEach((s, i) => {
    const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i];
    const vr    = volumeRatio(s.quote.volume, s.quote.avgVolume);
    section += `${medal} <b>${s.name}（${s.symbol}）</b> <b>${fmtPct(s.quote.changePct)}</b>  $${fmt(s.quote.price)}`;
    if (vr && parseFloat(vr) >= 1.5) section += `  📦${vr}x量`;
    section += fmtRankInd(s.indicators) + `  <i>${s.sector}</i>\n`;
  });
  section += '\n📉 <b>跌幅前五名</b>\n';
  bot5.forEach((s, i) => {
    const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][i];
    const vr  = volumeRatio(s.quote.volume, s.quote.avgVolume);
    section += `${num} <b>${s.name}（${s.symbol}）</b> <b>${fmtPct(s.quote.changePct)}</b>  $${fmt(s.quote.price)}`;
    if (vr && parseFloat(vr) >= 1.5) section += `  📦${vr}x量`;
    section += fmtRankInd(s.indicators) + `  <i>${s.sector}</i>\n`;
  });
  return section;
}

// ─────────────────────────────────────────────
// 財報日曆
// ─────────────────────────────────────────────
function buildEarningsSection(marketData) {
  const now     = new Date();
  const cutoff  = now.getTime() + 7 * 86400000;
  const allStocks = [...marketData.mag7, ...Object.values(marketData.sectorStocks).flat()];
  const seen = new Set();
  const upcoming = [];
  for (const s of allStocks) {
    if (!s.quote?.earningsDate || seen.has(s.symbol)) continue;
    seen.add(s.symbol);
    const ts = s.quote.earningsDate * 1000;
    if (ts > now.getTime() && ts <= cutoff) {
      const dateStr = new Date(ts).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' });
      upcoming.push({ ...s, dateStr, ts });
    }
  }
  if (upcoming.length === 0) return null;
  upcoming.sort((a, b) => a.ts - b.ts);
  let section = '<b>📅 本週財報預告</b>（池內個股）\n';
  for (const s of upcoming) section += `▸ <b>${s.name}（${s.symbol}）</b> — ${s.dateStr} 出財報\n`;
  return section;
}

// ─────────────────────────────────────────────
// 市場數據 Prompt 區塊
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
  section += '\n=== 各產業個股數據 ===\n';
  for (const [sector, stocks] of Object.entries(sectorStocks)) {
    if (!stocks.length) continue;
    section += `\n【${sector}】\n`;
    for (const { name, symbol, quote: q, indicators: ind } of stocks) {
      const vr      = volumeRatio(q.volume, q.avgVolume);
      const dist52H = q.fiftyTwoWeekHigh
        ? `  距52週高: ${((q.price - q.fiftyTwoWeekHigh) / q.fiftyTwoWeekHigh * 100).toFixed(1)}%` : '';
      section += `${trendEmoji(q.changePct)} ${name} (${symbol}): $${fmt(q.price)} ${fmtPct(q.changePct)}`;
      section += `  量: ${formatVolume(q.volume)}${vr ? ` (均量 ${vr}x)` : ''}${dist52H}\n`;
      section += fmtIndicatorLine(ind);
    }
  }
  return section;
}

// ─────────────────────────────────────────────
// GPT-4o 股市報告 Prompt
// ─────────────────────────────────────────────
function buildStockPrompt(marketData, newsHeadlines, stockNewsMap = {}) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });
  const dataSection = buildMarketDataSection(marketData);
  const newsSection = newsHeadlines.length > 0
    ? `=== 今日財經新聞標題（昨日真實頭條）===\n${newsHeadlines.join('\n')}`
    : `=== 今日財經新聞 ===\n（新聞資料未取得，宏觀背景請只描述市場氛圍，不引用具體數字）`;
  let stockNewsSection = '';
  if (Object.keys(stockNewsMap).length > 0) {
    stockNewsSection = '\n=== 重點個股新聞（昨日真實標題）===\n';
    for (const [symbol, { name, headlines }] of Object.entries(stockNewsMap)) {
      stockNewsSection += `\n【${name}（${symbol}）】\n`;
      headlines.forEach(h => { stockNewsSection += `• ${h}\n`; });
    }
  }

  return `你是專業的美股市場分析師。以下是今天（${today}）的真實市場數據，請撰寫完整美股市場日報。

${dataSection}

${newsSection}
${stockNewsSection}

撰寫要求：
- 語言：繁體中文
- 格式：只用 Telegram HTML 標籤（<b> <i> <code>），禁止 Markdown
- 直接輸出報告本文，不加說明前言

章節一｜<b>📊 三大指數總覽</b>
三大指數 + VIX 逐項列出，附一段整體氛圍解讀

章節二｜<b>🔮 七巨頭動態</b>
最強最弱各一名重點點評，其餘五支簡列，附整體意涵

章節三｜<b>🔥 昨日焦點個股</b>（最多 5 支，無異動可為 0）
篩選：漲跌>3%、量比>2x、距52週高±3%、有新聞催化、RSI超買超賣、MA50突破
每支格式：
📌 <b>[產業]｜[名稱]（[代碼]）</b>
💰 <b>$價格</b>  emoji <b>漲跌幅</b>  📦 量能 <b>均量倍數x</b>
📊 RSI <b>值</b>  MA20 <b>±%</b>  MA50 <b>±%</b>（無數據略去）
🔍 <b>焦點：</b>一句話
📋 <b>背景：</b>兩句產業趨勢
👁 <b>後市關注：</b>技術面觀察點
禁止：支撐阻力位精確數字、捏造財報升評

章節四｜<b>📰 宏觀背景</b>
市場情緒 / 總經動態 / 財報 / 外部因素

章節五｜<b>🔄 產業輪動觀察</b>
領漲 / 領跌 / 資金流向

章節六｜<b>🎯 後市三情境</b>
多頭 / 空頭 / 中性，各附整數關卡

章節七｜<b>⚠️ 本週風險雷達</b>
重要數據日期 + 最大不確定性

章節八｜<b>🗞️ 財經新聞分析</b>（3~5 則，無新聞則寫「今日無重大財經新聞」）
每則：新聞摘要 → 相關個股漲跌 → 市場解讀

最後固定輸出：
<i>⚠️ 本報告由 AI 自動生成，數據來源 Yahoo Finance / Finnhub，僅供參考，不構成投資建議。</i>`;
}

// ─────────────────────────────────────────────
// 非交易日判斷
// ─────────────────────────────────────────────
function isTradingDay() {
  const now  = new Date();
  const day  = now.getDay();
  if (day === 0 || day === 6) { log('STOCK', '週末，跳過'); return false; }
  const holidays = ['1/1', '7/4', '12/25'];
  const md = `${now.getMonth() + 1}/${now.getDate()}`;
  if (holidays.includes(md)) { log('STOCK', `公假（${md}），跳過`); return false; }
  return true;
}

// ─────────────────────────────────────────────
// 執行股市報告
// ─────────────────────────────────────────────
async function runStockReport() {
  if (!isTradingDay()) return;
  const startTime = Date.now();
  log('STOCK', '🚀 開始執行美股日報');

  try {
    const [marketData, newsHeadlines] = await Promise.all([
      fetchAllMarketData(),
      fetchFinnhubNews(),
    ]);

    const totalFetched = marketData.indices.length + marketData.mag7.length +
      Object.values(marketData.sectorStocks).reduce((a, b) => a + b.length, 0);

    if (totalFetched === 0) {
      log('STOCK', '❌ 所有數據源均失敗');
      await sendTelegram(`⚠️ <b>美股日報無法生成</b>\n原因：股價數據均無法取得\n時間：${new Date().toLocaleString('zh-TW')}`);
      return;
    }

    log('STOCK', '抓取重點個股新聞...');
    const stockNewsMap = await fetchKeyStockNews(marketData);

    const rankingSection  = buildRankingSection(marketData);
    const earningsSection = buildEarningsSection(marketData);

    log('STOCK', '呼叫 GPT-4o...');
    const prompt = buildStockPrompt(marketData, newsHeadlines, stockNewsMap);
    const report = await callOpenAI(prompt, 'gpt-4o', 4500);
    log('STOCK', `GPT 完成（${report.length} 字）`);

    const now     = new Date();
    const dateStr = now.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekday = now.toLocaleDateString('zh-TW', { weekday: 'long' });
    const timeStr = now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    const spx     = marketData.indices.find(x => x.symbol === '^GSPC');
    const vix     = marketData.indices.find(x => x.symbol === '^VIX');
    const summary = [
      spx?.quote ? `S&P ${spx.quote.changePct >= 0 ? '▲' : '▼'}${Math.abs(spx.quote.changePct).toFixed(2)}%` : '',
      vix?.quote?.price ? `VIX ${fmt(vix.quote.price)}` : '',
    ].filter(Boolean).join('  ');

    const header = `<b>📈 美股日報｜${dateStr} ${weekday}</b>\n<i>${summary}  ${timeStr} 發布</i>\n${'─'.repeat(28)}\n\n`;
    const footer = `\n\n${'─'.repeat(28)}\n<i>🤖 GPT-4o · Yahoo Finance / Finnhub · 僅供參考</i>`;
    const programSection = '\n\n' + rankingSection + (earningsSection ? '\n\n' + earningsSection : '');
    const fullReport = header + report + programSection + footer;

    const chunks = splitMessage(fullReport, 3800);
    log('STOCK', `發送 ${chunks.length} 段...`);
    for (let i = 0; i < chunks.length; i++) {
      let msg = chunks[i];
      if (chunks.length > 1) {
        msg += i < chunks.length - 1
          ? `\n\n<i>── 第 ${i + 1}/${chunks.length} 段，續下則 ──</i>`
          : `\n\n<i>── 第 ${i + 1}/${chunks.length} 段（完）──</i>`;
      }
      await sendTelegram(msg);
      if (i < chunks.length - 1) await sleep(1500);
    }
    log('STOCK', `✅ 完成，耗時 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } catch (err) {
    log('STOCK', `❌ 失敗：${err.message}`);
    await sendTelegram(`⚠️ 美股日報失敗\n時間：${new Date().toLocaleString('zh-TW')}\n錯誤：${err.message}`).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════
// PART 2：AI 科技新聞摘要
// ═══════════════════════════════════════════════════════════

const RSS_FEEDS = [
  { url: 'https://openai.com/blog/rss.xml',                                    name: 'OpenAI Blog',    maxItems: 5 },
  { url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', name: 'MIT Tech Review', maxItems: 5 },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',   name: 'The Verge AI',   maxItems: 5 },
  { url: 'https://techcrunch.com/tag/artificial-intelligence/feed/',             name: 'TechCrunch AI',  maxItems: 5 },
];

async function fetchRss(feed) {
  const parser = new RssParser({ timeout: 10000 });
  try {
    const result = await parser.parseURL(feed.url);
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000); // now-24hr，修正 n8n 時區 bug
    return result.items
      .filter(item => new Date(item.isoDate || item.pubDate || 0) > cutoff)
      .sort((a, b) => new Date(b.isoDate || 0) - new Date(a.isoDate || 0))
      .slice(0, feed.maxItems) // 各來源各自限制，修正 n8n 只限 OpenAI Blog 的 bug
      .map(item => ({
        title:   item.title || 'Untitled',
        link:    item.link  || '',
        content: (item.contentSnippet || item.description || '').slice(0, 400),
        source:  feed.name,
        pubDate: item.isoDate || item.pubDate || '',
      }));
  } catch (e) {
    log('RSS', `❌ ${feed.name} 失敗: ${e.message}`);
    return [];
  }
}

function dedup(articles) {
  // URL 去重，比 title 去重更準確，修正 n8n bug
  const seen = new Set();
  return articles.filter(a => {
    if (!a.link || seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  });
}

async function analyzeNews(articles) {
  if (articles.length === 0) return { articles: [] };
  const text = articles.map((a, i) =>
    `[${i + 1}] ${a.title}\n來源: ${a.source}\n摘要: ${a.content}`
  ).join('\n\n');

  const prompt = `你是 AI 新聞分析專家。分析以下新聞，回傳純 JSON（不要其他文字）。

評分：5=重大發布/突破研究，4=重要更新，3=一般新聞，2=次要，1=一般資訊

格式：{"articles":[{"id":1,"summary_zh":"繁中摘要30字內","importance":5,"tags":["標籤1","標籤2"]}]}

新聞：
${text}`;

  const raw = await callOpenAI(prompt, 'gpt-4o-mini', 2000);
  try {
    return JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g, '').trim());
  } catch {
    log('NEWS', '⚠️ JSON 解析失敗，使用備用格式');
    return { articles: articles.map((_, i) => ({ id: i + 1, summary_zh: '摘要生成失敗', importance: 3, tags: [] })) };
  }
}

function buildNewsMessage(articles, aiData) {
  const enriched = articles.map((a, i) => {
    const ai = aiData.articles?.find(x => x.id === i + 1) || {};
    return { ...a, summary_zh: ai.summary_zh || a.title, importance: ai.importance || 3, tags: ai.tags || [] };
  });
  enriched.sort((a, b) => b.importance - a.importance);

  const groups = {
    '🔴 必讀':  enriched.filter(a => a.importance === 5),
    '🟡 重要':  enriched.filter(a => a.importance === 4),
    '⚪️ 一般': enriched.filter(a => a.importance <= 3),
  };

  const now     = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = now.toLocaleDateString('zh-TW', { weekday: 'long' });

  let msg = `<b>📰 AI 科技新聞摘要｜${dateStr} ${weekday}</b>\n`;
  msg += `<i>OpenAI Blog · MIT Tech Review · The Verge AI · TechCrunch AI</i>\n`;
  msg += `${'─'.repeat(28)}\n\n`;

  for (const [label, list] of Object.entries(groups)) {
    if (list.length === 0) continue;
    msg += `<b>${label}</b>\n`;
    for (const a of list) {
      const tags = a.tags.length > 0 ? ` <i>[${a.tags.join(' · ')}]</i>` : '';
      msg += `▸ ${a.summary_zh}${tags}\n`;
      if (a.link) msg += `  📌 <a href="${a.link}">${a.source}</a>\n`;
      msg += '\n';
    }
  }
  msg += `${'─'.repeat(28)}\n<i>🤖 GPT-4o-mini 摘要 · 僅供參考</i>`;
  return msg;
}

async function runNewsReport() {
  log('NEWS', '🚀 開始抓取 AI 科技新聞');
  const startTime = Date.now();
  try {
    const results = await Promise.all(RSS_FEEDS.map(fetchRss));
    const all     = dedup(results.flat());
    log('NEWS', `共 ${all.length} 篇（去重後）`);

    if (all.length === 0) {
      await sendTelegram('📰 AI 科技新聞摘要：今日 24 小時內無最新文章。');
      return;
    }

    const aiResult = await analyzeNews(all);
    const message  = buildNewsMessage(all, aiResult);
    const chunks   = splitMessage(message, 3800);

    for (let i = 0; i < chunks.length; i++) {
      await sendTelegram(chunks[i]);
      if (i < chunks.length - 1) await sleep(1000);
    }
    log('NEWS', `✅ 完成，耗時 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } catch (err) {
    log('NEWS', `❌ 失敗：${err.message}`);
    await sendTelegram(`⚠️ AI 新聞摘要失敗\n錯誤：${err.message}`).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════
// 共用工具
// ═══════════════════════════════════════════════════════════

async function callOpenAI(prompt, model = 'gpt-4o', maxTokens = 2000, retries = 3) {
  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  for (let i = 1; i <= retries; i++) {
    try {
      log('OPENAI', `呼叫 ${model}（第 ${i} 次）...`);
      const res = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: model === 'gpt-4o'
              ? '你是資深美股分析師，精通 Telegram HTML 排版。只用 <b><i><code> 標籤，禁止 Markdown。數字引用真實數據。'
              : '你是 AI 新聞分析師，只回傳純 JSON，不要任何其他文字。',
          },
          { role: 'user', content: prompt }
        ],
        max_tokens:  maxTokens,
        temperature: model === 'gpt-4o' ? 0.6 : 0.3,
      });
      return res.choices[0].message.content;
    } catch (e) {
      log('OPENAI', `❌ 第 ${i} 次失敗：${e.message}`);
      if (i < retries) await sleep(i * 3000);
      else throw e;
    }
  }
}

async function sendTelegram(text) {
  try {
    return await sendRawTelegram(text, 'HTML');
  } catch (err) {
    if (err.message.includes("can't parse") || err.message.includes('Bad Request')) {
      log('TG', '⚠️ HTML 失敗，降級純文字');
      return await sendRawTelegram(text.replace(/<[^>]+>/g, ''), null);
    }
    throw err;
  }
}

function sendRawTelegram(text, parseMode = 'HTML') {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: CHAT_ID, text };
    if (parseMode) payload.parse_mode = parseMode;
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.ok) resolve({ ok: true, messageId: r.result?.message_id });
          else reject(new Error(`${r.error_code}: ${r.description}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function splitMessage(text, maxLen = 3800) {
  if (text.length <= maxLen) return [text];
  const SECTION_RE = /(?=\n<b>[📊🔮🏆🔥📅📰🔄🎯⚠️🗞️])/g;
  const sections   = text.split(SECTION_RE);
  const chunks     = [];
  let current      = '';
  for (const section of sections) {
    const candidate = current + section;
    if (candidate.length <= maxLen) { current = candidate; }
    else {
      if (current.trim()) chunks.push(current.trim());
      current = section.length > maxLen ? section.slice(0, maxLen) : section;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ─────────────────────────────────────────────
// Telegram 指令監聽
// ─────────────────────────────────────────────
async function startPolling() {
  let offset = 0;
  log('POLL', '開始監聽指令...');
  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const upd of updates) {
        offset = upd.update_id + 1;
        const text   = upd.message?.text || '';
        const chatId = String(upd.message?.chat?.id || '');
        if (chatId !== CHAT_ID) continue;
        if (text === '/ping') {
          await sendRawTelegram(
            `🟢 Bot 運作正常\n版本：v5.0\n時間：${new Date().toLocaleString('zh-TW', { timeZone: TIMEZONE })}\n記憶體：${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
          );
        } else if (text === '/news') {
          await sendRawTelegram('⏳ 手動觸發 AI 新聞摘要...');
          runNewsReport().catch(e => log('NEWS', `手動失敗: ${e.message}`));
        } else if (text === '/stock') {
          await sendRawTelegram('⏳ 手動觸發美股日報...');
          runStockReport().catch(e => log('STOCK', `手動失敗: ${e.message}`));
        }
      }
    } catch (e) { log('POLL', `polling 錯誤: ${e.message}`); }
    await sleep(3000);
  }
}

function getUpdates(offset) {
  return new Promise((resolve) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25`;
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).result || []); } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// ─────────────────────────────────────────────
// 看門狗 + 健康檢查 server
// ─────────────────────────────────────────────
function startWatchdog() {
  setInterval(() => {
    log('WATCHDOG', `💓 心跳 | 記憶體：${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  }, 60 * 1000);
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: 'v5.0', time: new Date().toISOString() }));
  });
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => log('HTTP', `健康檢查啟動 port ${PORT}`));
}

// ─────────────────────────────────────────────
// 全局錯誤防護（防止靜默崩潰）
// ─────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log('ERROR', `❌ 未捕獲異常: ${err.message}\n${err.stack}`);
  // 不 exit，繼續運行
});
process.on('unhandledRejection', (reason) => {
  log('ERROR', `❌ 未處理 Promise 拒絕: ${reason}`);
});

// ═══════════════════════════════════════════════════════════
// 主程式
// ═══════════════════════════════════════════════════════════
async function main() {
  log('MAIN', '🚀 美股日報 + AI 科技新聞 Bot v5.0 啟動');

  cron.schedule(STOCK_SCHEDULE, () => {
    log('CRON', '⏰ 觸發美股日報排程');
    runStockReport().catch(e => log('STOCK', `排程失敗: ${e.message}`));
  }, { timezone: TIMEZONE });

  cron.schedule(NEWS_SCHEDULE, () => {
    log('CRON', '⏰ 觸發 AI 新聞排程');
    runNewsReport().catch(e => log('NEWS', `排程失敗: ${e.message}`));
  }, { timezone: TIMEZONE });

  log('MAIN', `📊 美股日報：${STOCK_SCHEDULE} (Asia/Taipei)`);
  log('MAIN', `📰 AI 新聞：${NEWS_SCHEDULE}  (Asia/Taipei)`);

  startWatchdog();
  startHealthServer();
  startPolling();

  await sendTelegram(
    `🟢 <b>美股日報 + AI 科技新聞 Bot v5.0 啟動</b>\n\n` +
    `📊 美股日報：週一至週五 07:30\n` +
    `📰 AI 科技新聞：每天 07:35\n\n` +
    `指令：\n/ping — 確認 Bot 存活\n/stock — 立即觸發美股日報\n/news — 立即觸發 AI 新聞`
  );

  log('MAIN', '✅ 所有服務啟動完成，等待排程中...');
}

if (process.env.RUN_NOW === 'true') {
  log('MAIN', '⚡ RUN_NOW 測試模式');
  main().then(() => {
    const target = process.env.RUN_NOW_TARGET || 'stock';
    if (target === 'news') runNewsReport();
    else                   runStockReport();
  });
} else {
  main().catch(e => { console.error('❌ 主程式崩潰:', e); process.exit(1); });
}
