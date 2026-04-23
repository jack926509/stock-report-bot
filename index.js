// ═══════════════════════════════════════════════════════════
// 美股日報 + 新聞快訊 機器人 v5.3
//
// ─── 雙通報架構 ─────────────────────────────────────────
//  📊 訊息一：美股日報（07:30，週一至週五）
//     ① Yahoo Finance 即時股價 + Finnhub 備援
//     ② 非交易日自動跳過（完整美股休市日計算）
//     ③ API 失敗自動重試
//     ④ RSI / MA20 / MA50 / 布林通道技術指標
//     ⑤ 漲跌幅排行榜（程式計算，Top5/Bottom5）
//     ⑥ 財報日曆（本週池內個股）
//     ⑦ Finnhub 財經新聞分析（MAG7 + 異動個股）
//     ⑧ 市場廣度摘要（上漲/下跌統計 + 產業強弱）
//     ⑨ GPT-4o 宏觀分析（8 章節格式）
//
//  ⚡ 訊息二：美股新聞快訊（07:35，週一至週五）
//     ① Finnhub 市場新聞 + 個股新聞（80+ 支）
//     ② Yahoo Finance 備援個股新聞
//     ③ GPT-4o-mini 評分篩選（≥4 分才推播）
//     ④ 依大盤事件 / 個股快訊分組
//
// ─── v5.0 改善 ──────────────────────────────────────────
//  ✅ 移除 Notion 整合（簡化依賴）
//  ✅ 加入 uncaughtException / unhandledRejection 全局防護
//  ✅ 看門狗心跳 log（每分鐘，方便 Zeabur 監控）
//  ✅ /ping /stock /news 指令（隨時確認存活 + 手動觸發）
//  ✅ HTTP 健康檢查 server（供 Zeabur keepalive）
//  ✅ Telegram 訊息超長自動切分（4096 字元限制）
//  ✅ 整合進單一進程，不再需要 n8n
//
// ─── v5.2 改善 ──────────────────────────────────────────
//  ✅ OpenAI client 單例化（減少重複建立開銷）
//  ✅ Finnhub HTTP 請求去重（提取共用 finnhubGet）
//  ✅ 批次並行抓取（collectFlashNews / fetchKeyStockNews）
//  ✅ Telegram 發送加入指數退避重試（最多 3 次）
//  ✅ 完善美股休市日清單（含浮動假日計算）
//  ✅ 版本號統一為 v5.2
//  ✅ 報告執行鎖（防止 cron + 手動重複觸發）
//  ✅ 日期格式化共用函式（消除 4 處重複）
//  ✅ Graceful shutdown（SIGTERM/SIGINT 優雅關閉）
//
// ─── v5.3 改善 ──────────────────────────────────────────
//  ✅ 移除 AI 科技新聞功能（減少 API 使用量）
//  ✅ 移除 rss-parser 依賴
//  ✅ 新增市場廣度摘要（上漲/下跌統計、漲跌比、RSI 超買超賣）
//  ✅ 新增產業表現排行（8 大產業平均漲跌幅 + 上漲比例）
//  ✅ GPT prompt 強化數據分析（廣度背離偵測、產業輪動引用）
//  ✅ 新聞快訊加入指數快照（一眼掌握大盤）
//  ✅ 快訊排程提前至 07:35
// ═══════════════════════════════════════════════════════════

'use strict';

const OpenAI       = require('openai');
const cron         = require('node-cron');
const https        = require('https');
const http         = require('http');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const { runAgentsForSymbols, formatAgentSignals } = require('./agents/index');
const { fetchMacroContext, fetchStockCatalyst } = require('./agents/perplexity');

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
const FLASH_SCHEDULE = '35 7 * * 1-5';
const NEWS_MARKET_LIMIT = 20;
const NEWS_STOCK_LIMIT  = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

// OpenAI client 單例（避免每次呼叫重新建立）
const openaiClient = new OpenAI({ apiKey: OPENAI_KEY });

// 報告執行鎖（防止同一報告被重複觸發）
const runningLocks = { stock: false, flash: false };
const LOCK_TIMEOUT_MS = 12 * 60 * 1000; // 12 分鐘後強制釋放鎖

// 技術指標參數常數
const RSI_PERIOD = 14;
const BB_PERIOD  = 20;
const MA_SHORT   = 20;
const MA_LONG    = 50;

// 批次並行執行工具（每批 batchSize 個，批次間休息 delayMs）
async function batchParallel(items, fn, batchSize = 5, delayMs = 300) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) await sleep(delayMs);
  }
  return results;
}

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
// Finnhub 共用 HTTP GET（消除重複樣板）
// ─────────────────────────────────────────────
function finnhubGet(apiPath) {
  return new Promise((resolve) => {
    if (!FINNHUB_KEY) { resolve(null); return; }
    const fullPath = `${apiPath}${apiPath.includes('?') ? '&' : '?'}token=${FINNHUB_KEY}`;
    https.get({ hostname: 'finnhub.io', path: fullPath }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─────────────────────────────────────────────
// Finnhub 新聞
// ─────────────────────────────────────────────
async function fetchFinnhubNews() {
  if (!FINNHUB_KEY) return [];
  const now       = new Date();
  const today     = now.toISOString().split('T')[0];
  const yesterday = new Date(now - 86400000).toISOString().split('T')[0];
  const articles  = await finnhubGet(`/api/v1/news?category=general&from=${yesterday}&to=${today}`);
  if (!Array.isArray(articles)) return [];
  const headlines = articles
    .filter(a => a.headline && a.headline.length > 10)
    .slice(0, NEWS_MARKET_LIMIT)
    .map(a => `• ${a.headline}`);
  log('FINNHUB', `取得 ${headlines.length} 條市場新聞`);
  return headlines;
}

async function fetchStockNews(symbol) {
  if (!FINNHUB_KEY) return [];
  const now       = new Date();
  const today     = now.toISOString().split('T')[0];
  const yesterday = new Date(now - 86400000).toISOString().split('T')[0];
  const articles  = await finnhubGet(`/api/v1/company-news?symbol=${symbol}&from=${yesterday}&to=${today}`);
  if (!Array.isArray(articles)) return [];
  return articles.slice(0, NEWS_STOCK_LIMIT).map(a => a.headline).filter(Boolean);
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
  const targetList = [...targets.entries()];
  const results = await batchParallel(
    targetList,
    async ([symbol]) => ({ symbol, headlines: await fetchStockNews(symbol) }),
    5, 300
  );
  const newsMap = {};
  for (const { symbol, headlines } of results) {
    if (headlines.length > 0) newsMap[symbol] = { name: targets.get(symbol), headlines };
  }
  log('FINNHUB', `取得 ${Object.keys(newsMap).length} 支個股新聞`);
  return newsMap;
}

// ─────────────────────────────────────────────
// Finnhub 股票報價備援
// ─────────────────────────────────────────────
async function fetchQuoteFromFinnhub(symbol) {
  const q = await finnhubGet(`/api/v1/quote?symbol=${encodeURIComponent(symbol)}`);
  if (!q || q.c == null || q.c === 0) return null;
  return {
    symbol, price: q.c, change: q.d ?? null, changePct: q.dp ?? null,
    prevClose: q.pc ?? null, open: q.o ?? null, high: q.h ?? null, low: q.l ?? null,
    volume: null, avgVolume: null, marketCap: null,
    fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, earningsDate: null,
    shortName: symbol, _source: 'Finnhub',
  };
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
// 市場廣度摘要（程式計算）
// ─────────────────────────────────────────────
function buildMarketBreadth(marketData) {
  const allStocks = [
    ...marketData.mag7,
    ...Object.values(marketData.sectorStocks).flat(),
  ].filter(s => s.quote?.changePct != null);

  // 去重
  const seen = new Set();
  const unique = allStocks.filter(s => {
    if (seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });

  const advancing  = unique.filter(s => s.quote.changePct > 0).length;
  const declining   = unique.filter(s => s.quote.changePct < 0).length;
  const unchanged   = unique.length - advancing - declining;
  const bigMoversUp = unique.filter(s => s.quote.changePct >= 3).length;
  const bigMoversDn = unique.filter(s => s.quote.changePct <= -3).length;
  const avgPct      = unique.length > 0
    ? unique.reduce((sum, s) => sum + s.quote.changePct, 0) / unique.length : 0;

  // RSI 超買超賣統計
  const withRsi     = unique.filter(s => s.indicators?.rsi14 != null);
  const overbought  = withRsi.filter(s => s.indicators.rsi14 >= 70).length;
  const oversold    = withRsi.filter(s => s.indicators.rsi14 <= 30).length;

  // 量能異常（均量 2x 以上）
  const highVolume = unique.filter(s => {
    const vr = s.quote.volume && s.quote.avgVolume ? s.quote.volume / s.quote.avgVolume : 0;
    return vr >= 2;
  });

  // 產業強弱排序
  const sectorPerf = {};
  for (const [sector, stocks] of Object.entries(marketData.sectorStocks)) {
    const valid = stocks.filter(s => s.quote?.changePct != null);
    if (valid.length === 0) continue;
    const avg = valid.reduce((sum, s) => sum + s.quote.changePct, 0) / valid.length;
    const up  = valid.filter(s => s.quote.changePct > 0).length;
    sectorPerf[sector] = { avg, up, total: valid.length };
  }
  const sortedSectors = Object.entries(sectorPerf).sort((a, b) => b[1].avg - a[1].avg);

  return { advancing, declining, unchanged, bigMoversUp, bigMoversDn, avgPct,
           overbought, oversold, highVolume, sortedSectors, total: unique.length };
}

function fmtBreadthSection(breadth) {
  const { advancing, declining, unchanged, bigMoversUp, bigMoversDn, avgPct,
          overbought, oversold, highVolume, sortedSectors, total } = breadth;

  const ratio = declining > 0 ? (advancing / declining).toFixed(2) : '∞';
  const sentiment = avgPct >= 1 ? '偏多' : avgPct <= -1 ? '偏空' : '中性';
  const sentimentEmoji = avgPct >= 1 ? '🟢' : avgPct <= -1 ? '🔴' : '⚪';

  let section = `<b>📊 市場廣度</b>（${total} 支個股）\n`;
  section += `  ${sentimentEmoji} 整體：<code>${avgPct >= 0 ? '+' : ''}${avgPct.toFixed(2)}%</code>（${sentiment}）`;
  section += `  漲跌比 <code>${advancing}:${declining}</code>（${ratio}）\n`;
  section += `  📈 上漲 <code>${advancing}</code>  📉 下跌 <code>${declining}</code>  ➖ 持平 <code>${unchanged}</code>`;
  if (bigMoversUp > 0 || bigMoversDn > 0) {
    section += `\n  🔥 大漲（≥3%）<code>${bigMoversUp}</code>  💀 大跌（≤-3%）<code>${bigMoversDn}</code>`;
  }
  if (overbought > 0 || oversold > 0) {
    section += `\n  ⚠️ RSI 超買 <code>${overbought}</code>  RSI 超賣 <code>${oversold}</code>`;
  }
  if (highVolume.length > 0) {
    const names = highVolume.slice(0, 5).map(s => `<code>${s.symbol}</code>`).join(' ');
    section += `\n  📦 量能異常（≥2x）：${names}${highVolume.length > 5 ? ` +${highVolume.length - 5}` : ''}`;
  }

  // 產業強弱
  section += '\n\n<b>🏭 產業表現</b>\n';
  for (const [sector, perf] of sortedSectors) {
    const emoji = perf.avg >= 1 ? '🟢' : perf.avg <= -1 ? '🔴' : '⚪';
    section += `  ${emoji} ${sector}  <code>${perf.avg >= 0 ? '+' : ''}${perf.avg.toFixed(2)}%</code>  （${perf.up}/${perf.total} 上漲）\n`;
  }

  return section;
}

// ─────────────────────────────────────────────
// 格式化工具
// ─────────────────────────────────────────────
function fmtDateHeader() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = now.toLocaleDateString('zh-TW', { weekday: 'long' });
  const timeStr = now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  return { dateStr, weekday, timeStr };
}
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
  if (!closes || closes.length < RSI_PERIOD + 1) return null;
  const last    = closes[closes.length - 1];
  const rsi14   = calcRSI(closes, RSI_PERIOD);
  const ma20    = calcSMA(closes, MA_SHORT);
  const ma50    = calcSMA(closes, MA_LONG);
  const boll    = calcBollinger(closes, BB_PERIOD);
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
    const parts = [];
    if (ind.rsi14   != null) parts.push(`RSI <b>${ind.rsi14.toFixed(0)}</b>${ind.rsi14 >= 70 ? '🔥' : ind.rsi14 <= 30 ? '🧊' : ''}`);
    if (ind.ma20pct != null) parts.push(`MA20 <b>${ind.ma20pct >= 0 ? '+' : ''}${ind.ma20pct.toFixed(1)}%</b>`);
    return parts.length ? `\n     ${parts.join(' · ')}` : '';
  };

  const fmtRankRow = (s, badge) => {
    const vr = volumeRatio(s.quote.volume, s.quote.avgVolume);
    let row = `${badge} <b>${s.name}</b>（<code>${s.symbol}</code>）`;
    row += `  <b>${fmtPct(s.quote.changePct)}</b>  $${fmt(s.quote.price)}`;
    if (vr && parseFloat(vr) >= 1.5) row += `  📦 ${vr}x`;
    row += `  <i>${s.sector}</i>`;
    row += fmtRankInd(s.indicators);
    return row + '\n';
  };

  let section = '<b>🏆 漲跌幅排行</b>\n\n';
  section += '📈 <b>漲幅 TOP 5</b>\n';
  const upMedals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  top5.forEach((s, i) => { section += fmtRankRow(s, upMedals[i]); });

  section += '\n📉 <b>跌幅 TOP 5</b>\n';
  const downNums = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  bot5.forEach((s, i) => { section += fmtRankRow(s, downNums[i]); });

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
  let section = '<b>📅 本週財報預告</b>\n';
  for (const s of upcoming) {
    section += `  📌 <b>${s.name}</b>（<code>${s.symbol}</code>）— ${s.dateStr}\n`;
  }
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
function buildStockPrompt(marketData, newsHeadlines, stockNewsMap = {}, breadth = null, agentSection = '', macroContext = '', catalystMap = {}) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });
  const dataSection = buildMarketDataSection(marketData);
  const newsSection = newsHeadlines.length > 0
    ? `=== 今日財經新聞標題（昨日真實頭條）===\n${newsHeadlines.join('\n')}`
    : `=== 今日財經新聞 ===\n（新聞資料未取得，宏觀背景請只描述市場氛圍，不引用具體數字）`;
  const macroSection = macroContext
    ? `\n=== 今日宏觀即時資訊（Perplexity 即時搜尋）===\n${macroContext}\n`
    : '';
  let stockNewsSection = '';
  if (Object.keys(stockNewsMap).length > 0 || Object.keys(catalystMap).length > 0) {
    stockNewsSection = '\n=== 重點個股新聞 ===\n';
    const allSymbols = new Set([...Object.keys(stockNewsMap), ...Object.keys(catalystMap)]);
    for (const symbol of allSymbols) {
      const entry = stockNewsMap[symbol];
      const catalyst = catalystMap[symbol];
      const name = entry?.name || symbol;
      stockNewsSection += `\n【${name}（${symbol}）】\n`;
      if (catalyst) stockNewsSection += `📡 即時催化劑：${catalyst}\n`;
      entry?.headlines?.forEach(h => { stockNewsSection += `• ${h}\n`; });
    }
  }

  // 廣度數據文字（給 GPT 參考）
  let breadthText = '';
  if (breadth) {
    breadthText = `\n=== 市場廣度統計（程式已計算，請引用） ===
池內 ${breadth.total} 支個股：上漲 ${breadth.advancing} / 下跌 ${breadth.declining} / 持平 ${breadth.unchanged}
池均漲跌幅：${breadth.avgPct >= 0 ? '+' : ''}${breadth.avgPct.toFixed(2)}%
大漲（≥3%）${breadth.bigMoversUp} 支 / 大跌（≤-3%）${breadth.bigMoversDn} 支
RSI 超買（≥70）${breadth.overbought} 支 / RSI 超賣（≤30）${breadth.oversold} 支
量能異常（≥2x）${breadth.highVolume.length} 支${breadth.highVolume.length > 0 ? '：' + breadth.highVolume.slice(0, 8).map(s => s.symbol).join(', ') : ''}
產業強弱排序（平均漲跌幅）：
${breadth.sortedSectors.map(([name, p]) => `  ${name}: ${p.avg >= 0 ? '+' : ''}${p.avg.toFixed(2)}%（${p.up}/${p.total} 上漲）`).join('\n')}
`;
  }

  return `你是專業的美股市場分析師。以下是今天（${today}）的真實市場數據，請撰寫完整美股市場日報。

${dataSection}

${newsSection}
${macroSection}${stockNewsSection}
${breadthText}

=== 排版規範 ===
- 語言：繁體中文
- 格式：只用 Telegram HTML（<b> <i> <code>），禁止 Markdown 語法
- 直接輸出報告本文，不加說明前言
- 每個章節標題獨佔一行，標題後空一行再寫內容
- 章節之間空一行，保持閱讀節奏
- 數字用 <code> 標籤包裹使其突出（如 <code>+1.23%</code>、<code>$182.50</code>）
- 股票代碼用 <code> 標籤（如 <code>NVDA</code>）
- 每段文字控制在 2~3 句內，避免長段落壓迫感
- 善用 emoji 作為視覺錨點，但不過度堆疊

=== 分析要求 ===
你必須基於上方提供的真實數據撰寫，嚴禁虛構數字。
重點利用「市場廣度統計」判斷：
- 漲跌比判斷市場真實強弱（指數漲但多數個股跌 = 權值撐盤，實際偏弱）
- 產業強弱排序判斷資金輪動方向
- RSI 超買超賣數量判斷市場是否過熱或恐慌
- 量能異常個股值得特別提及
分析時對比指數表現與個股廣度是否一致，若出現背離（如指數微漲但六成個股下跌），必須明確指出。

=== 章節結構 ===

<b>📊 三大指數總覽</b>
每個指數一行，格式：emoji <b>名稱</b> <code>價格</code> <code>漲跌幅</code>
附 2~3 句解讀：指數表現 + 結合廣度數據的真實強弱判斷（如「指數收紅但池內僅 X 支上漲，實際盤面偏弱」）

<b>🔮 七巨頭動態</b>
最強/最弱各 1 支重點點評（2~3 句），其餘 5 支用精簡列表帶過
附 1 句：七巨頭整體對指數的拉抬或拖累效果

<b>🔥 昨日焦點個股</b>（最多 5 支，無異動可為 0）
篩選條件：漲跌>3%、量比>2x、距52週高/低±3%、有新聞催化、RSI 超買超賣、MA50 突破
每支格式：
📌 <b>[產業]｜[名稱]</b>（<code>代碼</code>）
   💰 <code>$價格</code>  emoji <code>漲跌幅</code>  📦 <code>均量倍數x</code>
   📊 RSI <code>值</code> · MA20 <code>±%</code> · MA50 <code>±%</code>（無數據略去）
   🔍 <b>焦點：</b>一句話催化劑
   📋 <b>背景：</b>兩句產業脈絡
   👁 <b>關注：</b>後市技術觀察點
禁止：支撐阻力位精確數字、捏造財報或分析師升降評

<b>📰 宏觀背景</b>
分項簡述：市場情緒 / 總經動態 / 財報季 / 外部因素（每項 1~2 句）

<b>🔄 產業輪動</b>
必須引用產業強弱排序數據，指出：
- 資金流入的產業（領漲 + 上漲比例高）
- 資金流出的產業（領跌 + 上漲比例低）
- 輪動趨勢解讀（防禦 vs 進攻、週期 vs 成長）

<b>🎯 後市三情境</b>
  🟢 <b>多頭：</b>觸發條件 + S&P 整數目標
  🔴 <b>空頭：</b>觸發條件 + S&P 整數支撐
  ⚪ <b>中性：</b>盤整區間 + 觀察重點

<b>⚠️ 本週風險雷達</b>
以列表呈現：重要經濟數據日期 + 最大不確定性（2~4 項）

<b>🗞️ 財經新聞分析</b>（3~5 則，無新聞寫「今日無重大財經新聞」）
每則格式：
▸ <b>標題摘要</b>
   相關個股漲跌 → 市場解讀（2 句內）
${agentSection ? `
<b>🤖 AI 投資人訊號（MAG7）</b>
以下是基本面/估值模型對七巨頭的量化評分，請根據技術面資料綜合解讀：
${agentSection}
每支股票用 1 句整合技術面與基本面給出綜合看法。` : ''}
最後不需要加免責聲明（系統會自動附加）。`;
}

// ─────────────────────────────────────────────
// 非交易日判斷
// ─────────────────────────────────────────────
// 美股休市日計算（含浮動假日）—— 結果按年快取，避免重複計算
const _holidayCache = new Map();
function getUSMarketHolidays(year) {
  if (_holidayCache.has(year)) return _holidayCache.get(year);
  const holidays = [];
  // 固定假日
  holidays.push(`${year}-01-01`); // 元旦
  holidays.push(`${year}-06-19`); // 六月節 Juneteenth
  holidays.push(`${year}-07-04`); // 獨立紀念日
  holidays.push(`${year}-12-25`); // 聖誕節

  // 浮動假日：第 N 個週一/週四
  const nthWeekday = (month, weekday, n) => {
    const first = new Date(year, month - 1, 1);
    let d = ((weekday - first.getDay()) + 7) % 7 + 1;
    d += (n - 1) * 7;
    return new Date(year, month - 1, d);
  };
  const lastWeekday = (month, weekday) => {
    const last = new Date(year, month, 0); // 月底
    const diff = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month - 1, last.getDate() - diff);
  };

  const mlk        = nthWeekday(1, 1, 3);  // 1月第3個週一：MLK Day
  const presidents = nthWeekday(2, 1, 3);  // 2月第3個週一：總統日
  const memorial   = lastWeekday(5, 1);    // 5月最後一個週一：陣亡將士紀念日
  const labor      = nthWeekday(9, 1, 1);  // 9月第1個週一：勞動節
  const thanksgiving = nthWeekday(11, 4, 4); // 11月第4個週四：感恩節

  for (const d of [mlk, presidents, memorial, labor, thanksgiving]) {
    holidays.push(d.toISOString().split('T')[0]);
  }

  // 耶穌受難日（復活節前2天，需計算）
  // 使用 Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const goodFriday = new Date(year, month - 1, day - 2);
  holidays.push(goodFriday.toISOString().split('T')[0]);

  // 固定假日若遇週六→週五休，遇週日→週一休
  const result = holidays.map(dateStr => {
    const dt = new Date(dateStr + 'T12:00:00');
    const dow = dt.getDay();
    if (dow === 6) dt.setDate(dt.getDate() - 1); // 週六 → 週五
    if (dow === 0) dt.setDate(dt.getDate() + 1); // 週日 → 週一
    return dt.toISOString().split('T')[0];
  });
  _holidayCache.set(year, result);
  return result;
}

function isTradingDay() {
  const now  = new Date();
  const day  = now.getDay();
  if (day === 0 || day === 6) { log('STOCK', '週末，跳過'); return false; }
  const todayStr = now.toISOString().split('T')[0];
  const holidays = getUSMarketHolidays(now.getFullYear());
  if (holidays.includes(todayStr)) {
    log('STOCK', `美股休市日（${todayStr}），跳過`);
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────
// 執行股市報告
// ─────────────────────────────────────────────
async function runStockReport() {
  if (!isTradingDay()) return;
  if (runningLocks.stock) { log('STOCK', '⚠️ 美股日報正在執行中，跳過重複觸發'); return; }
  runningLocks.stock = true;
  const lockTimer = setTimeout(() => { runningLocks.stock = false; log('STOCK', '⚠️ 執行逾時，強制釋放鎖'); }, LOCK_TIMEOUT_MS);
  const startTime = Date.now();
  log('STOCK', '🚀 開始執行美股日報');

  try {
    const hasPerplexity = !!(process.env.PERPLEXITY_API_KEY && process.env.DISABLE_PERPLEXITY !== 'true');

    // 宏觀搜尋：失敗時重試一次
    const macroFetch = hasPerplexity
      ? (async () => {
          try { return await fetchMacroContext(); } catch (e1) {
            await sleep(2000);
            return fetchMacroContext().catch(e2 => { log('STOCK', `宏觀搜尋失敗，略過：${e2.message}`); return null; });
          }
        })()
      : Promise.resolve(null);

    const [marketData, newsHeadlines, macroResult] = await Promise.all([
      fetchAllMarketData(),
      fetchFinnhubNews(),
      macroFetch,
    ]);

    const totalFetched = marketData.indices.length + marketData.mag7.length +
      Object.values(marketData.sectorStocks).reduce((a, b) => a + b.length, 0);

    if (totalFetched === 0) {
      log('STOCK', '❌ 所有數據源均失敗');
      await sendTelegram(`<b>⚠️ 美股日報無法生成</b>\n\n原因：所有股價數據源均無回應\n時間：${new Date().toLocaleString('zh-TW')}`);
      return;
    }

    const macroContext = macroResult?.text || '';
    if (macroContext) log('STOCK', '✅ 宏觀即時資訊取得');

    log('STOCK', '抓取重點個股新聞...');
    const stockNewsMap = await fetchKeyStockNews(marketData);

    const breadth         = buildMarketBreadth(marketData);
    const breadthSection  = fmtBreadthSection(breadth);

    // Perplexity 催化劑：漲跌幅 >3% 且 Finnhub 沒有已取得新聞的個股
    const catalystMap = {};
    if (hasPerplexity) {
      const allStocks = [...marketData.mag7, ...Object.values(marketData.sectorStocks).flat()];
      const bigMovers = allStocks
        .filter(s =>
          s.quote?.changePct != null &&
          Math.abs(s.quote.changePct) >= 3 &&
          !stockNewsMap[s.symbol]?.headlines?.length
        )
        .slice(0, 5);
      if (bigMovers.length > 0) {
        log('STOCK', `搜尋 ${bigMovers.length} 支異動股催化劑...`);
        await Promise.all(bigMovers.map(async s => {
          try {
            const r = await fetchStockCatalyst(s.symbol, s.name);
            if (r?.text) catalystMap[s.symbol] = r.text;
          } catch { /* 單支失敗不影響整體 */ }
        }));
        log('STOCK', `催化劑取得：${Object.keys(catalystMap).length} 支`);
      }
    }

    const rankingSection  = buildRankingSection(marketData);
    const earningsSection = buildEarningsSection(marketData);

    // AI 投資人 Agent（需 FMP_API_KEY，失敗不影響報告）
    let agentSection = '';
    if (process.env.FMP_API_KEY && process.env.DISABLE_AGENTS !== 'true') {
      try {
        log('STOCK', '執行 AI 投資人 Agent（MAG7）...');
        const agentResults = await runAgentsForSymbols(MAG7.map(s => s.symbol));
        agentSection = formatAgentSignals(agentResults);
        log('STOCK', `Agent 完成：${agentResults.filter(r => r.agents.length).length} 支有結果`);
      } catch (e) {
        log('STOCK', `Agent 執行失敗，略過：${e.message}`);
      }
    }

    log('STOCK', '呼叫 GPT-4o...');
    const prompt = buildStockPrompt(marketData, newsHeadlines, stockNewsMap, breadth, agentSection, macroContext, catalystMap);
    const report = await callOpenAI(prompt, 'gpt-4o', 4500);
    log('STOCK', `GPT 完成（${report.length} 字）`);

    const { dateStr, weekday, timeStr } = fmtDateHeader();
    const spx     = marketData.indices.find(x => x.symbol === '^GSPC');
    const vix     = marketData.indices.find(x => x.symbol === '^VIX');
    const dji     = marketData.indices.find(x => x.symbol === '^DJI');
    const ixic    = marketData.indices.find(x => x.symbol === '^IXIC');

    // 快速摘要列：三大指數 + VIX 一行看完
    const quickParts = [];
    if (spx?.quote?.changePct != null) quickParts.push(`S&P ${spx.quote.changePct >= 0 ? '▲' : '▼'}${Math.abs(spx.quote.changePct).toFixed(2)}%`);
    if (dji?.quote?.changePct != null) quickParts.push(`道瓊 ${dji.quote.changePct >= 0 ? '▲' : '▼'}${Math.abs(dji.quote.changePct).toFixed(2)}%`);
    if (ixic?.quote?.changePct != null) quickParts.push(`那指 ${ixic.quote.changePct >= 0 ? '▲' : '▼'}${Math.abs(ixic.quote.changePct).toFixed(2)}%`);
    if (vix?.quote?.price) quickParts.push(`VIX ${fmt(vix.quote.price)}`);

    const header = `<b>📈 美股日報</b>｜${dateStr} ${weekday}\n` +
      `<code>${quickParts.join('  ')}</code>\n` +
      `${'━'.repeat(24)}\n\n`;
    const sources = ['GPT-4o', 'Yahoo Finance'];
    if (FINNHUB_KEY) sources.push('Finnhub');
    if (macroContext) sources.push('Perplexity');
    const footer = `\n\n${'━'.repeat(24)}\n` +
      `<i>🤖 ${sources.join(' · ')}</i>\n` +
      `<i>⏱ ${timeStr} 發布 · 僅供參考，不構成投資建議</i>`;
    const programSection = '\n\n' + breadthSection + '\n\n' + rankingSection + (earningsSection ? '\n\n' + earningsSection : '');
    const fullReport = header + report + programSection + footer;

    const chunks = splitMessage(fullReport, 3800);
    log('STOCK', `發送 ${chunks.length} 段...`);
    for (let i = 0; i < chunks.length; i++) {
      let msg = chunks[i];
      if (chunks.length > 1) {
        msg += i < chunks.length - 1
          ? `\n\n<i>━ ${i + 1}/${chunks.length} ━ 續下則 ▸</i>`
          : `\n\n<i>━ ${i + 1}/${chunks.length} ━ 完 ━</i>`;
      }
      await sendTelegram(msg);
      if (i < chunks.length - 1) await sleep(1500);
    }
    log('STOCK', `✅ 完成，耗時 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } catch (err) {
    log('STOCK', `❌ 失敗：${err.message}`);
    await sendTelegram(`<b>❌ 美股日報執行失敗</b>\n\n<code>${err.message}</code>\n${new Date().toLocaleString('zh-TW')}`).catch(() => {});
  } finally {
    clearTimeout(lockTimer);
    runningLocks.stock = false;
  }
}

// ═══════════════════════════════════════════════════════════
// PART 2：美股新聞快訊（07:35，週一至週五）
//
// 每日整理前一交易日的重大美股新聞：
//  ① Finnhub 市場新聞（一般市場頭條）
//  ② Finnhub 個股新聞（MAG7 + 池內個股，僅高評分才納入）
//  ③ Yahoo Finance 個股新聞（補充 Finnhub 沒有的）
//  ④ GPT-4o-mini 評分過濾（≥4 分才推）+ 分類整理
//  ⑤ 依「大盤事件 / 個股快訊」分組推播
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// Yahoo Finance 個股新聞抓取
// 使用 yahooFinance.search() 的 news 結果
// ─────────────────────────────────────────────
async function fetchYahooStockNews(symbol, maxItems = 5) {
  try {
    const result = await yahooFinance.search(symbol, { newsCount: maxItems }, { validateResult: false });
    const now    = new Date();
    const cutoff = new Date(now - 48 * 3600 * 1000); // 48小時內（美股昨日盤面）
    return (result?.news || [])
      .filter(n => n.title && new Date(n.providerPublishTime * 1000) > cutoff)
      .slice(0, maxItems)
      .map(n => ({
        title:    n.title,
        link:     n.link || '',
        source:   n.publisher || 'Yahoo Finance',
        symbol,
        pubTime:  n.providerPublishTime * 1000,
      }));
  } catch { return []; }
}

// ─────────────────────────────────────────────
// 收集快訊新聞原料
// 來源：Finnhub 市場新聞 + Finnhub/Yahoo 個股新聞
// 對象：MAG7 + 所有池內個股（80支）
// ─────────────────────────────────────────────
async function collectFlashNews() {
  log('FLASH', '開始收集快訊新聞原料...');

  // 1. Finnhub 市場大盤新聞（昨日）
  const marketNews = await fetchFinnhubNews();
  log('FLASH', `Finnhub 市場新聞：${marketNews.length} 條`);

  // 2. 收集所有目標個股清單（MAG7 + 8 大產業池，去重）
  const allSymbols = new Map();
  for (const s of MAG7) allSymbols.set(s.symbol, s.name);
  for (const stocks of Object.values(SECTOR_STOCKS)) {
    for (const s of stocks) allSymbols.set(s.symbol, s.name);
  }

  // 3. 個股新聞：Finnhub 優先，失敗或空則補 Yahoo Finance（批次並行）
  const symbolList = [...allSymbols.entries()];
  const batchResults = await batchParallel(symbolList, async ([symbol, name]) => {
    // Finnhub 個股新聞
    if (FINNHUB_KEY) {
      const headlines = await fetchStockNews(symbol);
      if (headlines.length > 0) {
        return headlines.map(title => ({ title, link: '', source: 'Finnhub', symbol, name, pubTime: Date.now() }));
      }
    }
    // 備援：Yahoo Finance 個股新聞
    const yahooNews = await fetchYahooStockNews(symbol, 3);
    return yahooNews.map(n => ({ ...n, name }));
  }, 5, 300);

  const stockArticles = batchResults.flat();
  log('FLASH', `個股新聞原料：${stockArticles.length} 條（${allSymbols.size} 支個股）`);
  return { marketNews, stockArticles };
}

// ─────────────────────────────────────────────
// GPT-4o-mini 分析快訊：評分 + 分類
// 只回傳評分 ≥ 4 的新聞
// ─────────────────────────────────────────────
async function analyzeFlashNews(marketNews, stockArticles) {
  // 市場新聞處理（直接用 GPT 篩選重要條目）
  const marketPrompt = marketNews.length > 0
    ? `以下是昨日美股市場新聞標題，請篩選出最重要的 3~5 條並回傳 JSON。
評分：5=Fed/CPI/重大地緣/系統性風險，4=重要總經事件，3以下忽略。
回傳純 JSON（不要其他文字）：
{"items":[{"title":"原始標題","summary_zh":"繁中摘要20字內","importance":5,"category":"Fed政策|通膨|地緣|財報|市場結構"}]}

新聞：
${marketNews.slice(0, 30).join('\n')}`
    : null;

  // 個股新聞處理（去重 + 批次評分）
  const dedupedStock = [];
  const seenTitles   = new Set();
  for (const a of stockArticles) {
    const key = a.title.slice(0, 50); // 前50字去重
    if (!seenTitles.has(key)) {
      seenTitles.add(key);
      dedupedStock.push(a);
    }
  }

  // 只取前 60 條給 GPT（避免超過 token 上限）
  const stockSample = dedupedStock.slice(0, 60);
  const stockText   = stockSample.map((a, i) =>
    `[${i + 1}] ${a.name}(${a.symbol}): ${a.title}`
  ).join('\n');

  const stockPrompt = `以下是昨日美股個股新聞，請評分並篩選重要條目回傳 JSON。
評分：5=重大財報/產品發布/CEO異動/重大訴訟，4=業績預警/升降評/併購，3以下忽略。
只回傳評分 ≥ 4 的條目，最多 10 條。
回傳純 JSON（不要其他文字）：
{"items":[{"id":1,"symbol":"NVDA","name":"Nvidia","summary_zh":"繁中摘要25字內","importance":5,"category":"財報|升評|降評|產品|法規|併購|人事|其他"}]}

個股新聞：
${stockText}`;

  // 並行呼叫兩個 GPT 分析
  const [marketResult, stockResult] = await Promise.all([
    marketPrompt ? callOpenAI(marketPrompt, 'gpt-4o-mini', 1000).then(r => {
      try { return JSON.parse(r.replace(/```json|```/g, '').trim()); } catch { return { items: [] }; }
    }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),

    callOpenAI(stockPrompt, 'gpt-4o-mini', 1500).then(r => {
      try { return JSON.parse(r.replace(/```json|```/g, '').trim()); } catch { return { items: [] }; }
    }).catch(() => ({ items: [] })),
  ]);

  log('FLASH', `篩選結果：大盤 ${marketResult.items?.length || 0} 條 / 個股 ${stockResult.items?.length || 0} 條`);
  return {
    market: marketResult.items || [],
    stocks: (stockResult.items || []).filter(x => x.importance >= 4),
  };
}

// ─────────────────────────────────────────────
// 組合快訊 Telegram 訊息
// ─────────────────────────────────────────────
function buildFlashMessage(analyzed, indexSnapshot = []) {
  const { dateStr, weekday, timeStr } = fmtDateHeader();

  const totalCount = analyzed.market.length + analyzed.stocks.length;
  let msg = `<b>⚡ 美股新聞快訊</b>｜${dateStr} ${weekday}\n`;
  msg += `${'━'.repeat(24)}\n`;

  // ── 指數快照 ──
  if (indexSnapshot.length > 0) {
    msg += '\n';
    for (const { name, quote: q } of indexSnapshot) {
      const emoji = q.changePct >= 0 ? '▲' : '▼';
      msg += `${trendEmoji(q.changePct)} <b>${name}</b> <code>${fmt(q.price)}</code> ${emoji}<code>${Math.abs(q.changePct).toFixed(2)}%</code>\n`;
    }
  }

  // ── 大盤事件 ──
  msg += `\n<b>🌐 大盤事件</b>\n`;
  if (analyzed.market.length > 0) {
    for (const item of analyzed.market) {
      const badge = item.importance === 5 ? '🔺' : '▸';
      msg += `${badge} <b>${item.summary_zh}</b>`;
      if (item.category) msg += `  <i>${item.category}</i>`;
      msg += '\n';
    }
  } else {
    msg += `  <i>昨日無重大總經或地緣事件</i>\n`;
  }

  // ── 個股快訊 ──
  msg += `\n<b>📌 個股快訊</b>\n`;
  if (analyzed.stocks.length > 0) {
    const sorted = [...analyzed.stocks].sort((a, b) => b.importance - a.importance);
    for (const item of sorted) {
      const badge = item.importance === 5 ? '🔺' : '▸';
      msg += `${badge} <b>${item.name}</b>（<code>${item.symbol}</code>）`;
      if (item.category) msg += `  <i>${item.category}</i>`;
      msg += `\n   ${item.summary_zh}\n`;
    }
  } else {
    msg += `  <i>昨日池內個股無重大事件</i>\n`;
  }

  msg += `\n${'━'.repeat(24)}\n`;
  msg += `<i>⚡ ${totalCount} 則重要新聞 · ${timeStr} 發布</i>\n`;
  msg += `<i>來源：Finnhub / Yahoo Finance · 僅供參考</i>`;
  return msg;
}

// ─────────────────────────────────────────────
// 執行快訊報告
// ─────────────────────────────────────────────
async function runFlashReport() {
  if (!isTradingDay()) return;
  if (runningLocks.flash) { log('FLASH', '⚠️ 美股新聞快訊正在執行中，跳過重複觸發'); return; }
  runningLocks.flash = true;
  const lockTimerFlash = setTimeout(() => { runningLocks.flash = false; log('FLASH', '⚠️ 執行逾時，強制釋放鎖'); }, LOCK_TIMEOUT_MS);
  const startTime = Date.now();
  log('FLASH', '🚀 開始執行美股新聞快訊');

  try {
    // 同時抓取新聞和指數快照
    const [{ marketNews, stockArticles }, indexQuotes] = await Promise.all([
      collectFlashNews(),
      Promise.all(INDICES.map(s => fetchQuote(s.symbol))),
    ]);

    if (marketNews.length === 0 && stockArticles.length === 0) {
      log('FLASH', '無任何新聞原料，跳過推播');
      return;
    }

    log('FLASH', '分析新聯重要性...');
    const analyzed = await analyzeFlashNews(marketNews, stockArticles);

    // 若大盤和個股都沒有高分新聞，靜默跳過（不發空訊息）
    if (analyzed.market.length === 0 && analyzed.stocks.length === 0) {
      log('FLASH', '無高重要性新聞（≥4分），今日跳過推播');
      return;
    }

    // 附加指數快照
    const indexSnapshot = INDICES.map((s, i) => ({ ...s, quote: indexQuotes[i] })).filter(x => x.quote);
    const message = buildFlashMessage(analyzed, indexSnapshot);
    const chunks  = splitMessage(message, 3800);
    for (let i = 0; i < chunks.length; i++) {
      await sendTelegram(chunks[i]);
      if (i < chunks.length - 1) await sleep(1000);
    }

    log('FLASH', `✅ 完成，耗時 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } catch (err) {
    log('FLASH', `❌ 失敗：${err.message}`);
    await sendTelegram(`<b>❌ 美股新聞快訊執行失敗</b>\n\n<code>${err.message}</code>\n${new Date().toLocaleString('zh-TW')}`).catch(() => {});
  } finally {
    clearTimeout(lockTimerFlash);
    runningLocks.flash = false;
  }
}

// ═══════════════════════════════════════════════════════════
// 共用工具
// ═══════════════════════════════════════════════════════════

async function callOpenAI(prompt, model = 'gpt-4o', maxTokens = 2000, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      log('OPENAI', `呼叫 ${model}（第 ${i} 次）...`);
      const res = await openaiClient.chat.completions.create({
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

async function sendTelegram(text, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await sendRawTelegram(text, 'HTML');
    } catch (err) {
      // HTML 解析失敗 → 降級純文字（不重試）
      if (err.message.includes("can't parse") || err.message.includes('Bad Request')) {
        log('TG', '⚠️ HTML 失敗，降級純文字');
        return await sendRawTelegram(text.replace(/<[^>]+>/g, ''), null);
      }
      // 網路/限速錯誤 → 指數退避重試
      if (attempt < retries) {
        const delay = attempt * 2000;
        log('TG', `⚠️ 發送失敗（第 ${attempt} 次），${delay / 1000}s 後重試：${err.message}`);
        await sleep(delay);
      } else {
        log('TG', `❌ 發送失敗（已重試 ${retries} 次）：${err.message}`);
        throw err;
      }
    }
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
  const SECTION_RE = /(?=\n<b>[📊🔮🏆🔥📅📰🔄🎯⚠️🗞️🌐📌⚡])/g;
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
          const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          const uptime = Math.floor(process.uptime());
          const uptimeStr = uptime >= 3600
            ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
            : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
          await sendTelegram(
            `<b>🟢 系統狀態</b>\n` +
            `${'━'.repeat(20)}\n` +
            `  版本　 <code>v5.3</code>\n` +
            `  狀態　 正常運作中\n` +
            `  記憶體 <code>${mem} MB</code>\n` +
            `  運行　 <code>${uptimeStr}</code>\n` +
            `  時間　 ${new Date().toLocaleString('zh-TW', { timeZone: TIMEZONE })}`
          );
        } else if (text === '/stock') {
          await sendTelegram('⏳ <b>美股日報</b>生成中，請稍候...');
          runStockReport().catch(e => log('STOCK', `手動失敗: ${e.message}`));
        } else if (text === '/flash') {
          await sendTelegram('⏳ <b>美股新聞快訊</b>生成中，請稍候...');
          runFlashReport().catch(e => log('FLASH', `手動失敗: ${e.message}`));
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
    res.end(JSON.stringify({ status: 'ok', version: 'v5.3', time: new Date().toISOString() }));
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

// ─────────────────────────────────────────────
// Graceful Shutdown（讓進行中的報告完成後再退出）
// ─────────────────────────────────────────────
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('MAIN', `⚠️ 收到 ${signal}，準備優雅關閉...`);

  // 等待進行中的報告完成（最多等 60 秒）
  const maxWait = 60000;
  const start   = Date.now();
  while (Object.values(runningLocks).some(Boolean) && Date.now() - start < maxWait) {
    const running = Object.entries(runningLocks).filter(([, v]) => v).map(([k]) => k);
    log('MAIN', `等待報告完成：${running.join(', ')}...`);
    await sleep(3000);
  }

  log('MAIN', '👋 Bot 已關閉');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ═══════════════════════════════════════════════════════════
// 主程式
// ═══════════════════════════════════════════════════════════
async function main() {
  log('MAIN', '🚀 美股日報 Bot v5.3 啟動');

  cron.schedule(STOCK_SCHEDULE, () => {
    log('CRON', '⏰ 觸發美股日報排程');
    runStockReport().catch(e => log('STOCK', `排程失敗: ${e.message}`));
  }, { timezone: TIMEZONE });

  cron.schedule(FLASH_SCHEDULE, () => {
    log('CRON', '⏰ 觸發美股新聞快訊排程');
    runFlashReport().catch(e => log('FLASH', `排程失敗: ${e.message}`));
  }, { timezone: TIMEZONE });

  log('MAIN', `📊 美股日報：${STOCK_SCHEDULE} (Asia/Taipei)`);
  log('MAIN', `⚡ 美股快訊：${FLASH_SCHEDULE} (Asia/Taipei)`);

  startWatchdog();
  startHealthServer();
  startPolling();

  await sendTelegram(
    `<b>🟢 Bot v5.3 已啟動</b>\n` +
    `${'━'.repeat(20)}\n\n` +
    `<b>📋 每日排程</b>（週一至週五）\n` +
    `  <code>07:30</code>  📈 美股日報\n` +
    `  <code>07:35</code>  ⚡ 美股新聞快訊\n\n` +
    `<b>🎮 指令</b>\n` +
    `  /ping — 系統狀態\n` +
    `  /stock — 觸發美股日報\n` +
    `  /flash — 觸發新聞快訊`
  );

  log('MAIN', '✅ 所有服務啟動完成，等待排程中...');
}

if (process.env.RUN_NOW === 'true') {
  log('MAIN', '⚡ RUN_NOW 測試模式');
  main().then(() => {
    const target = process.env.RUN_NOW_TARGET || 'stock';
    if (target === 'flash') runFlashReport();
    else                    runStockReport();
  });
} else {
  main().catch(e => { console.error('❌ 主程式崩潰:', e); process.exit(1); });
}
