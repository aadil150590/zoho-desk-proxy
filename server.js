require('dotenv').config();
// ============================================================
// Zoho Desk Live Dashboard - Backend Server
// Proxy + Auto Refresh + Webhook + SSE
// Deploy to Render / Railway / VPS
// ============================================================
const express = require('express');
const cors = require('cors');
const app = express();

// CORS MUST be FIRST - before express.json, before routes
// If cors() is after json/routes, preflight OPTIONS fails and browser shows "Failed to fetch" even when tab works
app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json({ limit: '1mb' }));


// EMBEDDED DASHBOARD - no index.html file needed, no ENOENT crash
// Dashboard is served from SAME origin as proxy at https://zoho-desk-proxy.onrender.com/
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zoho Desk • Live Team Performance</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1f1d;color:#eef6f3}
header{padding:18px 22px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1f3a35}
h1{margin:0;font-size:20px}.sub{opacity:.7;font-size:13px}
.badge{padding:6px 12px;border-radius:999px;font-weight:700;font-size:13px}.live{background:#1db954;color:#04120c}.demo{background:#f59e0b;color:#1a1200}
main{padding:18px 22px;max-width:1100px;margin:0 auto}
.card{background:#162b27;border:1px solid #23433c;border-radius:14px;padding:16px;margin-bottom:14px}
.row{display:flex;gap:12px;flex-wrap:wrap}.kpi{flex:1;min-width:160px}.kpi b{font-size:28px;display:block}
button{background:#2dd4a8;border:0;color:#04120c;padding:10px 16px;border-radius:10px;font-weight:700;cursor:pointer}
button.sec{background:#1e3a34;color:#fff}input{width:100%;padding:10px;border-radius:10px;border:1px solid #2a4a43;background:#0f1f1d;color:#fff}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 10px;border-bottom:1px solid #23433c;text-align:left}th{opacity:.7}
.status{padding:10px;border-radius:10px;background:#0f1f1d;border:1px solid #23433c;white-space:pre-wrap;font-size:13px}
a{color:#7ee8c6}
</style></head>
<body>
<header><div><h1>🟢 Zoho Desk • Live Team Performance</h1><div class="sub">Served from SAME origin as proxy — no CORS, no tunnel, no localhost</div></div><div><span id="badge" class="badge demo">● DEMO</span></div></header>
<main>
<div class="card"><b>Same-Origin Connection</b><p style="opacity:.8">This dashboard is served by your Render proxy itself (<span id="origin"></span>), so <code>/api/health</code> and <code>/api/tickets</code> are same-origin fetches. No CORS, no sandbox block.</p>
<div class="row"><button onclick="connect()">Connect to Proxy</button><button class="sec" onclick="loadTickets()">Refresh Tickets</button></div>
<div id="status" class="status" style="margin-top:12px">Click Connect to Proxy to load live data.</div></div>
<div class="row">
<div class="card kpi"><span>Total (first 100)</span><b id="kTotal">—</b></div>
<div class="card kpi"><span>Open</span><b id="kOpen">—</b></div>
<div class="card kpi"><span>Closed</span><b id="kClosed">—</b></div>
<div class="card kpi"><span>On Hold / In Progress</span><b id="kOther">—</b></div>
</div>
<div class="card"><b>Live Tickets (first 100)</b><div style="overflow:auto;margin-top:10px"><table><thead><tr><th>#</th><th>Subject</th><th>Status</th><th>Channel</th><th>Created</th><th>Assignee ID</th></tr></thead><tbody id="tbody"><tr><td colspan="6" style="opacity:.7">Not connected yet.</td></tr></tbody></table></div></div>
<div class="card"><b>Debug</b><div class="status" id="debug">Health: <span id="healthUrl"></span><br>Tickets: <span id="ticketsUrl"></span></div></div>
</main>
<script>
document.getElementById('origin').textContent = location.origin;
document.getElementById('healthUrl').textContent = location.origin + '/api/health';
document.getElementById('ticketsUrl').textContent = location.origin + '/api/tickets?limit=100';
async function connect(){
  const s=document.getElementById('status'); s.textContent='Connecting to /api/health... (if Render was sleeping, this takes ~50s)';
  try{
    const r=await fetch('/api/health'); const j=await r.json();
    s.textContent='✅ Connected! Health: '+JSON.stringify(j,null,2);
    document.getElementById('badge').textContent='● LIVE'; document.getElementById('badge').className='badge live';
    await loadTickets();
  }catch(e){ s.textContent='❌ Failed: '+e.message+'\\n\\nIf this is same-origin and still fails, Render is sleeping. Open /api/health in a new tab, wait 60s, then Connect again.'; }
}
async function loadTickets(){
  const s=document.getElementById('status');
  try{
    const r=await fetch('/api/tickets?limit=100'); const j=await r.json();
    const list=j.data||j.tickets||j||[];
    const arr=Array.isArray(list)?list:[];
    document.getElementById('kTotal').textContent=arr.length;
    document.getElementById('kOpen').textContent=arr.filter(t=>String(t.status).toLowerCase().includes('open')).length;
    document.getElementById('kClosed').textContent=arr.filter(t=>String(t.status).toLowerCase().includes('closed')).length;
    document.getElementById('kOther').textContent=arr.length - arr.filter(t=>String(t.status).toLowerCase().includes('closed')).length - arr.filter(t=>String(t.status).toLowerCase().includes('open')).length;
    document.getElementById('tbody').innerHTML=arr.slice(0,100).map(t=>\`<tr><td>\${t.ticketNumber||t.id||''}</td><td>\${(t.subject||'').replace(/</g,'&lt;')}</td><td>\${t.status||''}</td><td>\${t.channel||''}</td><td>\${(t.createdTime||'').slice(0,10)}</td><td>\${t.assigneeId||''}</td></tr>\`).join('')||'<tr><td colspan="6">No tickets returned</td></tr>';
    s.textContent='✅ Loaded '+arr.length+' tickets from LIVE proxy';
    document.getElementById('badge').textContent='● LIVE'; document.getElementById('badge').className='badge live';
  }catch(e){ s.textContent='❌ Tickets failed: '+e.message; }
}
</script></body></html>
`;
app.get('/', (req, res) => { res.setHeader('Content-Type','text/html'); res.send(DASHBOARD_HTML); });
app.get('/dashboard', (req, res) => { res.setHeader('Content-Type','text/html'); res.send(DASHBOARD_HTML); });

// ---------- CONFIG - ALL FROM .env, NEVER hardcode ----------
const DC = process.env.ZOHO_DC || 'com'; // com, eu, in, au
const ORG_ID = process.env.ZOHO_ORG_ID;
const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const PORT = process.env.PORT || 3001;

const DESK_BASE = `https://desk.zoho.${DC}/api/v1`;
const ACCOUNTS_BASE = `https://accounts.zoho.${DC}/oauth/v2/token`;

// ---------- TOKEN CACHE ----------
let tokenCache = { accessToken: null, expiresAt: 0 };

async function refreshAccessToken() {
  console.log('[Zoho] Refreshing access token...');
  const params = new URLSearchParams({
    refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${ACCOUNTS_BASE}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    console.error('[Zoho] Refresh failed:', data);
    throw new Error('Token refresh failed: ' + JSON.stringify(data));
  }
  // Refresh 5 mins early
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - (5 * 60 * 1000),
  };
  console.log('[Zoho] Token refreshed, valid until', new Date(tokenCache.expiresAt).toISOString());
  return tokenCache.accessToken;
}

async function getValidToken() {
  if (!tokenCache.accessToken || Date.now() >= tokenCache.expiresAt) {
    return await refreshAccessToken();
  }
  return tokenCache.accessToken;
}

// ---------- ZOHO CALLER WITH 401 RETRY ----------
async function zoho(path, orgId = ORG_ID) {
  let token = await getValidToken();
  let res = await fetch(DESK_BASE + path, {
    headers: { Authorization: 'Zoho-oauthtoken ' + token, orgId },
  });
  // Auto-retry once on 401
  if (res.status === 401) {
    console.log('[Zoho] 401 - refreshing and retrying', path);
    token = await refreshAccessToken();
    res = await fetch(DESK_BASE + path, {
      headers: { Authorization: 'Zoho-oauthtoken ' + token, orgId },
    });
  }
  return res;
}

// ---------- SSE CLIENTS ----------
let sseClients = [];
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  sseClients = sseClients.filter(c => !c.destroyed);
  sseClients.forEach(c => c.write(payload));
  console.log('[SSE] Broadcast:', event.type, event.ticketNumber || '');
}

// ---------- API ROUTES (PROXY) ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    dc: DC,
    orgId: ORG_ID ? 'set' : 'missing',
    tokenValidUntil: tokenCache.expiresAt ? new Date(tokenCache.expiresAt).toISOString() : null,
    expiresInSec: tokenCache.expiresAt ? Math.max(0, Math.floor((tokenCache.expiresAt - Date.now()) / 1000)) : 0,
    sseClients: sseClients.length,
    lastWebhookAt: lastWebhookAt,
  });
});

app.get('/api/tickets', async (req, res) => {
  try {
    const qs = new URLSearchParams({
      limit: Math.min(parseInt(req.query.limit || '100'), 100).toString(),
      sortBy: 'modifiedTime',
      ...(req.query.departmentId ? { departmentId: req.query.departmentId } : {}),
      ...(req.query.from ? { from: req.query.from } : {}),
    }).toString();
    const r = await zoho(`/tickets?${qs}`, req.query.orgId);
    res.status(r.status).send(await r.text());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agents', async (req, res) => {
  try {
    const r = await zoho(`/agents?${new URLSearchParams(req.query).toString()}`, req.query.orgId);
    res.status(r.status).send(await r.text());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/departments', async (req, res) => {
  try {
    const r = await zoho('/departments', req.query.orgId);
    res.status(r.status).send(await r.text());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/threads', async (req, res) => {
  try {
    const r = await zoho(`/tickets/${req.params.id}/threads`, req.query.orgId);
    res.status(r.status).send(await r.text());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- WEBHOOK ----------
let lastWebhookAt = null;
let webhookLog = [];

app.post('/webhook/zoho', (req, res) => {
  const body = req.body || {};
  // Zoho sends different shapes - handle both
  const ticket = body.ticket || body || {};
  const event = {
    type: body.event || 'ticket.updated',
    ticketNumber: ticket.ticketNumber || ticket.ticket_number || 'unknown',
    subject: ticket.subject || '',
    status: ticket.status || ticket.statusType || '',
    priority: ticket.priority || '',
    assignee: ticket.assignee?.firstName ? `${ticket.assignee.firstName} ${ticket.assignee.lastName || ''}` : (ticket.assignee || ''),
    department: ticket.department?.name || ticket.departmentId || '',
    modifiedTime: ticket.modifiedTime || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };
  lastWebhookAt = event.receivedAt;
  webhookLog.unshift(event);
  webhookLog = webhookLog.slice(0, 100);
  console.log('[Webhook] Received:', event);
  broadcast(event);
  // Must respond 200 quickly or Zoho retries
  res.status(200).json({ ok: true });
});

app.get('/api/webhook-log', (req, res) => res.json(webhookLog));

// ---------- SSE STREAM ----------
app.get('/webhook/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`);
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

app.listen(PORT, () => {
  console.log(`\n✅ Zoho Desk Proxy running on port ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`   Tickets: http://localhost:${PORT}/api/tickets`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook/zoho`);
  console.log(`   SSE:     GET  http://localhost:${PORT}/webhook/stream`);
  console.log(`   DC: ${DC} | Org: ${ORG_ID ? 'set' : 'MISSING - set .env'}\n`);
});
