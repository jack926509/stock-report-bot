'use strict';

const https = require('https');

const FMP_KEY = process.env.FMP_API_KEY;
const CACHE_TTL = 60 * 60 * 1000; // 1 小時
const CACHE_MAX = 100;
const cache = new Map(); // url → { value, expiresAt }

function fmpGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://financialmodelingprep.com/api/v3${path}${sep}apikey=${FMP_KEY}`;

  const cached = cache.get(url);
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.value);

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // 淘汰最舊
          cache.set(url, { value: parsed, expiresAt: Date.now() + CACHE_TTL });
          resolve(parsed);
        } catch (e) {
          reject(new Error(`FMP parse error for ${path}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`FMP timeout: ${path}`)); });
  });
}

async function getKeyMetrics(symbol, limit = 5) {
  const data = await fmpGet(`/key-metrics/${symbol}?limit=${limit}`);
  return Array.isArray(data) ? data : [];
}

async function getFinancialRatios(symbol) {
  const data = await fmpGet(`/ratios/${symbol}?limit=1`);
  return Array.isArray(data) ? (data[0] || null) : null;
}

async function getCashFlowStatement(symbol, limit = 3) {
  const data = await fmpGet(`/cash-flow-statement/${symbol}?limit=${limit}`);
  return Array.isArray(data) ? data : [];
}

function clearCache() { cache.clear(); }

function pruneExpiredCache() {
  const now = Date.now();
  for (const [k, v] of cache) { if (now >= v.expiresAt) cache.delete(k); }
}

module.exports = { getKeyMetrics, getFinancialRatios, getCashFlowStatement, clearCache, pruneExpiredCache };
