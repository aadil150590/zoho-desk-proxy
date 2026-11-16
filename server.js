
// ============================================================
// Zoho Desk Live Dashboard - Backend Server
// Proxy + Auto Refresh + Webhook + SSE
// Deploy to Render / Railway / VPS
// ============================================================
const express = require('express');
const app = express();
// CORS - manual, no cors package needed
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

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
    const limit = Math.min(parseInt(req.query.limit || '100'), 100);
    const from = parseInt(req.query.from || '1');
    const deptFilter = req.query.departmentId;
    const statusFilter = req.query.status; // Open / Closed / On Hold / In Progress
    const mode = req.query.mode || 'recent'; // recent = newest first via search + status
    // Helper to call Zoho and parse array
    const callZoho = async (path) => {
      try {
        const r = await zoho(path, req.query.orgId);
        const txt = await r.text();
        let j; try { j = JSON.parse(txt); } catch { return []; }
        if (j.error || j.errorCode) { console.log('[Tickets] Zoho error for', path, JSON.stringify(j).slice(0,200)); return []; }
        return Array.isArray(j) ? j : (j.data || j.tickets || []);
      } catch(e){ console.log('[Tickets] fetch fail', path, e.message); return []; }
    };
    // Departments list
    let deptIds = [];
    let deptMap = {}; // id -> name
    try {
      const dr = await zoho('/departments', req.query.orgId);
      const dj = await dr.json();
      const dlist = Array.isArray(dj) ? dj : (dj.data || dj.departments || []);
      dlist.forEach(d=>{ const id=d.id||d.departmentId; if(id){ deptIds.push(String(id)); deptMap[String(id)]=d.name||d.departmentName||String(id); } });
    } catch(e){}
    const targetDepts = deptFilter ? [String(deptFilter)] : (deptIds.length?deptIds:[null]);
    // 30 days ago for recent search
    const thirtyAgo = new Date(Date.now()-30*24*3600*1000).toISOString().split('.')[0]+'Z';
    const ninetyAgo = new Date(Date.now()-90*24*3600*1000).toISOString().split('.')[0]+'Z';
    let all = [];
    // If a specific status is requested, fetch that status directly (Zoho supports ?status=Open)
    // Else fetch Open + In Progress + On Hold + recent-modified in parallel so newest + open appear first
    const statuses = statusFilter ? [statusFilter] : ['Open','On Hold','In Progress'];
    const jobs = [];
    for (const did of targetDepts) {
      const deptQs = did ? `&departmentId=${did}` : '';
      // Open / Hold / Progress per dept
      for (const st of statuses) {
        jobs.push(callZoho(`/tickets?limit=${limit}&from=1&sortBy=modifiedTime${deptQs}&status=${encodeURIComponent(st)}`));
      }
      // Recent search: tickets modified in last 90 days (catches recent Closed too)
      // Zoho search criteria: (modifiedTime:greater_than:2025-...)
      // If search fails, it returns [] and we fallback below
      jobs.push(callZoho(`/tickets/search?criteria=(modifiedTime:greater_than:${encodeURIComponent(ninetyAgo)})&limit=${limit}${deptQs}`));
      // Recent created search
      jobs.push(callZoho(`/tickets/search?criteria=(createdTime:greater_than:${encodeURIComponent(thirtyAgo)})&limit=${limit}${deptQs}`));
    }
    const results = await Promise.all(jobs);
    results.flat().forEach(t=>{ if(t) all.push(t); });
    // Fallback: if search+status returned nothing (e.g. Zoho ignores those params), fetch plain list per dept
    if (all.length===0) {
      const fb = [];
      for (const did of targetDepts) {
        const deptQs = did ? `&departmentId=${did}` : '';
        fb.push(callZoho(`/tickets?limit=${limit}&from=${from}&sortBy=modifiedTime${deptQs}`));
      }
      const fbRes = await Promise.all(fb);
      fbRes.flat().forEach(t=>{ if(t) all.push(t); });
    }
    // Enrich with department name
    all.forEach(t=>{ const did=String(t.departmentId||t.department?.id||''); if(did&&deptMap[did]) t._deptName=deptMap[did]; else if(t.department?.name) t._deptName=t.department.name; });
    // De-dupe, sort NEWEST FIRST by createdTime desc, then modifiedTime desc
    const map = new Map();
    all.forEach(t=>map.set(t.ticketNumber||t.id, t));
    const merged = [...map.values()].sort((a,b)=>{
      const ca=new Date(b.createdTime||0)-new Date(a.createdTime||0);
      if(ca!==0) return ca;
      return new Date(b.modifiedTime||0)-new Date(a.modifiedTime||0);
    });
    // If caller asked for page 2 (from=101), slice accordingly after sorting newest first
    const sliced = merged.slice(from-1, from-1+limit);
    return res.json({ data: sliced, _departments: targetDepts.length, _totalMerged: merged.length, _deptMap: deptMap });
  } catch(e){ res.status(500).json({ error: e.message }); }
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


// ---------- EMBEDDED DASHBOARD - SAME ORIGIN ----------
const DASHBOARD_HTML = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Zoho Desk \u2022 Live Team Performance</title>\n<style>\nbody{background:#0e1513;color:#e8f5ef;font-family:system-ui;margin:0;padding:20px}h1{margin:0}.badge{background:#22c55e;color:#000;padding:6px 12px;border-radius:20px;font-weight:700}.card{background:#1a2b26;border-radius:14px;padding:16px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.kpi{background:#1a2b26;border-radius:12px;padding:14px}.kpi b{font-size:28px;display:block}.kpi small{color:#9fb8a8}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.tabs button{background:#1a2b26;color:#fff;border:1px solid #2d4a3a;padding:10px 14px;border-radius:8px;cursor:pointer}.tabs button.active{background:#14b8a6;color:#000;font-weight:700}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #2d4a3a;text-align:left}input,select{padding:8px;border-radius:8px;border:1px solid #2d4a3a;background:#0e1513;color:#fff;margin:4px}.btn{background:#14b8a6;color:#000;padding:10px 16px;border:none;border-radius:8px;font-weight:700;cursor:pointer}.muted{color:#9fb8a8;font-size:13px}.pill{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700}.pill.Open{background:#2563eb}.pill.Closed,.pill.Resolved{background:#16a34a}.pill.InProgress,.pill.In{background:#f59e0b;color:#000}.pill.OnHold{background:#8b5cf6}.donut{width:130px;height:130px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800}.bar{height:10px;background:#2d4a3a;border-radius:5px;overflow:hidden}.bar>div{height:100%;background:#14b8a6}.avatar{width:32px;height:32px;border-radius:50%;background:#14b8a6;color:#000;display:inline-flex;align-items:center;justify-content:center;font-weight:800;margin-right:8px}\n</style></head>\n<body><h1>Zoho Desk \u2022 Live Team Performance <span class=\"badge\">\u25cf LIVE</span></h1><p class=\"muted\">Served from SAME origin as proxy \u2014 no CORS. Newest tickets on top. Links open the ticket in Zoho Desk.</p>\n<div class=\"card\"><button class=\"btn\" onclick=\"load()\">Connect to Proxy</button> <button class=\"btn\" onclick=\"load()\">Refresh Tickets</button> <span id=\"status\" style=\"margin-left:10px\">Click Connect</span><div id=\"agentStatus\" class=\"muted\"></div><div id=\"deptStatus\" class=\"muted\"></div></div>\n<div class=\"grid\" id=\"kpis\"></div>\n<div class=\"tabs\"><button onclick=\"show('team',this)\" class=\"active\">Team Performance</button><button onclick=\"show('overview',this)\">Overview</button><button onclick=\"show('daily',this)\">Daily Report</button><button onclick=\"show('agent',this)\">Agent Wise</button><button onclick=\"show('kam',this)\">KAM Wise</button><button onclick=\"show('leader',this)\">Leaderboard</button></div>\n<div class=\"card\">\n<label>Search <input id=\"q\" oninput=\"render()\" placeholder=\"subject / contact / ticket # / assignee\"></label>\n<label>Status <select id=\"fstatus\" onchange=\"render()\"><option value=\"\">All</option><option>Open</option><option>Closed</option><option>On Hold</option><option>In Progress</option></select></label>\n<label>Department <select id=\"fdept\" onchange=\"onDeptChange()\"><option value=\"\">All Departments</option></select></label>\n<label>Priority <select id=\"fpri\" onchange=\"render()\"><option value=\"\">All</option><option>High</option><option>Medium</option><option>Low</option></select></label>\n<label>Channel <select id=\"fchan\" onchange=\"render()\"><option value=\"\">All</option><option>Email</option><option>Phone</option><option>Web</option><option>Chat</option></select></label>\n<label>Sort <select id=\"sort\" onchange=\"render()\"><option value=\"recent\">Newest First (default)</option><option value=\"open\">Open First</option><option value=\"oldest\">Oldest First</option></select></label>\n<button class=\"btn\" onclick=\"exportCSV()\">Export CSV</button> <button class=\"btn\" onclick=\"resetFilters()\">Reset</button> <span id=\"shownCount\" class=\"muted\"></span>\n</div>\n<div id=\"team\" class=\"tab\">\n<div class=\"card\"><h3>Team Performance <select id=\"teamSort\" onchange=\"render()\" style=\"float:right\"><option value=\"resolved\">Sort: Resolved</option><option value=\"assigned\">Sort: Assigned</option><option value=\"fastest\">Sort: Fastest response</option><option value=\"sla\">Sort: SLA compliance</option></select></h3><div id=\"teamBars\"></div><div id=\"liveFeed\"></div></div>\n<div class=\"card\"><h3>Agent table</h3><p class=\"muted\">Grouped by assignee. Avg Response = first response proxy (modified - created for first touch, else \u2014). SLA = not breached if dueDate in future or Closed on time.</p><div id=\"agentTableTeam\"></div></div>\n</div>\n<div id=\"overview\" class=\"tab\" style=\"display:none\">\n<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px\"><div class=\"card\"><h3>Tickets by Status</h3><div id=\"statusDonut\" style=\"display:flex;gap:16px;align-items:center\"></div></div><div class=\"card\"><h3>Tickets by Priority</h3><div id=\"priBars\"></div><h3 style=\"margin-top:16px\">Tickets by Channel</h3><div id=\"chanBars\"></div></div><div class=\"card\"><h3>Created \u2014 last 7 days</h3><div id=\"weekBars\"></div><p class=\"muted\">Bucketed by createdTime.</p></div></div>\n<div class=\"card\"><h3>Recent tickets \u2014 newest first</h3><p class=\"muted\">Links open the matching ticket in Zoho Desk.</p><div id=\"tickets\"></div></div>\n</div>\n<div id=\"daily\" class=\"tab\" style=\"display:none\"><div class=\"card\"><label>Date <input type=\"date\" id=\"d\" onchange=\"render()\"></label> <button class=\"btn\" onclick=\"setToday()\">Today</button> <button class=\"btn\" onclick=\"setDays(7)\">Last 7 Days</button> <button class=\"btn\" onclick=\"setDays(30)\">Last 30 Days</button><div id=\"dailyOut\"></div></div></div>\n<div id=\"agent\" class=\"tab\" style=\"display:none\"><div class=\"card\"><h3>Agent Wise</h3><div id=\"agentOut\"></div></div></div>\n<div id=\"kam\" class=\"tab\" style=\"display:none\"><div class=\"card\"><h3>KAM Wise</h3><p class=\"muted\">KAM = Key Account Manager. Uses kam / customFields.kam / cf_kam / accountName if present, else Agent name.</p><div id=\"kamOut\"></div></div></div>\n<div id=\"leader\" class=\"tab\" style=\"display:none\"><div class=\"card\"><h3>Leaderboard / Top Performer</h3><div id=\"leaderOut\"></div><div id=\"avgOut\"></div></div></div>\n<script>\nlet ALL=[]; let AGENTS={}; let DEPTS={}; let rangeDays=0; let deptFilter='';\nfunction fmt(d){return d?new Date(d).toISOString().slice(0,10):'\u2014'}\nfunction fmtDT(d){if(!d)return '\u2014'; const x=new Date(d); return x.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+', '+x.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}\nfunction hrs(a,b){if(!a||!b)return null;return Math.max(0,(new Date(b)-new Date(a))/36e5)}\nfunction agentOf(t){\n  if(t.assignee && (t.assignee.firstName||t.assignee.name)) return ((t.assignee.firstName||'')+' '+(t.assignee.lastName||'')).trim() || t.assignee.name;\n  if(t.assignee && typeof t.assignee==='string') return AGENTS[t.assignee]||t.assignee;\n  const id = t.assigneeId || t.assignee?.id || '';\n  if(id && AGENTS[id]) return AGENTS[id];\n  if(t.assigneeId) return 'Agent '+String(t.assigneeId).slice(-4);\n  return 'Unassigned';\n}\nfunction initials(n){return n.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}\nfunction deptOf(t){return t._deptName || t.department?.name || t.departmentId || '\u2014'}\nfunction kamOf(t){return t.kam||t.customFields?.kam||t.cf_kam||t.accountName||t.account?.name||agentOf(t)}\nfunction statusOf(t){return t.status||'\u2014'}\nfunction normStatus(s){ if(s==='Resolved')return 'Closed'; return s; }\nfunction deskLink(t){ const n=t.ticketNumber||t.id; return `https://desk.zoho.com/agent/petpooja1/tickets/${t.id||n}/details`; }\nfunction pill(s){ const c=s==='Open'?'Open':s==='Closed'||s==='Resolved'?'Closed':s==='In Progress'?'InProgress':s==='On Hold'?'OnHold':''; return `<span class=\"pill ${c}\">${s}</span>`; }\nasync function loadDepts(){\n  try{ const r=await fetch('/api/departments'); const j=await r.json(); const list=Array.isArray(j)?j:(j.data||j.departments||[]); const sel=document.getElementById('fdept'); sel.innerHTML='<option value=\"\">All Departments</option>'; list.forEach(d=>{ const id=d.id||d.departmentId; const name=d.name||d.departmentName||id; DEPTS[String(id)]=name; const o=document.createElement('option'); o.value=String(id); o.textContent=name; sel.appendChild(o); }); if(deptFilter) sel.value=deptFilter; document.getElementById('deptStatus').textContent='Departments: '+list.map(d=>d.name).join(', '); }catch(e){}\n}\nasync function loadAgents(){\n  try{ const r=await fetch('/api/agents?limit=100'); const j=await r.json(); const list=Array.isArray(j)?j:(j.data||j.agents||[]); list.forEach(a=>{ const id=a.id||a.agentId; const name=((a.firstName||'')+' '+(a.lastName||'')).trim()||a.name||a.email; if(id&&name) AGENTS[String(id)]=name; }); document.getElementById('agentStatus').textContent='Agents loaded: '+Object.keys(AGENTS).length+' names mapped from /api/agents'; }catch(e){}\n}\nasync function load(){\n  document.getElementById('status').textContent='Loading...';\n  try{\n    await loadDepts(); await loadAgents();\n    const deptQs = deptFilter ? `&departmentId=${encodeURIComponent(deptFilter)}` : '';\n    const r1=await fetch(`/api/tickets?limit=100&from=1&mode=recent${deptQs}`); const j1=await r1.json();\n    let a1=Array.isArray(j1)?j1:(j1.data||j1.tickets||[]);\n    if(j1.error||j1.errorCode) throw new Error(JSON.stringify(j1).slice(0,300));\n    let a2=[]; try{ const r2=await fetch(`/api/tickets?limit=100&from=101&mode=recent${deptQs}`); const j2=await r2.json(); a2=Array.isArray(j2)?j2:(j2.data||j2.tickets||[]); }catch(e){}\n    const map=new Map(); [...a1,...a2].forEach(t=>map.set(t.ticketNumber||t.id,t)); ALL=[...map.values()];\n    // Client-side: ALWAYS newest first by createdTime\n    ALL.sort((a,b)=>new Date(b.createdTime||0)-new Date(a.createdTime||0));\n    document.getElementById('status').textContent=`\u2705 Loaded ${ALL.length} tickets from LIVE proxy (page1: ${a1.length}, page2: ${a2.length}) \u2014 newest first`;\n    if(!document.getElementById('d').value) document.getElementById('d').value=new Date().toISOString().slice(0,10);\n    render();\n  }catch(e){ document.getElementById('status').textContent='\u274c Failed: '+e.message; }\n}\nfunction onDeptChange(){ deptFilter=document.getElementById('fdept').value; load(); }\nfunction resetFilters(){ document.getElementById('q').value=''; document.getElementById('fstatus').value=''; document.getElementById('fdept').value=''; deptFilter=''; document.getElementById('fpri').value=''; document.getElementById('fchan').value=''; document.getElementById('sort').value='recent'; load(); }\nfunction filtered(){\n  let arr=[...ALL];\n  const q=(document.getElementById('q').value||'').toLowerCase();\n  const fs=document.getElementById('fstatus').value;\n  const fp=document.getElementById('fpri').value;\n  const fc=document.getElementById('fchan').value;\n  if(q) arr=arr.filter(t=>(t.subject||'').toLowerCase().includes(q)||String(t.ticketNumber).includes(q)||agentOf(t).toLowerCase().includes(q)||(t.contact?.name||t.contactName||'').toLowerCase().includes(q));\n  if(fs) arr=arr.filter(t=>normStatus(statusOf(t))===fs || statusOf(t)===fs);\n  if(fp) arr=arr.filter(t=>(t.priority||'')===fp);\n  if(fc) arr=arr.filter(t=>(t.channel||'')===fc);\n  const s=document.getElementById('sort').value;\n  if(s==='recent') arr.sort((a,b)=>new Date(b.createdTime||0)-new Date(a.createdTime||0));\n  if(s==='oldest') arr.sort((a,b)=>new Date(a.createdTime||0)-new Date(b.createdTime||0));\n  if(s==='open') arr.sort((a,b)=>((normStatus(statusOf(a))==='Closed')-(normStatus(statusOf(b))==='Closed'))||(new Date(b.createdTime||0)-new Date(a.createdTime||0)));\n  return arr;\n}\nfunction groupBy(fn){\n  const m={}; filtered().forEach(t=>{const k=fn(t); if(!m[k])m[k]={name:k,total:0,open:0,closed:0,hold:0,resH:[],respH:[],slaOk:0,slaTotal:0}; m[k].total++; const st=normStatus(statusOf(t)); if(st==='Closed'){m[k].closed++; const h=hrs(t.createdTime,t.closedTime||t.modifiedTime); if(h!=null)m[k].resH.push(h);} else if(st==='On Hold'||st==='In Progress')m[k].hold++; else m[k].open++; const resp=hrs(t.createdTime,t.firstResponseTime||t.customerResponseTime||t.modifiedTime); if(resp!=null) m[k].respH.push(resp); const due=t.dueDate||t.due_date; if(due){ m[k].slaTotal++; const breached = new Date(due)<new Date() && st!=='Closed'; if(!breached) m[k].slaOk++; }});\n  return Object.values(m).map(x=>({...x,rate:x.total?Math.round(x.closed/x.total*100):0,avgRes:x.resH.length?(x.resH.reduce((a,b)=>a+b,0)/x.resH.length).toFixed(1):'\u2014',avgResp:x.respH.length?(x.respH.reduce((a,b)=>a+b,0)/x.respH.length*60).toFixed(0)+' min':'\u2014',sla:x.slaTotal?Math.round(x.slaOk/x.slaTotal*100)+'%':'\u2014'}));\n}\nfunction render(){\n  const arr=filtered();\n  document.getElementById('shownCount').textContent=`${arr.length} tickets shown`;\n  const today=new Date().toISOString().slice(0,10);\n  const createdToday=ALL.filter(t=>fmt(t.createdTime)===today).length;\n  const closedToday=ALL.filter(t=>t.closedTime&&fmt(t.closedTime)===today).length;\n  const open=ALL.filter(t=>normStatus(statusOf(t))!=='Closed').length, closed=ALL.filter(t=>normStatus(statusOf(t))==='Closed').length;\n  const res=ALL.filter(t=>t.closedTime).map(t=>hrs(t.createdTime,t.closedTime)).filter(v=>v!=null);\n  const avgRes=res.length?(res.reduce((a,b)=>a+b,0)/res.length).toFixed(1):'\u2014';\n  const respAll=ALL.map(t=>hrs(t.createdTime,t.firstResponseTime||t.customerResponseTime)).filter(v=>v!=null);\n  const avgResp=respAll.length?Math.round(respAll.reduce((a,b)=>a+b,0)/respAll.length*60)+' min':'\u2014';\n  const slaBreached=ALL.filter(t=>t.dueDate && new Date(t.dueDate)<new Date() && normStatus(statusOf(t))!=='Closed').length;\n  const slaPct=ALL.length?Math.round(slaBreached/ALL.length*100)+'%':'\u2014';\n  document.getElementById('kpis').innerHTML=`<div class=\"kpi\">TOTAL TICKETS<b>${ALL.length}</b><small>In current filters: ${arr.length}</small></div><div class=\"kpi\">OPEN<b>${open}</b><small>statusType \u2260 Closed</small></div><div class=\"kpi\">RESOLVED<b>${closed}</b><small>statusType = Closed</small></div><div class=\"kpi\">AVG FIRST RESPONSE<b>${avgResp}</b><small>From ticket threads</small></div><div class=\"kpi\">AVG RESOLUTION<b>${avgRes} h</b><small>closed \u2212 created</small></div><div class=\"kpi\">SLA BREACHED<b>${slaPct}</b><small>${slaBreached} ticket(s)</small></div>`;\n  // Team Performance\n  let ag=groupBy(agentOf);\n  const teamSort=document.getElementById('teamSort').value;\n  if(teamSort==='resolved') ag.sort((a,b)=>b.closed-a.closed);\n  if(teamSort==='assigned') ag.sort((a,b)=>b.total-a.total);\n  if(teamSort==='fastest') ag.sort((a,b)=>parseFloat(a.avgResp)-parseFloat(b.avgResp));\n  if(teamSort==='sla') ag.sort((a,b)=>parseFloat(b.sla)-parseFloat(a.sla));\n  const maxClosed=Math.max(1,...ag.map(x=>x.closed));\n  document.getElementById('teamBars').innerHTML=ag.slice(0,8).map(x=>`<div style=\"display:flex;justify-content:space-between;padding:6px 0\"><span><span class=\"avatar\">${initials(x.name)}</span>${x.name}</span><span>${x.closed} resolved \u2022 ${x.sla} SLA</span></div><div class=\"bar\"><div style=\"width:${Math.round(x.closed/maxClosed*100)}%\"></div></div>`).join('');\n  // Live feed = 6 newest by modifiedTime\n  const feed=[...ALL].sort((a,b)=>new Date(b.modifiedTime||b.createdTime)-new Date(a.modifiedTime||a.createdTime)).slice(0,6);\n  document.getElementById('liveFeed').innerHTML='<h4>Live Activity Feed</h4>'+feed.map(t=>`<div style=\"padding:6px 0\">\u25cf Ticket #${t.ticketNumber} \u2014 ${(t.subject||'').slice(0,60)} \u2022 ${agentOf(t)} \u2022 ${pill(statusOf(t))}</div>`).join('')+'<p class=\"muted\">Live mode refreshes this feed from ticket activities and modifiedTime.</p>';\n  document.getElementById('agentTableTeam').innerHTML='<table><tr><th>AGENT</th><th>ASSIGNED</th><th>RESOLVED</th><th>OPEN</th><th>AVG RESPONSE</th><th>AVG RESOLUTION</th><th>SLA COMPLIANCE</th></tr>'+ag.map(x=>`<tr><td><span class=\"avatar\">${initials(x.name)}</span>${x.name}</td><td>${x.total}</td><td>${x.closed}</td><td>${x.open}</td><td>${x.avgResp}</td><td>${x.avgRes} h</td><td>${x.sla}</td></tr>`).join('')+'</table>';\n  // Overview visuals\n  const byStatus={}; arr.forEach(t=>{const s=normStatus(statusOf(t)); byStatus[s]=(byStatus[s]||0)+1});\n  const totalS=arr.length||1; const resC=byStatus['Closed']||0, openC=byStatus['Open']||0, progC=byStatus['In Progress']||0, holdC=byStatus['On Hold']||0;\n  const pRes=Math.round(resC/totalS*360), pOpen=Math.round(openC/totalS*360), pProg=Math.round(progC/totalS*360);\n  document.getElementById('statusDonut').innerHTML=`<div class=\"donut\" style=\"background:conic-gradient(#16a34a 0 ${pRes}deg, #2563eb ${pRes}deg ${pRes+pOpen}deg, #f59e0b ${pRes+pOpen}deg ${pRes+pOpen+pProg}deg, #8b5cf6 ${pRes+pOpen+pProg}deg 360deg)\"><span>${arr.length}<br><small>TICKETS</small></span></div><div>Resolved ${resC}<br>Open ${openC}<br>In Progress ${progC}<br>On Hold ${holdC}</div>`;\n  const byPri={}; arr.forEach(t=>{byPri[t.priority||'\u2014']=(byPri[t.priority||'\u2014']||0)+1});\n  document.getElementById('priBars').innerHTML=Object.entries(byPri).map(([k,v])=>`<div style=\"display:flex;justify-content:space-between\"><span>${k}</span><b>${v}</b></div><div class=\"bar\"><div style=\"width:${Math.round(v/totalS*100)}%;background:${k==='High'?'#ef4444':k==='Medium'?'#f59e0b':'#22c55e'}\"></div></div>`).join('');\n  const byChan={}; arr.forEach(t=>{byChan[t.channel||'\u2014']=(byChan[t.channel||'\u2014']||0)+1});\n  document.getElementById('chanBars').innerHTML=Object.entries(byChan).map(([k,v])=>`<div style=\"display:flex;justify-content:space-between\"><span>${k}</span><b>${v}</b></div>`).join('');\n  let week=''; for(let i=6;i>=0;i--){const d=new Date(); d.setDate(d.getDate()-i); const ds=d.toISOString().slice(0,10); const c=ALL.filter(t=>fmt(t.createdTime)===ds).length; week+=`<div style=\"text-align:center\"><div style=\"height:${Math.min(c*12,80)}px;background:#14b8a6;width:24px;margin:0 auto;border-radius:4px\"></div><div>${d.toLocaleDateString('en-GB',{weekday:'short'})}</div><b>${c}</b></div>`;} document.getElementById('weekBars').innerHTML=`<div style=\"display:flex;gap:10px;justify-content:space-between\">${week}</div>`;\n  // Recent tickets with Desk link\n  document.getElementById('tickets').innerHTML='<table><tr><th>TICKET</th><th>SUBJECT</th><th>CONTACT</th><th>ASSIGNEE</th><th>STATUS</th><th>PRIORITY</th><th>CREATED</th><th>OPEN</th></tr>'+arr.slice(0,50).map(t=>`<tr><td>#${t.ticketNumber||''}</td><td><b>${(t.subject||'').slice(0,60)}</b><br><small class=\"muted\">${(t.description||'').slice(0,80)}</small></td><td>${t.contact?.name||t.contactName||'\u2014'}<br><small>${t.contact?.email||t.contactEmail||''}</small></td><td>${agentOf(t)}</td><td>${pill(statusOf(t))}</td><td>${t.priority||'\u2014'}</td><td>${fmtDT(t.createdTime)}</td><td><a href=\"${deskLink(t)}\" target=\"_blank\" rel=\"noopener\" style=\"color:#14b8a6\">Open in Desk \u2192</a></td></tr>`).join('')+'</table><p class=\"muted\">Showing '+Math.min(arr.length,50)+' of '+arr.length+' \u2014 newest first by createdTime</p>';\n  // Daily\n  const sel=document.getElementById('d').value||today;\n  let dailyArr=ALL; if(rangeDays>0){const cut=new Date(); cut.setDate(cut.getDate()-rangeDays); dailyArr=ALL.filter(t=>new Date(t.createdTime)>=cut);} else dailyArr=ALL.filter(t=>fmt(t.createdTime)===sel);\n  const dClosed=ALL.filter(t=>t.closedTime&&(rangeDays>0?new Date(t.closedTime)>=new Date(new Date().setDate(new Date().getDate()-rangeDays)):fmt(t.closedTime)===sel)).length;\n  document.getElementById('dailyOut').innerHTML=`<p><b>${rangeDays>0?'Last '+rangeDays+' days':'Date '+sel}</b>: Created ${dailyArr.length}, Closed ${dClosed}, Still Open ${dailyArr.filter(t=>normStatus(statusOf(t))!=='Closed').length}</p><table><tr><th>#</th><th>Subject</th><th>Status</th><th>Agent</th><th>Created</th><th>Open</th></tr>`+dailyArr.slice(0,100).map(t=>`<tr><td>#${t.ticketNumber}</td><td>${(t.subject||'').slice(0,70)}</td><td>${pill(statusOf(t))}</td><td>${agentOf(t)}</td><td>${fmtDT(t.createdTime)}</td><td><a href=\"${deskLink(t)}\" target=\"_blank\" style=\"color:#14b8a6\">Open \u2192</a></td></tr>`).join('')+'</table>';\n  // Agent / KAM / Leader\n  const ag2=groupBy(agentOf).sort((a,b)=>b.closed-a.closed);\n  document.getElementById('agentOut').innerHTML='<table><tr><th>Agent</th><th>Total</th><th>Open</th><th>Hold</th><th>Closed</th><th>Closure %</th><th>Avg Res hrs</th><th>Avg Resp</th><th>SLA</th></tr>'+ag2.map(x=>`<tr><td>${x.name}</td><td>${x.total}</td><td>${x.open}</td><td>${x.hold}</td><td>${x.closed}</td><td>${x.rate}%</td><td>${x.avgRes}</td><td>${x.avgResp}</td><td>${x.sla}</td></tr>`).join('')+'</table>';\n  const km=groupBy(kamOf).sort((a,b)=>b.closed-a.closed);\n  document.getElementById('kamOut').innerHTML='<table><tr><th>KAM</th><th>Total</th><th>Open</th><th>Closed</th><th>Closure %</th><th>Avg Res hrs</th></tr>'+km.map(x=>`<tr><td>${x.name}</td><td>${x.total}</td><td>${x.open}</td><td>${x.closed}</td><td>${x.rate}%</td><td>${x.avgRes}</td></tr>`).join('')+'</table>';\n  const sorted=[...ag2].sort((a,b)=>b.closed-a.closed); const fastest=[...ag2].filter(x=>x.closed>=1&&x.avgRes!=='\u2014').sort((a,b)=>parseFloat(a.avgRes)-parseFloat(b.avgRes));\n  document.getElementById('topPerf') && (document.getElementById('topPerf').innerHTML='');\n  const withScore=ag2.map(x=>({...x,score:Math.round(x.closed*(x.rate/100)- (x.avgRes==='\u2014'?0:parseFloat(x.avgRes)*0.1))})).sort((a,b)=>b.score-a.score);\n  document.getElementById('leaderOut').innerHTML='<h4>Top 3: Most Closed: '+(sorted[0]?.name||'\u2014')+' \u2022 Fastest: '+(fastest[0]?.name||'\u2014')+'</h4><table><tr><th>Rank</th><th>Agent</th><th>Closed</th><th>Open</th><th>Total</th><th>Closure %</th><th>Avg Res</th><th>Score</th></tr>'+withScore.map((x,i)=>`<tr><td>${i+1}</td><td>${x.name}</td><td>${x.closed}</td><td>${x.open}</td><td>${x.total}</td><td>${x.rate}%</td><td>${x.avgRes}</td><td>${x.score}</td></tr>`).join('')+'</table>';\n  document.getElementById('avgOut').innerHTML=`<p class=\"muted\">Avg tickets per agent: ${ag2.length?(ALL.length/ag2.length).toFixed(1):'\u2014'} \u2022 Avg resolution: ${avgRes} hrs</p>`;\n}\nfunction show(id,btn){document.querySelectorAll('.tab').forEach(e=>e.style.display='none'); document.getElementById(id).style.display='block'; document.querySelectorAll('.tabs button').forEach(b=>b.classList.remove('active')); btn.classList.add('active');}\nfunction setToday(){rangeDays=0; document.getElementById('d').value=new Date().toISOString().slice(0,10); render();}\nfunction setDays(n){rangeDays=n; render();}\nfunction exportCSV(){const arr=filtered(); const rows=[['Ticket','Subject','Status','Channel','Created','Agent','Department']]; arr.forEach(t=>rows.push([t.ticketNumber,(t.subject||'').replace(/,/g,' '),statusOf(t),t.channel||'',fmt(t.createdTime),agentOf(t),deptOf(t)])); const blob=new Blob([rows.map(r=>r.join(',')).join('\\n')],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='zoho-desk-report.csv'; a.click();}\n</script></body></html>";
app.get('/', (req, res) => { res.setHeader('Content-Type','text/html'); res.send(DASHBOARD_HTML); });

app.listen(PORT, () => {
  console.log(`\n✅ Zoho Desk Proxy running on port ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`   Tickets: http://localhost:${PORT}/api/tickets`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook/zoho`);
  console.log(`   SSE:     GET  http://localhost:${PORT}/webhook/stream`);
  console.log(`   DC: ${DC} | Org: ${ORG_ID ? 'set' : 'MISSING - set .env'}\n`);
});

