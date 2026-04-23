'use strict';

const { getKeyMetrics, getFinancialRatios } = require('./fmp');

async function runFundamentalsAgent(symbol) {
  const [metrics, ratios] = await Promise.all([
    getKeyMetrics(symbol, 1),
    getFinancialRatios(symbol),
  ]);
  const m = metrics[0];
  if (!m) return null;

  let bullish = 0, bearish = 0;
  const details = [];

  // 獲利能力（4 項）
  if (m.roe > 0.15)               { bullish++; details.push('ROE優'); }          else bearish++;
  if (m.netProfitMargin > 0.2)    { bullish++; details.push('淨利率高'); }        else bearish++;
  if (m.roic > 0.1)               { bullish++; details.push('ROIC優'); }          else bearish++;
  if (m.freeCashFlowYield > 0.03) { bullish++; details.push('FCF殖利率佳'); }     else bearish++;

  // 成長性（2 項）
  if (ratios?.revenueGrowth > 0.1)   { bullish++; details.push('營收成長'); }   else bearish++;
  if (ratios?.netIncomeGrowth > 0.1) { bullish++; details.push('獲利成長'); }   else bearish++;

  // 財務健康（2 項）
  if (m.currentRatio > 1.5) { bullish++; details.push('流動性佳'); }            else bearish++;
  if (m.debtToEquity < 0.5) { bullish++; details.push('低槓桿'); }              else { bearish++; details.push('高槓桿'); }

  // 估值（2 項）
  if (m.peRatio > 0 && m.peRatio < 25) { bullish++; details.push(`P/E ${m.peRatio.toFixed(1)}`); } else bearish++;
  if (m.pbRatio > 0 && m.pbRatio < 3)  { bullish++; details.push(`P/B ${m.pbRatio.toFixed(1)}`); } else bearish++;

  const total = bullish + bearish;
  const confidence = total > 0 ? Math.round((bullish / total) * 100) : 50;
  const signal = confidence >= 65 ? 'BUY' : confidence <= 40 ? 'SELL' : 'NEUTRAL';

  return { agent: '基本面', symbol, signal, confidence, details: details.slice(0, 3).join('、') };
}

module.exports = { runFundamentalsAgent };
