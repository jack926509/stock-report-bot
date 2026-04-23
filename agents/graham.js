'use strict';

const { getKeyMetrics } = require('./fmp');

async function runGrahamAgent(symbol) {
  const metrics = await getKeyMetrics(symbol, 1);
  const m = metrics[0];
  if (!m) return null;

  // Graham Number = sqrt(22.5 × EPS × BookValuePerShare)
  // Prefer FMP pre-calculated value; fall back to manual formula
  let grahamNum = null;
  if (m.grahamNumber > 0) {
    grahamNum = m.grahamNumber;
  } else if (m.eps > 0 && m.bookValuePerShare > 0) {
    grahamNum = Math.sqrt(22.5 * m.eps * m.bookValuePerShare);
  }

  // Current price: marketCap/shares → P/E × EPS fallback (eps always available here)
  const currentPrice = (m.marketCap && m.sharesOutstanding)
    ? m.marketCap / m.sharesOutstanding
    : (m.peRatio > 0 && m.eps > 0 ? m.peRatio * m.eps : null);

  if (!grahamNum || !currentPrice) {
    return { agent: 'Graham', symbol, signal: 'NEUTRAL', confidence: 50, details: '估值資料不足' };
  }

  const mos = (grahamNum - currentPrice) / currentPrice;

  let signal, confidence;
  if (mos >= 0.5)       { signal = 'BUY';     confidence = 85; }
  else if (mos >= 0.2)  { signal = 'BUY';     confidence = 65; }
  else if (mos >= 0)    { signal = 'NEUTRAL';  confidence = 50; }
  else if (mos >= -0.2) { signal = 'NEUTRAL';  confidence = 40; }
  else                  { signal = 'SELL';     confidence = 70; }

  const details = `Graham值$${grahamNum.toFixed(0)} vs 市價$${currentPrice.toFixed(0)}(MOS ${Math.round(mos * 100)}%)`;
  return { agent: 'Graham', symbol, signal, confidence, details };
}

module.exports = { runGrahamAgent };
