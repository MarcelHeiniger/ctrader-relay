'use strict';

const WebSocket = require('ws');
const express   = require('express');
const app       = express();

app.use(express.json({ limit: '2mb' }));

const RELAY_SECRET = process.env.RELAY_SECRET || '';
const PORT         = process.env.PORT || 3000;

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const secret = req.headers['x-relay-secret'] || req.body?.secret;
  if (!RELAY_SECRET || secret !== RELAY_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (_, res) => res.json({ ok: true, service: 'ctrader-relay' }));

app.post('/sync', async (req, res) => {
  const { host, clientId, clientSecret, accessToken, ctidAccountId, fromTimestamp, toTimestamp } = req.body;
  const missing = ['host','clientId','clientSecret','accessToken','ctidAccountId','fromTimestamp','toTimestamp']
    .filter(k => req.body[k] === undefined || req.body[k] === null || req.body[k] === '');
  if (missing.length) return res.json({ ok: false, error: `Missing: ${missing.join(', ')}` });

  try {
    const result = await syncAccount({
      host, clientId, clientSecret, accessToken,
      ctidAccountId: Number(ctidAccountId),
      fromTimestamp:  Number(fromTimestamp),
      toTimestamp:    Number(toTimestamp),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(`[sync] ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

function connectWS(host) {
  return new Promise((resolve, reject) => {
    const url = `wss://${host}:5036`;
    console.log(`[ws] Connecting to ${url}`);
    const ws = new WebSocket(url);
    const t  = setTimeout(() => { ws.terminate(); reject(new Error(`WS connect timeout to ${url}`)); }, 12000);
    ws.on('open',  () => { clearTimeout(t); console.log('[ws] Connected'); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(new Error(`WS error: ${e.message}`)); });
  });
}

function sendMsg(ws, payloadType, payload) {
  const msg = JSON.stringify({ payloadType, clientMsgId: `tj_${Date.now()}`, payload });
  console.log(`[send] type=${payloadType} body=${msg.slice(0,120)}`);
  ws.send(msg);
}

function waitFor(ws, wantType, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for payloadType ${wantType}`));
    }, timeoutMs);

    function handler(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const pt = Number(msg.payloadType ?? 0);
      console.log(`[recv] type=${pt} body=${JSON.stringify(msg).slice(0,120)}`);
      if (pt === wantType) {
        clearTimeout(t); ws.off('message', handler); resolve(msg);
      } else if (pt === 50 || pt === 2142) {
        clearTimeout(t); ws.off('message', handler);
        reject(new Error(`cTrader error (${pt}): ${msg.payload?.description ?? msg.payload?.errorCode ?? JSON.stringify(msg.payload)}`));
      }
    }
    ws.on('message', handler);
  });
}

async function syncAccount({ host, clientId, clientSecret, accessToken, ctidAccountId, fromTimestamp, toTimestamp }) {
  const ws = await connectWS(host);
  try {
    // ── App + account auth ──────────────────────────────────────────────────
    sendMsg(ws, 2100, { clientId, clientSecret });
    await waitFor(ws, 2101);
    console.log('[sync] App auth OK');

    sendMsg(ws, 2102, { ctidTraderAccountId: ctidAccountId, accessToken });
    await waitFor(ws, 2103);
    console.log('[sync] Account auth OK');

    // ── Symbol list → names ─────────────────────────────────────────────────
    // cTrader deals contain symbolId (integer), NOT a symbol name string.
    // We must fetch the symbol list first to build id→name and id→lotSize maps.
    const symbols  = {};  // symbolId → name  (returned to PHP as 'symbols')
    const lotSizes = {};  // symbolId → lotSize (returned to PHP as 'lotSizes')

    try {
      sendMsg(ws, 2119, { ctidTraderAccountId: ctidAccountId, includeArchivedSymbols: false });
      const symRes = await waitFor(ws, 2120, 20000);
      const symList = symRes.payload?.symbol ?? symRes.payload?.symbols ?? [];
      for (const s of symList) {
        const id   = Number(s.symbolId ?? s.id ?? 0);
        const name = s.symbolName ?? s.name ?? null;
        if (id && name) symbols[id] = name;
      }
      console.log(`[sync] Symbol list: ${Object.keys(symbols).length} symbols`);
    } catch (e) {
      // Non-fatal — deals may still have symbol field or we fall back to SYM{id}
      console.warn(`[sync] Symbol list failed (non-fatal): ${e.message}`);
    }

    // ── Fetch deals in pages ────────────────────────────────────────────────
    const allDeals = [];
    let   pageFrom = fromTimestamp;
    let   pages    = 0;
    while (pages < 40) {
      sendMsg(ws, 2133, { ctidTraderAccountId: ctidAccountId, fromTimestamp: pageFrom, toTimestamp, maxRows: 500 });
      const r     = await waitFor(ws, 2134, 20000);
      const deals = r.payload?.deal ?? [];
      console.log(`[sync] Page ${pages+1}: ${deals.length} deals`);
      if (!deals.length) break;
      allDeals.push(...deals);
      pages++;
      if (deals.length < 500) break;
      pageFrom = Math.max(...deals.map(d => Number(d.executionTimestamp))) + 1;
      if (pageFrom >= toTimestamp) break;
    }
    console.log(`[sync] Deals total: ${allDeals.length}`);

    // ── Symbol details → lotSizes for symbols found in deals ────────────────
    // lotSize is needed to correctly convert volume (units) → lots.
    // e.g. EURUSD lotSize=100000, so volume 300000 = 3.00 lots.
    const uniqueIds = [...new Set(allDeals.map(d => Number(d.symbolId ?? 0)).filter(Boolean))];
    if (uniqueIds.length) {
      try {
        // Send in chunks of 50
        for (let i = 0; i < uniqueIds.length; i += 50) {
          const chunk = uniqueIds.slice(i, i + 50);
          sendMsg(ws, 2125, { ctidTraderAccountId: ctidAccountId, symbolId: chunk });
          const detRes = await waitFor(ws, 2126, 15000);
          for (const d of detRes.payload?.symbolDetails ?? []) {
            const id  = Number(d.symbolId ?? 0);
            const lot = Number(d.lotSize  ?? 0);
            const nm  = d.symbolName ?? d.name ?? null;
            if (id && lot) lotSizes[id] = lot;
            // Fill in any name the symbol list missed
            if (id && nm && !symbols[id]) symbols[id] = nm;
          }
        }
        console.log(`[sync] LotSizes fetched: ${Object.keys(lotSizes).length} entries`);
      } catch (e) {
        console.warn(`[sync] Symbol details failed (non-fatal): ${e.message}`);
      }
    }

    console.log(`[sync] Done: ${allDeals.length} deals, ${Object.keys(symbols).length} symbols, ${Object.keys(lotSizes).length} lotSizes`);
    return { deals: allDeals, symbols, lotSizes, pages, total: allDeals.length };

  } finally {
    ws.terminate();
  }
}

app.listen(PORT, () => {
  console.log(`cTrader relay (WebSocket mode) on port ${PORT}`);
  if (!RELAY_SECRET) console.warn('WARNING: RELAY_SECRET not set!');
});
