// ─────────────────────────────────────────────────────────────────────────────
// cTrader TCP Relay for MyTradeNotes
// Accepts HTTPS POST from PHP server → connects to cTrader JSON API (port 5036)
// Deploy free on Render.com
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const tls     = require('tls');
const express = require('express');
const app     = express();

app.use(express.json({ limit: '2mb' }));

const RELAY_SECRET = process.env.RELAY_SECRET || '';
const PORT         = process.env.PORT || 3000;

// ── Auth middleware ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const secret = req.headers['x-relay-secret'] || req.body?.secret;
  if (!RELAY_SECRET || secret !== RELAY_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// ── Health check (keeps Render free tier alive if pinged) ─────────────────────
app.get('/health', (_, res) => res.json({ ok: true, service: 'ctrader-relay' }));

// ── Main sync endpoint ─────────────────────────────────────────────────────────
// POST /sync
// Body: { host, clientId, clientSecret, accessToken, ctidAccountId, fromTimestamp, toTimestamp }
app.post('/sync', async (req, res) => {
  const { host, clientId, clientSecret, accessToken, ctidAccountId, fromTimestamp, toTimestamp } = req.body;

  const missing = ['host','clientId','clientSecret','accessToken','ctidAccountId','fromTimestamp','toTimestamp']
    .filter(k => req.body[k] === undefined || req.body[k] === null || req.body[k] === '');
  if (missing.length) {
    return res.json({ ok: false, error: `Missing fields: ${missing.join(', ')}` });
  }

  try {
    const result = await syncAccount({ host, clientId, clientSecret, accessToken,
                                       ctidAccountId: Number(ctidAccountId),
                                       fromTimestamp:  Number(fromTimestamp),
                                       toTimestamp:    Number(toTimestamp) });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(`[sync] Error: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// ── TCP helpers ────────────────────────────────────────────────────────────────

function connectCtrader(host) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: 5036, rejectUnauthorized: true }, () => {
      console.log(`[tcp] Connected to ${host}:5036`);
      resolve(sock);
    });
    sock.setTimeout(12000);
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`TCP connect timeout to ${host}:5036`)); });
    sock.on('error',   (e) => reject(new Error(`TCP error: ${e.message}`)));
  });
}

// Framed JSON reader: cTrader JSON port 5036 uses 4-byte BIG-endian length + JSON body
function createFrameReader(sock) {
  let buf       = Buffer.alloc(0);
  const handlers = [];

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);  // big-endian on JSON port 5036
      if (len <= 0 || len > 2_000_000) { buf = Buffer.alloc(0); break; }
      if (buf.length < 4 + len) break;
      let msg;
      try { msg = JSON.parse(buf.slice(4, 4 + len).toString()); } catch { break; }
      buf = buf.slice(4 + len);
      handlers.forEach(fn => fn(msg));
    }
  });

  return {
    on:  (fn) => handlers.push(fn),
    off: (fn) => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); },
  };
}

function sendMsg(sock, payloadType, payload) {
  const body  = JSON.stringify({ payloadType, clientMsgId: `tj_${Date.now()}_${Math.random().toString(36).slice(2)}`, payload });
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);  // big-endian on JSON port 5036
  Buffer.from(body).copy(frame, 4);
  sock.write(frame);
}

function waitFor(reader, wantType, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.off(handler);
      reject(new Error(`Timeout waiting for payloadType ${wantType}`));
    }, timeoutMs);

    const handler = (msg) => {
      const pt = Number(msg.payloadType ?? 0);
      if (pt === wantType) {
        clearTimeout(timer); reader.off(handler); resolve(msg);
      } else if (pt === 50 || pt === 2142) { // ERROR_RES / ProtoOAErrorRes
        clearTimeout(timer); reader.off(handler);
        const desc = msg.payload?.description ?? msg.payload?.errorCode ?? JSON.stringify(msg.payload);
        reject(new Error(`cTrader error (${pt}): ${desc}`));
      }
      // payloadType 51 = heartbeat — ignore
    };
    reader.on(handler);
  });
}

// ── Full sync flow ─────────────────────────────────────────────────────────────
async function syncAccount({ host, clientId, clientSecret, accessToken, ctidAccountId, fromTimestamp, toTimestamp }) {
  const sock   = await connectCtrader(host);
  const reader = createFrameReader(sock);

  try {
    // 1. App auth
    console.log(`[sync] App auth for ctid=${ctidAccountId}`);
    sendMsg(sock, 2100, { clientId, clientSecret });
    await waitFor(reader, 2101);

    // 2. Account auth
    console.log(`[sync] Account auth`);
    sendMsg(sock, 2102, { ctidTraderAccountId: ctidAccountId, accessToken });
    await waitFor(reader, 2103);

    // 3. Symbol list
    console.log(`[sync] Fetching symbols`);
    sendMsg(sock, 2119, { ctidTraderAccountId: ctidAccountId, includeArchivedSymbols: false });
    const symRes  = await waitFor(reader, 2120, 15000);
    const symbols = {};
    for (const s of symRes.payload?.symbol ?? []) {
      symbols[String(s.symbolId)] = s.symbolName;
    }
    console.log(`[sync] Got ${Object.keys(symbols).length} symbols`);

    // 4. Deal list (paginated, 500/page)
    const DEALS_PER_PAGE = 500;
    const allDeals = [];
    let pageFrom = fromTimestamp;
    let pages    = 0;

    while (pages < 40) {
      sendMsg(sock, 2155, {
        ctidTraderAccountId: ctidAccountId,
        fromTimestamp: pageFrom,
        toTimestamp,
        maxRows: DEALS_PER_PAGE,
      });
      const r     = await waitFor(reader, 2156, 20000);
      const deals = r.payload?.deal ?? [];
      console.log(`[sync] Page ${pages + 1}: ${deals.length} deals`);
      if (!deals.length) break;
      allDeals.push(...deals);
      pages++;
      if (deals.length < DEALS_PER_PAGE) break;
      const maxTs = Math.max(...deals.map(d => Number(d.executionTimestamp)));
      pageFrom = maxTs + 1;
      if (pageFrom >= toTimestamp) break;
    }

    console.log(`[sync] Done: ${allDeals.length} deals in ${pages} pages`);
    return { deals: allDeals, symbols, pages, total: allDeals.length };

  } finally {
    sock.destroy();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`cTrader relay listening on port ${PORT}`);
  if (!RELAY_SECRET) console.warn('WARNING: RELAY_SECRET env var not set — relay is unprotected!');
});
