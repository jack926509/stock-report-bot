'use strict';

const OpenAI = require('openai');

let _client = null;
function getClient() {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: 'https://api.perplexity.ai',
    });
  }
  return _client;
}

const PERPLEXITY_TIMEOUT_MS = 30000;

async function perplexitySearch(content, recency = 'day', maxTokens = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PERPLEXITY_TIMEOUT_MS);
  try {
    const resp = await getClient().chat.completions.create(
      { model: 'sonar', messages: [{ role: 'user', content }], search_recency_filter: recency, max_tokens: maxTokens },
      { signal: controller.signal }
    );
    return { text: resp.choices[0].message.content, citations: resp.citations || [] };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMacroContext() {
  return perplexitySearch(
    '今天（美東時間）有哪些重大宏觀事件影響美股？請條列 3-5 項，包含：Fed 官員言論、重要經濟數據公布（CPI/PPI/PCE/就業/GDP）、財報季動態、地緣政治事件。每項附來源媒體名稱。',
    'day', 800
  );
}

// 回傳結構化 JSON，供 runNewsReport 直接解析
async function fetchAINews() {
  return perplexitySearch(
    `請搜尋今天最重要的 AI 科技新聞（8-10 則），涵蓋 OpenAI、Google、Anthropic、Meta、NVIDIA、Microsoft 等主要公司的最新動態。
回傳純 JSON，不要任何說明文字，格式如下：
{"articles":[{"title":"新聞標題","summary_zh":"繁體中文摘要30字內","source":"來源網站名稱","url":"完整網址","importance":5,"tags":["標籤1","標籤2"]}]}
重要性評分：5=重大發布或突破研究，4=重要產品或政策更新，3=一般動態`,
    'day', 2000
  );
}

async function fetchStockCatalyst(symbol, name) {
  return perplexitySearch(
    `${name}（${symbol}）今天股價大幅異動的原因是什麼？列出 1-3 個主要催化劑（財報/升降評/產品消息/法規/並購），每項一句話，附來源媒體名稱。`,
    'day', 500
  );
}

module.exports = { fetchMacroContext, fetchAINews, fetchStockCatalyst };
