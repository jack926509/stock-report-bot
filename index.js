// ═══════════════════════════════════════════════════════════
// 美股日報 + 新聞快訊 機器人 v6.0（Slack）
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
//  ✅ /ping /stock /flash 指令（隨時確認存活 + 手動觸發）
//  ✅ HTTP 健康檢查 server（供 Zeabur keepalive）
//  ✅ 訊息超長自動切分（依平台字數上限）
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
//
// ─── v5.4 改善 ──────────────────────────────────────────
//  ✅ 新增 Discord 平台支援（MESSAGING_PLATFORM=discord）
//  ✅ Discord 原生斜線指令 /ping /stock /flash（DISCORD_GUILD_ID 可即時生效）
//  ✅ ! 前綴指令改為可選（DISCORD_ENABLE_PREFIX_COMMANDS），純斜線指令免開 MESSAGE CONTENT INTENT
//  ✅ 產業個股改為分組並行抓取（縮短日報資料抓取時間）
//  ✅ 版本字串統一為 APP_VERSION 常數
//
// ─── v5.5 改善（對齊「彙整前一交易日」的目標）────────────
//  ✅ 報告對象固定為「最近一個已收盤的美股交易日」（以美東時間計算，跳週末＋假日）
//     — 修正：UTC 伺服器上週一報告被誤跳、週五盤面從不被彙整的問題
//  ✅ 新聞抓取視窗 / GPT prompt / 報告標題全部對齊該交易日（不再是 UTC 昨天-今天）
//  ✅ Finnhub 個股新聞改用真實 datetime；Yahoo 新聞依交易日過濾
//  ✅ 報告 footer 揭露報價覆蓋率；盤中手動觸發加警告
//  ✅ 同一交易日重複觸發自動去重（手動 /stock 與 RUN_NOW 不受限）
//  ✅ 新增本地狀態檔與每日快照（STATE_DIR，預設 ./data）
//
// ─── v6.0 改善 ──────────────────────────────────────────
//  ✅ 訊息平台改為 Slack（@slack/web-api + @slack/socket-mode）
//  ✅ 移除 Telegram / Discord 相關程式碼與依賴
//  ✅ 報告以 Block Kit 呈現（header + section + divider）
//  ✅ 斜線指令 /ping /stock /flash 走 Socket Mode（不需公開 URL）
// ═══════════════════════════════════════════════════════════

'use strict';

const fs           = require('fs');
const path         = require('path');
const OpenAI       = require('openai');
const cron         = require('node-cron');
const https        = require('https');
const http         = require('http');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const { runAgentsForSymbols, formatAgentSignals } = require('./agents/index');
const { fetchMacroContext, fetchStockCatalyst } = require('./agents/perplexity');

// ─────────────────────────────────────────────
// 訊息平台：Slack
// ─────────────────────────────────────────────
const PLATFORM = 'slack';

// ─────────────────────────────────────────────
// 環境變數驗證
// ─────────────────────────────────────────────
function validateEnv() {
  const missing = ['OPENAI_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL_ID']
    .filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ 缺少必要的環境變數（平台：${PLATFORM}）：${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.FINNHUB_API_KEY) {
    console.warn('⚠️  FINNHUB_API_KEY 未設定，Finnhub 新聞功能停用（不影響其他功能）');
  }
}

validateEnv();

const OPENAI_KEY        = process.env.OPENAI_API_KEY;
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN   = process.env.SLACK_APP_TOKEN;
const SLACK_CHANNEL_ID  = process.env.SLACK_CHANNEL_ID;
const FINNHUB_KEY       = process.env.FINNHUB_API_KEY || null;
const TIMEZONE          = 'Asia/Taipei';
const APP_VERSION       = 'v6.0';

// 切分訊息用的字數上限：Slack 單則 chat.postMessage text 上限約 40000、單一 section block 文字 3000。
// 為了讓多區段一次成圖（一則訊息一段報告），這裡設高一點，由 Block Kit 內部再分塊處理。
const MSG_LIMIT = 12000;

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
// fromYmd / toYmd 為美東日期字串；額外做一次 datetime 客端過濾（Finnhub general news 不一定理會 from/to）
async function fetchFinnhubNews(fromYmd, toYmd) {
  if (!FINNHUB_KEY) return [];
  const articles = await finnhubGet(`/api/v1/news?category=general&from=${fromYmd}&to=${toYmd}`);
  if (!Array.isArray(articles)) return [];
  const cutoffMs = Date.parse(`${fromYmd}T00:00:00-05:00`); // 約略以 EST 為界
  const headlines = articles
    .filter(a => a.headline && a.headline.length > 10)
    .filter(a => !a.datetime || a.datetime * 1000 >= cutoffMs)
    .slice(0, NEWS_MARKET_LIMIT)
    .map(a => `• ${a.headline}`);
  log('FINNHUB', `取得 ${headlines.length} 條市場新聞（${fromYmd}~${toYmd}）`);
  return headlines;
}

// 回傳 [{ headline, datetime }]（datetime 為 Unix 秒）
async function fetchStockNews(symbol, fromYmd, toYmd) {
  if (!FINNHUB_KEY) return [];
  const articles = await finnhubGet(`/api/v1/company-news?symbol=${symbol}&from=${fromYmd}&to=${toYmd}`);
  if (!Array.isArray(articles)) return [];
  return articles
    .filter(a => a.headline)
    .slice(0, NEWS_STOCK_LIMIT)
    .map(a => ({ headline: a.headline, datetime: a.datetime || null }));
}

async function fetchKeyStockNews(marketData, fromYmd, toYmd) {
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
    async ([symbol]) => ({ symbol, headlines: (await fetchStockNews(symbol, fromYmd, toYmd)).map(a => a.headline) }),
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

  log('STOCK', '抓取各產業個股（分組並行）...');
  const sectorResults = {};
  await batchParallel(Object.entries(SECTOR_STOCKS), async ([sector, stocks]) => {
    const quotes = await Promise.all(stocks.map(s => fetchQuote(s.symbol)));
    sectorResults[sector] = stocks.map((s, i) => ({ ...s, quote: quotes[i] })).filter(x => x.quote);
  }, 3, 300);
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

  log('STOCK', `計算技術指標（${indicatorTargets.size} 支，分批並行）...`);
  const indicatorMap = {};
  await batchParallel([...indicatorTargets], async (symbol) => {
    const closes = await fetchHistoricalCloses(symbol);
    if (closes) indicatorMap[symbol] = calculateIndicators(closes);
  }, 5, 200);
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
  const opts    = { timeZone: TIMEZONE };
  const dateStr = now.toLocaleDateString('zh-TW', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = now.toLocaleDateString('zh-TW', { ...opts, weekday: 'long' });
  const timeStr = now.toLocaleTimeString('zh-TW', { ...opts, hour: '2-digit', minute: '2-digit' });
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
function buildStockPrompt(marketData, newsHeadlines, stockNewsMap = {}, breadth = null, agentSection = '', macroContext = '', catalystMap = {}, sessionLabel = '最近交易日') {
  const dataSection = buildMarketDataSection(marketData);
  const newsSection = newsHeadlines.length > 0
    ? `=== 該交易日財經新聞頭條（真實標題）===\n${newsHeadlines.join('\n')}`
    : `=== 財經新聞 ===\n（新聞資料未取得，宏觀背景請只描述市場氛圍，不引用具體數字）`;
  const macroSection = macroContext
    ? `\n=== 該交易日宏觀即時資訊（Perplexity 即時搜尋）===\n${macroContext}\n`
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

  return `你是專業的美股市場分析師。以下是「${sessionLabel}」這個美股交易日的真實收盤數據，請撰寫該交易日的完整美股市場日報（用語以「該交易日／當日」描述，不要寫成「今天」）。

${dataSection}

${newsSection}
${macroSection}${stockNewsSection}
${breadthText}

=== 排版規範 ===
- 語言：繁體中文
- 格式：只用 HTML 標籤（<b> <i> <code>），禁止 Markdown 語法
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

// ── 美東時間工具：報告永遠以「最近一個已收盤的美股交易日」為對象 ──
const US_MARKET_CLOSE_HOUR = 16; // 16:00 ET 收盤（不處理早收盤等細節）
const ZH_WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

// 取得指定時間在美東時區的零件
function nyParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: +p.year, m: +p.month, d: +p.day,
    hour: (+p.hour) % 24,
    ymd: `${p.year}-${p.month}-${p.day}`,
    dow: dowMap[p.weekday],
  };
}

function ymdInfo(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return { y, dow: dt.getUTCDay(), isHoliday: getUSMarketHolidays(y).includes(ymd) };
}
function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split('T')[0];
}
function isUSTradingDay(ymd) {
  const { dow, isHoliday } = ymdInfo(ymd);
  return dow !== 0 && dow !== 6 && !isHoliday;
}

// 最近一個已收盤的美股交易日（美東日期字串 YYYY-MM-DD）
function lastUSTradingSession(now = new Date()) {
  const ny = nyParts(now);
  let ymd = ny.ymd;
  if (ny.hour < US_MARKET_CLOSE_HOUR) ymd = shiftYmd(ymd, -1);
  while (!isUSTradingDay(ymd)) ymd = shiftYmd(ymd, -1);
  return ymd;
}
// 今天的美東日期（用作新聞抓取視窗的上界）
function todayET(now = new Date()) { return nyParts(now).ymd; }

// 是否正逢美股盤中（約略 9:30–16:00 ET；用於手動觸發時提醒）
function isUSMarketOpenNow(now = new Date()) {
  const ny = nyParts(now);
  if (ny.dow === 0 || ny.dow === 6) return false;
  if (getUSMarketHolidays(ny.y).includes(ny.ymd)) return false;
  return ny.hour >= 9 && ny.hour < 16;
}

// 把交易日字串格式化成標題用的 { ymd, dateStr, weekday }
function fmtSessionDate(ymd) {
  const { dow } = ymdInfo(ymd);
  const [, m, d] = ymd.split('-').map(Number);
  return { ymd, dateStr: `${m}/${d}`, weekday: ZH_WEEKDAYS[dow] };
}

// ─────────────────────────────────────────────
// 執行狀態 / 每日快照（本地檔案；檔案系統唯讀時自動略過）
// ─────────────────────────────────────────────
const DATA_DIR   = process.env.STATE_DIR || './data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let _state = { lastStockSession: null, lastFlashSession: null };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      _state = { ..._state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
      log('STATE', `已載入：stock=${_state.lastStockSession || '-'} / flash=${_state.lastFlashSession || '-'}`);
    }
  } catch (e) { log('STATE', `載入狀態失敗（忽略）：${e.message}`); }
}
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
  } catch (e) { log('STATE', `寫入狀態失敗（忽略）：${e.message}`); }
}
function saveReportSnapshot(kind, sessionDate, payload) {
  try {
    const dir = path.join(DATA_DIR, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${sessionDate}-${kind}.json`),
      JSON.stringify({ kind, sessionDate, generatedAt: new Date().toISOString(), ...payload }, null, 2)
    );
    log('STATE', `已存快照 reports/${sessionDate}-${kind}.json`);
  } catch (e) { log('STATE', `寫入快照失敗（忽略）：${e.message}`); }
}

// ─────────────────────────────────────────────
// 執行股市報告
// ─────────────────────────────────────────────
async function runStockReport(force = false) {
  const sessionDate = lastUSTradingSession();
  const sess        = fmtSessionDate(sessionDate);
  const sessionLabel = `${sess.dateStr}（${sess.weekday}）`;

  if (!force && _state.lastStockSession === sessionDate) {
    log('STOCK', `本期（${sessionDate}）已產出過，跳過`);
    return;
  }
  if (runningLocks.stock) { log('STOCK', '⚠️ 美股日報正在執行中，跳過重複觸發'); return; }
  runningLocks.stock = true;
  const lockTimer = setTimeout(() => { runningLocks.stock = false; log('STOCK', '⚠️ 執行逾時，強制釋放鎖'); }, LOCK_TIMEOUT_MS);
  const startTime = Date.now();
  log('STOCK', `🚀 開始執行美股日報（交易日 ${sessionDate}）`);

  try {
    const newsTo        = todayET(); // 新聞視窗上界 = 美東今天（含當交易日後的隔日反應）
    const hasPerplexity = !!(process.env.PERPLEXITY_API_KEY && process.env.DISABLE_PERPLEXITY !== 'true');

    // 宏觀搜尋：失敗時重試一次
    const macroFetch = hasPerplexity
      ? (async () => {
          try { return await fetchMacroContext(sessionLabel); } catch (e1) {
            await sleep(2000);
            return fetchMacroContext(sessionLabel).catch(e2 => { log('STOCK', `宏觀搜尋失敗，略過：${e2.message}`); return null; });
          }
        })()
      : Promise.resolve(null);

    const [marketData, newsHeadlines, macroResult] = await Promise.all([
      fetchAllMarketData(),
      fetchFinnhubNews(sessionDate, newsTo),
      macroFetch,
    ]);

    const expectedCount = INDICES.length + MAG7.length +
      Object.values(SECTOR_STOCKS).reduce((a, b) => a + b.length, 0);
    const totalFetched = marketData.indices.length + marketData.mag7.length +
      Object.values(marketData.sectorStocks).reduce((a, b) => a + b.length, 0);
    const coveragePct = expectedCount > 0 ? Math.round(totalFetched / expectedCount * 100) : 0;

    if (totalFetched === 0) {
      log('STOCK', '❌ 所有數據源均失敗');
      await sendMessage(`<b>⚠️ 美股日報無法生成</b>（交易日 ${sessionDate}）\n\n原因：所有股價數據源均無回應\n時間：${new Date().toLocaleString('zh-TW', { timeZone: TIMEZONE })}`);
      return;
    }
    if (coveragePct < 50) log('STOCK', `⚠️ 報價覆蓋率偏低：${totalFetched}/${expectedCount}（${coveragePct}%）`);

    const macroContext = macroResult?.text || '';
    if (macroContext) log('STOCK', '✅ 宏觀即時資訊取得');

    log('STOCK', '抓取重點個股新聞...');
    const stockNewsMap = await fetchKeyStockNews(marketData, sessionDate, newsTo);

    const breadth         = buildMarketBreadth(marketData);
    const breadthSection  = fmtBreadthSection(breadth);

    // Perplexity 催化劑：該交易日漲跌幅 ≥3% 且 Finnhub 沒有已取得新聞的個股
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
            const r = await fetchStockCatalyst(s.symbol, s.name, sessionLabel);
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
    const prompt = buildStockPrompt(marketData, newsHeadlines, stockNewsMap, breadth, agentSection, macroContext, catalystMap, sessionLabel);
    const report = await callOpenAI(prompt, 'gpt-4o', 4500);
    log('STOCK', `GPT 完成（${report.length} 字）`);

    const { timeStr } = fmtDateHeader();
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

    const intradayNote = isUSMarketOpenNow()
      ? `<i>⚠️ 美股盤中觸發，以下為前一交易日 ${sessionLabel} 收盤資料</i>\n`
      : '';
    const header = `<b>📈 美股日報</b>｜${sess.dateStr}（${sess.weekday}）收盤\n` +
      intradayNote +
      `<code>${quickParts.join('  ')}</code>\n` +
      `${'━'.repeat(24)}\n\n`;
    const sources = ['GPT-4o', 'Yahoo Finance'];
    if (FINNHUB_KEY) sources.push('Finnhub');
    if (macroContext) sources.push('Perplexity');
    const coverageStr = `${coveragePct < 50 ? '⚠️ ' : ''}報價覆蓋 ${totalFetched}/${expectedCount}（${coveragePct}%）`;
    const footer = `\n\n${'━'.repeat(24)}\n` +
      `<i>🤖 ${sources.join(' · ')}｜${coverageStr}</i>\n` +
      `<i>⏱ ${timeStr}（台北）發布 · 資料為 ${sessionLabel} 美股收盤 · 僅供參考，不構成投資建議</i>`;
    const programSection = '\n\n' + breadthSection + '\n\n' + rankingSection + (earningsSection ? '\n\n' + earningsSection : '');
    const fullReport = header + report + programSection + footer;

    const chunks = splitMessage(fullReport, MSG_LIMIT);
    log('STOCK', `發送 ${chunks.length} 段...`);
    for (let i = 0; i < chunks.length; i++) {
      let msg = chunks[i];
      if (chunks.length > 1) {
        msg += i < chunks.length - 1
          ? `\n\n<i>━ ${i + 1}/${chunks.length} ━ 續下則 ▸</i>`
          : `\n\n<i>━ ${i + 1}/${chunks.length} ━ 完 ━</i>`;
      }
      await sendMessage(msg);
      if (i < chunks.length - 1) await sleep(1500);
    }

    // 持久化：記錄已產出 + 存當日快照（檔案系統唯讀時自動略過）
    _state.lastStockSession = sessionDate;
    saveState();
    saveReportSnapshot('stock', sessionDate, {
      coverage: { fetched: totalFetched, expected: expectedCount, pct: coveragePct },
      indices: marketData.indices.map(s => ({ symbol: s.symbol, name: s.name, price: s.quote?.price ?? null, changePct: s.quote?.changePct ?? null })),
      breadth: { ...breadth, highVolume: breadth.highVolume.map(s => s.symbol) },
      quotes: [...marketData.mag7, ...Object.values(marketData.sectorStocks).flat()]
        .map(s => ({ symbol: s.symbol, name: s.name, price: s.quote?.price ?? null, changePct: s.quote?.changePct ?? null })),
      gptReport: report,
    });

    log('STOCK', `✅ 完成，耗時 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } catch (err) {
    log('STOCK', `❌ 失敗：${err.message}`);
    await sendMessage(`<b>❌ 美股日報執行失敗</b>（交易日 ${sessionDate}）\n\n<code>${err.message}</code>\n${new Date().toLocaleString('zh-TW', { timeZone: TIMEZONE })}`).catch(() => {});
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
async function fetchYahooStockNews(symbol, sessionYmd, maxItems = 5) {
  try {
    const result = await yahooFinance.search(symbol, { newsCount: Math.max(maxItems, 8) }, { validateResult: false });
    // 只保留「被報告的交易日」當天 00:00 ET 起的新聞
    const cutoffMs = Date.parse(`${sessionYmd}T00:00:00-05:00`);
    return (result?.news || [])
      .filter(n => n.title && n.providerPublishTime * 1000 >= cutoffMs)
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
async function collectFlashNews(sessionYmd, toYmd) {
  log('FLASH', `開始收集快訊新聞原料（交易日 ${sessionYmd}）...`);

  // 1. Finnhub 市場大盤新聞（被報告的交易日起）
  const marketNews = await fetchFinnhubNews(sessionYmd, toYmd);
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
    if (FINNHUB_KEY) {
      const arts = await fetchStockNews(symbol, sessionYmd, toYmd);
      if (arts.length > 0) {
        return arts.map(a => ({
          title: a.headline, link: '', source: 'Finnhub', symbol, name,
          pubTime: a.datetime ? a.datetime * 1000 : null,
        }));
      }
    }
    // 備援：Yahoo Finance 個股新聞
    const yahooNews = await fetchYahooStockNews(symbol, sessionYmd, 3);
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
async function analyzeFlashNews(marketNews, stockArticles, sessionLabel = '最近交易日') {
  // 市場新聞處理（直接用 GPT 篩選重要條目）
  const marketPrompt = marketNews.length > 0
    ? `以下是${sessionLabel}美股市場新聞標題，請篩選出最重要的 3~5 條並回傳 JSON。
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

  const stockPrompt = `以下是${sessionLabel}美股個股新聞，請評分並篩選重要條目回傳 JSON。
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
// 組合快訊訊息（HTML，發送時轉 Slack Block Kit）
// ─────────────────────────────────────────────
function buildFlashMessage(analyzed, indexSnapshot = [], sessionDate = null) {
  const { timeStr } = fmtDateHeader();
  const sess = sessionDate ? fmtSessionDate(sessionDate) : null;

  const totalCount = analyzed.market.length + analyzed.stocks.length;
  let msg = sess
    ? `<b>⚡ 美股新聞快訊</b>｜${sess.dateStr}（${sess.weekday}）盤後\n`
    : `<b>⚡ 美股新聞快訊</b>\n`;
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
    msg += `  <i>該交易日無重大總經或地緣事件</i>\n`;
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
    msg += `  <i>該交易日池內個股無重大事件</i>\n`;
  }

  msg += `\n${'━'.repeat(24)}\n`;
  msg += `<i>⚡ ${totalCount} 則重要新聞 · ${timeStr}（台北）發布</i>\n`;
  msg += `<i>來源：Finnhub / Yahoo Finance · 僅供參考</i>`;
  return msg;
}

// ─────────────────────────────────────────────
// 執行快訊報告
// ─────────────────────────────────────────────
async function runFlashReport(force = false) {
  const sessionDate  = lastUSTradingSession();
  const sess         = fmtSessionDate(sessionDate);
  const sessionLabel = `${sess.dateStr}（${sess.weekday}）`;

  if (!force && _state.lastFlashSession === sessionDate) {
    log('FLASH', `本期（${sessionDate}）已產出過，跳過`);
    return;
  }
  if (runningLocks.flash) { log('FLASH', '⚠️ 美股新聞快訊正在執行中，跳過重複觸發'); return; }
  runningLocks.flash = true;
  const lockTimerFlash = setTimeout(() => { runningLocks.flash = false; log('FLASH', '⚠️ 執行逾時，強制釋放鎖'); }, LOCK_TIMEOUT_MS);
  const startTime = Date.now();
  log('FLASH', `🚀 開始執行美股新聞快訊（交易日 ${sessionDate}）`);

  try {
    const newsTo = todayET();
    // 同時抓取新聞和指數快照
    const [{ marketNews, stockArticles }, indexQuotes] = await Promise.all([
      collectFlashNews(sessionDate, newsTo),
      Promise.all(INDICES.map(s => fetchQuote(s.symbol))),
    ]);

    if (marketNews.length === 0 && stockArticles.length === 0) {
      log('FLASH', '無任何新聞原料，跳過推播');
      return;
    }

    log('FLASH', '分析新聞重要性...');
    const analyzed = await analyzeFlashNews(marketNews, stockArticles, sessionLabel);

    // 若大盤和個股都沒有高分新聞，靜默跳過（不發空訊息）
    if (analyzed.market.length === 0 && analyzed.stocks.length === 0) {
      log('FLASH', '無高重要性新聞（≥4分），跳過推播');
      return;
    }

    // 附加指數快照
    const indexSnapshot = INDICES.map((s, i) => ({ ...s, quote: indexQuotes[i] })).filter(x => x.quote);
    const message = buildFlashMessage(analyzed, indexSnapshot, sessionDate);
    const chunks  = splitMessage(message, MSG_LIMIT);
    for (let i = 0; i < chunks.length; i++) {
      await sendMessage(chunks[i]);
      if (i < chunks.length - 1) await sleep(1000);
    }

    _state.lastFlashSession = sessionDate;
    saveState();
    saveReportSnapshot('flash', sessionDate, {
      indexSnapshot: indexSnapshot.map(s => ({ symbol: s.symbol, name: s.name, price: s.quote?.price ?? null, changePct: s.quote?.changePct ?? null })),
      market: analyzed.market,
      stocks: analyzed.stocks,
    });

    log('FLASH', `✅ 完成，耗時 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } catch (err) {
    log('FLASH', `❌ 失敗：${err.message}`);
    await sendMessage(`<b>❌ 美股新聞快訊執行失敗</b>（交易日 ${sessionDate}）\n\n<code>${err.message}</code>\n${new Date().toLocaleString('zh-TW', { timeZone: TIMEZONE })}`).catch(() => {});
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
              ? '你是資深美股分析師，精通 HTML 排版。只用 <b><i><code> 標籤，禁止 Markdown。數字引用真實數據。'
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

// ═══════════════════════════════════════════════════════════
// 訊息平台抽象層（Slack）
// ═══════════════════════════════════════════════════════════
// 對外 API：
//   sendMessage(text)        — 送一則訊息（自動轉 Block Kit、附 plain_text fallback、重試）
//   splitMessage(text, max)  — 把長訊息切成多段（沿用 <b>{emoji}...</b> 區段切點）
// 報告內容仍以 HTML 風格撰寫（<b> <i> <code>），這層會自動轉成 Slack mrkdwn / Block Kit。

const { WebClient }        = require('@slack/web-api');
const { SocketModeClient } = require('@slack/socket-mode');

let slackWeb    = null;
let slackSocket = null;

// 區段標題的 emoji（splitMessage / Block Kit header 用同一組）
const SECTION_EMOJIS = '📊🔮🏆🔥📅📰🔄🎯⚠️🗞️🌐📌⚡🟢❌';

// ── HTML → Slack mrkdwn ──
function htmlToMrkdwn(text) {
  // Slack 連結語法本身用 < >，必須先把 <a> 抽掉成 placeholder，最後再放回，
  // 否則最後一輪「移除殘餘 HTML tag」會把 <url|text> 也吃掉。
  const links = [];
  let out = text.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, url, txt) => {
    links.push({ url, txt: htmlToPlain(txt) });
    return `\x00LINK${links.length - 1}\x00`;
  });

  out = out
    .replace(/<pre>([\s\S]*?)<\/pre>/g, (_m, code) => '```\n' + code + '\n```')
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<\/?(b|strong)>/g, '*')
    .replace(/<\/?(i|em)>/g, '_')
    .replace(/<\/?br\s*\/?>/g, '\n')
    // 殘餘 HTML tag 全部脫除
    .replace(/<[^>]+>/g, '')
    // Slack mrkdwn 中 & < > 需逃逸（連結 placeholder 暫未還原，不會被誤吃）
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 放回 Slack 連結
  out = out.replace(/\x00LINK(\d+)\x00/g, (_m, i) => {
    const { url, txt } = links[Number(i)];
    return `<${url}|${txt}>`;
  });

  return out;
}

// HTML → 純文字（給 header block / fallback 用）
function htmlToPlain(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// 把長字串依「行」切成 <= maxLen 的多段（單一 section block 文字上限 3000）
function chunkTextByLine(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const lines  = text.split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const candidate = cur ? cur + '\n' + line : line;
    if (candidate.length <= maxLen) {
      cur = candidate;
    } else {
      if (cur) chunks.push(cur);
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
        cur = '';
      } else {
        cur = line;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// HTML 報告文字 → Block Kit blocks
function buildSlackBlocks(text) {
  const SECTION_RE = new RegExp(`(?=\\n?<b>[${SECTION_EMOJIS}])`, 'g');
  const pieces = text.split(SECTION_RE).map(s => s.trim()).filter(Boolean);
  const blocks = [];

  for (let i = 0; i < pieces.length; i++) {
    if (blocks.length >= 50) break;
    if (i > 0 && blocks.length < 49) blocks.push({ type: 'divider' });
    if (blocks.length >= 50) break;

    const piece = pieces[i];
    const titleMatch = piece.match(/^<b>([^<]*)<\/b>\s*\n?([\s\S]*)$/);
    let body;
    if (titleMatch) {
      const title = htmlToPlain(titleMatch[1]).slice(0, 150);
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: title, emoji: true },
      });
      body = titleMatch[2];
    } else {
      body = piece;
    }
    const mrkdwn = htmlToMrkdwn(body).replace(/━+/g, '').trim();
    if (!mrkdwn) continue;
    for (const chunk of chunkTextByLine(mrkdwn, 2900)) {
      if (blocks.length >= 50) break;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: chunk },
      });
    }
  }

  if (blocks.length === 0) {
    const mrkdwn = htmlToMrkdwn(text).trim();
    if (mrkdwn) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: mrkdwn.slice(0, 2900) } });
  }

  return blocks.slice(0, 50);
}

async function initSlack() {
  slackWeb = new WebClient(SLACK_BOT_TOKEN);

  // 驗證 bot token + 頻道
  try {
    const auth = await slackWeb.auth.test();
    log('SLACK', `✅ 已認證 bot ${auth.user} @ ${auth.team}`);
  } catch (e) {
    throw new Error(`SLACK_BOT_TOKEN 驗證失敗：${e.data?.error || e.message}`);
  }
  try {
    const info = await slackWeb.conversations.info({ channel: SLACK_CHANNEL_ID });
    log('SLACK', `✅ 目標頻道 #${info.channel?.name || SLACK_CHANNEL_ID}`);
  } catch (e) {
    log('SLACK', `⚠️ 取得頻道資訊失敗（仍嘗試發送）：${e.data?.error || e.message}`);
  }

  slackSocket = new SocketModeClient({ appToken: SLACK_APP_TOKEN });
  slackSocket.on('error',        e => log('SLACK', `socket error: ${e.message || e}`));
  slackSocket.on('disconnect',   () => log('SLACK', 'socket disconnected'));
  slackSocket.on('connected',    () => log('SLACK', 'socket connected'));

  // ── 斜線指令：/ping /stock /flash ──
  slackSocket.on('slash_commands', async ({ ack, body }) => {
    try {
      const cmd       = (body.command || '').toLowerCase();
      const channelId = body.channel_id;
      const userId    = body.user_id;

      if (channelId !== SLACK_CHANNEL_ID) {
        await ack({
          response_type: 'ephemeral',
          text: `請到 <#${SLACK_CHANNEL_ID}> 使用此指令`,
        });
        return;
      }

      if (cmd === '/ping') {
        await ack({
          response_type: 'in_channel',
          blocks: buildSlackBlocks(buildPingMessage()),
          text:   '系統狀態',
        });
      } else if (cmd === '/stock') {
        await ack({ response_type: 'in_channel', text: '⏳ *美股日報* 生成中，請稍候...' });
        runStockReport(true).catch(e => log('STOCK', `手動失敗: ${e.message}`));
      } else if (cmd === '/flash') {
        await ack({ response_type: 'in_channel', text: '⏳ *美股新聞快訊* 生成中，請稍候...' });
        runFlashReport(true).catch(e => log('FLASH', `手動失敗: ${e.message}`));
      } else {
        await ack({ response_type: 'ephemeral', text: `未知指令：${cmd}` });
      }
      log('SLACK', `斜線指令 ${cmd} from user ${userId}`);
    } catch (e) {
      log('SLACK', `斜線指令處理錯誤: ${e.message}`);
      try { await ack({ response_type: 'ephemeral', text: `❌ 指令處理失敗：${e.message}` }); } catch {}
    }
  });

  await slackSocket.start();
  log('SLACK', '✅ Socket Mode 已連線，斜線指令就緒（/ping /stock /flash）');
}

async function sendSlack(text, retries = 3) {
  if (!slackWeb) throw new Error('Slack Web client 尚未就緒');
  const blocks   = buildSlackBlocks(text);
  const fallback = htmlToPlain(text).slice(0, 3000);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await slackWeb.chat.postMessage({
        channel:      SLACK_CHANNEL_ID,
        text:         fallback,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (err) {
      const errCode = err?.data?.error || err.message;
      if (attempt < retries) {
        const delay = attempt * 2000;
        log('SLACK', `⚠️ 發送失敗（第 ${attempt} 次），${delay / 1000}s 後重試：${errCode}`);
        await sleep(delay);
      } else {
        log('SLACK', `❌ 發送失敗（已重試 ${retries} 次）：${errCode}`);
        throw err;
      }
    }
  }
}

// ── 統一發送入口 ──
async function sendMessage(text, retries = 3) {
  return sendSlack(text, retries);
}

function splitMessage(text, maxLen = MSG_LIMIT) {
  if (text.length <= maxLen) return [text];
  const SECTION_RE = new RegExp(`(?=\\n<b>[${SECTION_EMOJIS}])`, 'g');
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

// ── /ping 訊息 ──
function buildPingMessage() {
  const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const uptime = Math.floor(process.uptime());
  const uptimeStr = uptime >= 3600
    ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
    : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
  return `<b>🟢 系統狀態</b>\n` +
    `  版本　 <code>${APP_VERSION}</code>\n` +
    `  平台　 <code>${PLATFORM}</code>\n` +
    `  狀態　 正常運作中\n` +
    `  記憶體 <code>${mem} MB</code>\n` +
    `  運行　 <code>${uptimeStr}</code>\n` +
    `  時間　 ${new Date().toLocaleString('zh-TW', { timeZone: TIMEZONE })}`;
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
    res.end(JSON.stringify({ status: 'ok', version: APP_VERSION, platform: PLATFORM, time: new Date().toISOString() }));
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

  if (slackSocket) { try { await slackSocket.disconnect(); } catch {} }

  log('MAIN', '👋 Bot 已關閉');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ═══════════════════════════════════════════════════════════
// 主程式
// ═══════════════════════════════════════════════════════════
async function main() {
  log('MAIN', `🚀 美股日報 Bot ${APP_VERSION} 啟動（訊息平台：${PLATFORM}）`);
  loadState();
  log('MAIN', `📅 目前對應的美股交易日：${lastUSTradingSession()}`);

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

  await initSlack();

  await sendMessage(
    `<b>🟢 Bot ${APP_VERSION} 已啟動</b>\n\n` +
    `<b>📋 每日排程</b>（週一至週五）\n` +
    `  <code>07:30</code>  📈 美股日報\n` +
    `  <code>07:35</code>  ⚡ 美股新聞快訊\n\n` +
    `<b>🎮 指令</b>（Slack 斜線指令）\n` +
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
    if (target === 'flash') runFlashReport(true);
    else                    runStockReport(true);
  });
} else {
  main().catch(e => { console.error('❌ 主程式崩潰:', e); process.exit(1); });
}
