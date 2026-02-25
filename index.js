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
    sendMsg(ws, 2100, { clientId, clientSecret });
    await waitFor(ws, 2101);
    console.log('[sync] App auth OK');

    sendMsg(ws, 2102, { ctidTraderAccountId: ctidAccountId, accessToken });
    await waitFor(ws, 2103);
    console.log('[sync] Account auth OK');

    // Symbol names come directly from deal.symbol field — no separate lookup needed
    const symbols = {};
    console.log('[sync] Skipping symbol list (names in deal objects)');

    const allDeals = [];
    let   pageFrom = fromTimestamp;
    let   pages    = 0;
    while (pages < 40) {
      sendMsg(ws, 2155, { ctidTraderAccountId: ctidAccountId, fromTimestamp: pageFrom, toTimestamp, maxRows: 500 });
      const r     = await waitFor(ws, 2156, 20000);
      const deals = r.payload?.deal ?? [];
      console.log(`[sync] Page ${pages+1}: ${deals.length} deals`);
      if (!deals.length) break;
      allDeals.push(...deals);
      pages++;
      if (deals.length < 500) break;
      pageFrom = Math.max(...deals.map(d => Number(d.executionTimestamp))) + 1;
      if (pageFrom >= toTimestamp) break;
    }

    console.log(`[sync] Done: ${allDeals.length} deals`);
    return { deals: allDeals, symbols, pages, total: allDeals.length };
  } finally {
    ws.terminate();
  }
}

app.listen(PORT, () => {
  console.log(`cTrader relay (WebSocket mode) on port ${PORT}`);
  if (!RELAY_SECRET) console.warn('WARNING: RELAY_SECRET not set!');
});
