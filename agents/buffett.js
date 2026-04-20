'use strict';

const { getKeyMetrics } = require('./fmp');

async function runBuffettAgent(symbol) {
  const metrics = await getKeyMetrics(symbol, 5);
  if (!metrics.length) return null;
  const m = metrics[0];

  let score = 0;
  const details = [];

  // 護城河：一致性 ROE（最多 3 分）
  const validRoe = metrics.map(x => x.roe).filter(v => v != null && !isNaN(v));
  if (validRoe.length) {
    const avgRoe = validRoe.reduce((s, v) => s + v, 0) / validRoe.length;
    if (avgRoe > 0.15)     { score += 3; details.push(`${validRoe.length}年均ROE ${Math.round(avgRoe * 100)}%`); }
    else if (avgRoe > 0.1) { score += 1; }
  }

  // 低債務（2 分）
  if (m.debtToEquity != null && m.debtToEquity < 0.5) { score += 2; details.push('低債務'); }

  // 高淨利率（2 分）
  if (m.netProfitMargin > 0.15) { score += 2; details.push(`淨利率 ${Math.round(m.netProfitMargin * 100)}%`); }

  // FCF 殖利率（2 分）
  if (m.freeCashFlowYield > 0.04) { score += 2; details.push(`FCF殖利率 ${Math.round(m.freeCashFlowYield * 100)}%`); }

  // ROIC（1 分）
  if (m.roic > 0.15) { score += 1; details.push('ROIC優'); }

  const confidence = Math.round(score / 10 * 100);
  const signal = confidence >= 70 ? 'BUY' : confidence <= 40 ? 'SELL' : 'NEUTRAL';

  return { agent: 'Buffett', symbol, signal, confidence, details: details.join('、') };
}

module.exports = { runBuffettAgent };
