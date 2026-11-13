require('dotenv').config();
// ============================================================
// Zoho Desk Live Dashboard - Backend Server
// Proxy + Auto Refresh + Webhook + SSE
// Deploy to Render / Railway / VPS
// ============================================================
const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN?.split(',') || '*',
  methods: ['GET','POST'],
}));

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
