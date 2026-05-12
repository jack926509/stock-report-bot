'use strict';

const { runFundamentalsAgent } = require('./fundamentals');
const { runBuffettAgent } = require('./buffett');
const { runGrahamAgent } = require('./graham');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runAllAgents(symbol) {
  const [fund, buffett, graham] = await Promise.all([
    runFundamentalsAgent(symbol).catch(() => null),
    runBuffettAgent(symbol).catch(() => null),
    runGrahamAgent(symbol).catch(() => null),
  ]);
  return { symbol, agents: [fund, buffett, graham].filter(Boolean) };
}

// 分批執行，每批 3 支，間隔 500ms 避免 FMP 速率限制
// 不主動清快取：FMP 取的是日級財務數據，1 小時 TTL 內重複觸發可直接命中快取
async function runAgentsForSymbols(symbols) {
  const results = [];
  for (let i = 0; i < symbols.length; i += 3) {
    const batch = symbols.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(runAllAgents));
    results.push(...batchResults);
    if (i + 3 < symbols.length) await sleep(500);
  }
  return results;
}

const SIGNAL_ICON = { BUY: '🟢', SELL: '🔴', NEUTRAL: '🟡' };

function formatAgentSignals(results) {
  const lines = results.map(({ symbol, agents }) => {
    if (!agents.length) return '';
    const sigs = agents
      .map(a => `${a.agent}${SIGNAL_ICON[a.signal]}${a.signal}(${a.confidence}%)`)
      .join(' ');
    return `${symbol}: ${sigs}`;
  }).filter(Boolean);
  return lines.join('\n');
}

module.exports = { runAgentsForSymbols, formatAgentSignals };
