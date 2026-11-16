
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
    // If a specific department is requested, fetch it directly (old behaviour)
    if (deptFilter) {
      const qs = new URLSearchParams({ limit: String(limit), sortBy: 'modifiedTime', departmentId: deptFilter, from: String(from) }).toString();
      const r = await zoho(`/tickets?${qs}`, req.query.orgId);
      return res.status(r.status).send(await r.text());
    }
    // No departmentId -> fetch ALL departments and merge, otherwise Back Office (06) etc. never appear
    // 1. Get departments
    let deptIds = [];
    try {
      const dr = await zoho('/departments', req.query.orgId);
      const dj = await dr.json();
      const dlist = Array.isArray(dj) ? dj : (dj.data || dj.departments || []);
      deptIds = dlist.map(d => d.id || d.departmentId).filter(Boolean);
    } catch (e) { console.log('[Tickets] departments fetch failed, falling back to no-dept', e.message); }
    if (deptIds.length === 0) {
      const qs = new URLSearchParams({ limit: String(limit), sortBy: 'modifiedTime', from: String(from) }).toString();
      const r = await zoho(`/tickets?${qs}`, req.query.orgId);
      return res.status(r.status).send(await r.text());
    }
    // 2. Fetch tickets per department in parallel (limit 100 each, same from)
    const results = await Promise.all(deptIds.map(async (did) => {
      try {
        const qs = new URLSearchParams({ limit: String(limit), sortBy: 'modifiedTime', departmentId: String(did), from: String(from) }).toString();
        const r = await zoho(`/tickets?${qs}`, req.query.orgId);
        const txt = await r.text();
        let j; try { j = JSON.parse(txt); } catch { return []; }
        if (j.error || j.errorCode) return [];
        return Array.isArray(j) ? j : (j.data || j.tickets || []);
      } catch { return []; }
    }));
    // 3. Merge, de-dupe by ticketNumber/id, sort by modifiedTime desc, slice to limit
    const map = new Map();
    results.flat().forEach(t => map.set(t.ticketNumber || t.id, t));
    const merged = [...map.values()].sort((a,b) => new Date(b.modifiedTime||b.createdTime) - new Date(a.modifiedTime||a.createdTime)).slice(0, limit);
    return res.json({ data: merged, _departments: deptIds.length, _totalMerged: map.size });
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


// ---------- EMBEDDED DASHBOARD - SAME ORIGIN ----------
const DASHBOARD_HTML = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Zoho Desk \u2022 Live Team Performance</title>\n<style>body{background:#0f1f1a;color:#e8f5ef;font-family:system-ui;margin:0;padding:20px}h1{margin:0}.badge{background:#22c55e;color:#000;padding:6px 12px;border-radius:20px;font-weight:700}.card{background:#1a2e26;border-radius:12px;padding:16px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.kpi{background:#1a2e26;border-radius:12px;padding:14px}.kpi b{font-size:28px;display:block}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.tabs button{background:#1a2e26;color:#fff;border:1px solid #2d4a3a;padding:10px 14px;border-radius:8px;cursor:pointer}.tabs button.active{background:#14b8a6;color:#000;font-weight:700}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #2d4a3a;text-align:left}input,select{padding:8px;border-radius:8px;border:1px solid #2d4a3a;background:#0f1f1a;color:#fff;margin:4px}.btn{background:#14b8a6;color:#000;padding:10px 16px;border:none;border-radius:8px;font-weight:700;cursor:pointer}.muted{color:#9fb8a8;font-size:13px}</style></head>\n<body><h1>Zoho Desk \u2022 Live Team Performance <span class=\"badge\">\u25cf LIVE</span></h1><p class=\"muted\">Served from SAME origin as proxy \u2014 no CORS. Proxy: /api/health + /api/tickets + /api/agents</p>\n<div class=\"card\"><button class=\"btn\" onclick=\"load()\">Connect to Proxy</button> <button class=\"btn\" onclick=\"load()\">Refresh Tickets</button> <span id=\"status\" style=\"margin-left:10px\">Click Connect</span><div id=\"agentStatus\" class=\"muted\"></div></div>\n<div class=\"grid\" id=\"kpis\"></div>\n<div class=\"tabs\"><button onclick=\"show('overview',this)\" class=\"active\">Overview</button><button onclick=\"show('daily',this)\">Daily Report</button><button onclick=\"show('agent',this)\">Agent Wise</button><button onclick=\"show('kam',this)\">KAM Wise</button><button onclick=\"show('leader',this)\">Leaderboard / Top Performer</button></div>\n<div class=\"card\"><label>Search <input id=\"q\" oninput=\"render()\" placeholder=\"subject / agent / #\"></label> <label>Status <select id=\"fstatus\" onchange=\"render()\"><option value=\"\">All</option><option>Open</option><option>Closed</option><option>On Hold</option><option>In Progress</option></select></label> <label>Sort <select id=\"sort\" onchange=\"render()\"><option value=\"recent\">Recent First</option><option value=\"open\">Open First</option><option value=\"oldest\">Oldest First</option></select></label> <button class=\"btn\" onclick=\"exportCSV()\">Export CSV</button></div>\n<div id=\"overview\" class=\"tab\"><div class=\"card\"><h3>Trend \u2014 Last 14 Days (Created vs Closed)</h3><div id=\"trend\"></div></div><div class=\"card\"><h3>Top Performer</h3><div id=\"topPerf\"></div></div><div class=\"card\"><h3>Live Tickets (newest first)</h3><div id=\"tickets\"></div></div></div>\n<div id=\"daily\" class=\"tab\" style=\"display:none\"><div class=\"card\"><label>Date <input type=\"date\" id=\"d\" onchange=\"render()\"></label> <button class=\"btn\" onclick=\"setToday()\">Today</button> <button class=\"btn\" onclick=\"setDays(7)\">Last 7 Days</button> <button class=\"btn\" onclick=\"setDays(30)\">Last 30 Days</button><div id=\"dailyOut\"></div></div></div>\n<div id=\"agent\" class=\"tab\" style=\"display:none\"><div class=\"card\"><h3>Agent Wise</h3><div id=\"agentOut\"></div></div></div>\n<div id=\"kam\" class=\"tab\" style=\"display:none\"><div class=\"card\"><h3>KAM Wise</h3><p class=\"muted\">KAM = Key Account Manager. Uses ticket.kam / customFields.kam / cf_kam / accountName if present, else Agent name.</p><div id=\"kamOut\"></div></div></div>\n<div id=\"leader\" class=\"tab\" style=\"display:none\"><div class=\"card\"><h3>Leaderboard / Top Performer</h3><div id=\"leaderOut\"></div><div id=\"avgOut\"></div></div></div>\n<script>\nlet ALL=[]; let AGENTS={}; let rangeDays=0;\nfunction fmt(d){return d?new Date(d).toISOString().slice(0,10):'\u2014'}\nfunction hrs(a,b){if(!a||!b)return null;return Math.max(0,(new Date(b)-new Date(a))/36e5)}\nfunction agentOf(t){\n  // Zoho tickets list returns assigneeId only \u2014 map via /api/agents\n  if(t.assignee && (t.assignee.firstName||t.assignee.name)) return ((t.assignee.firstName||'')+' '+(t.assignee.lastName||'')).trim() || t.assignee.name;\n  if(t.assignee && typeof t.assignee==='string') return AGENTS[t.assignee]||t.assignee;\n  const id = t.assigneeId || t.assignee?.id || t.assignee?.agentId || '';\n  if(id && AGENTS[id]) return AGENTS[id];\n  if(id) return 'Agent '+String(id).slice(-4);\n  return 'Unassigned';\n}\nfunction kamOf(t){return t.kam||t.customFields?.kam||t.cf_kam||t.accountName||t.account?.name||agentOf(t)}\nfunction statusOf(t){return t.status||'\u2014'}\nasync function loadAgents(){\n  try{\n    const r=await fetch('/api/agents?limit=100'); const j=await r.json();\n    const list=Array.isArray(j)?j:(j.data||j.agents||[]);\n    list.forEach(a=>{\n      const id=a.id||a.agentId||a.zuid;\n      const name=((a.firstName||'')+' '+(a.lastName||'')).trim() || a.name || a.email || '';\n      if(id&&name) AGENTS[id]=name;\n    });\n    document.getElementById('agentStatus').textContent='Agents loaded: '+Object.keys(AGENTS).length+' names mapped from /api/agents';\n  }catch(e){ document.getElementById('agentStatus').textContent='Agents: could not load names, showing IDs \u2014 '+e.message; }\n}\nasync function load(){\n  document.getElementById('status').textContent='Loading...';\n  try{\n    await loadAgents();\n    const r1=await fetch('/api/tickets?limit=100&from=1'); const j1=await r1.json();\n    let a1=Array.isArray(j1)?j1:(j1.data||j1.tickets||[]);\n    if(j1.error||j1.errorCode) throw new Error(JSON.stringify(j1).slice(0,300));\n    let a2=[];\n    try{ const r2=await fetch('/api/tickets?limit=100&from=101'); const j2=await r2.json(); a2=Array.isArray(j2)?j2:(j2.data||j2.tickets||[]); }catch(e){}\n    const map=new Map(); [...a1,...a2].forEach(t=>map.set(t.ticketNumber||t.id,t)); ALL=[...map.values()];\n    document.getElementById('status').textContent='\u2705 Loaded '+ALL.length+' tickets from LIVE proxy (page1: '+a1.length+', page2: '+a2.length+')';\n    if(!document.getElementById('d').value) document.getElementById('d').value=new Date().toISOString().slice(0,10);\n    render();\n  }catch(e){ document.getElementById('status').textContent='\u274c Failed: '+e.message; }\n}\nfunction filtered(){\n  let arr=[...ALL];\n  const q=(document.getElementById('q').value||'').toLowerCase();\n  const fs=document.getElementById('fstatus').value;\n  if(q) arr=arr.filter(t=>(t.subject||'').toLowerCase().includes(q)||String(t.ticketNumber).includes(q)||agentOf(t).toLowerCase().includes(q));\n  if(fs) arr=arr.filter(t=>statusOf(t)===fs);\n  const s=document.getElementById('sort').value;\n  if(s==='recent') arr.sort((a,b)=>new Date(b.createdTime)-new Date(a.createdTime));\n  if(s==='oldest') arr.sort((a,b)=>new Date(a.createdTime)-new Date(b.createdTime));\n  if(s==='open') arr.sort((a,b)=>((statusOf(a)==='Closed')-(statusOf(b)==='Closed'))||(new Date(b.createdTime)-new Date(a.createdTime)));\n  return arr;\n}\nfunction groupBy(fn){\n  const m={}; filtered().forEach(t=>{const k=fn(t); if(!m[k])m[k]={name:k,total:0,open:0,closed:0,hold:0,resH:[],openAge:[]}; m[k].total++; const st=statusOf(t); if(st==='Closed'){m[k].closed++; const h=hrs(t.createdTime,t.closedTime||t.modifiedTime); if(h!=null)m[k].resH.push(h);} else if(st==='On Hold'||st==='In Progress')m[k].hold++; else m[k].open++; const oa=hrs(t.createdTime,new Date().toISOString()); if(st!=='Closed')m[k].openAge.push(oa);});\n  return Object.values(m).map(x=>({...x,rate:x.total?Math.round(x.closed/x.total*100):0,avgRes:x.resH.length?(x.resH.reduce((a,b)=>a+b,0)/x.resH.length).toFixed(1):'\u2014',avgAge:x.openAge.length?(x.openAge.reduce((a,b)=>a+b,0)/x.openAge.length).toFixed(1):'\u2014'}));\n}\nfunction render(){\n  const arr=filtered();\n  const today=new Date().toISOString().slice(0,10);\n  const createdToday=ALL.filter(t=>fmt(t.createdTime)===today).length;\n  const closedToday=ALL.filter(t=>t.closedTime&&fmt(t.closedTime)===today).length;\n  const open=ALL.filter(t=>statusOf(t)==='Open').length, closed=ALL.filter(t=>statusOf(t)==='Closed').length, hold=ALL.filter(t=>['On Hold','In Progress'].includes(statusOf(t))).length;\n  const res=ALL.filter(t=>t.closedTime).map(t=>hrs(t.createdTime,t.closedTime)).filter(v=>v!=null);\n  const avgRes=res.length?(res.reduce((a,b)=>a+b,0)/res.length).toFixed(1):'\u2014';\n  document.getElementById('kpis').innerHTML=`<div class=\"kpi\">Total<b>${ALL.length}</b></div><div class=\"kpi\">Open<b>${open}</b></div><div class=\"kpi\">Closed<b>${closed}</b></div><div class=\"kpi\">On Hold / In Progress<b>${hold}</b></div><div class=\"kpi\">Created Today<b>${createdToday}</b></div><div class=\"kpi\">Closed Today<b>${closedToday}</b></div><div class=\"kpi\">Avg Resolution (hrs)<b>${avgRes}</b></div>`;\n  let tr=''; for(let i=13;i>=0;i--){const d=new Date(); d.setDate(d.getDate()-i); const ds=d.toISOString().slice(0,10); const c=ALL.filter(t=>fmt(t.createdTime)===ds).length; const cl=ALL.filter(t=>t.closedTime&&fmt(t.closedTime)===ds).length; tr+=`<div style=\"display:flex;justify-content:space-between;padding:4px 0\"><span>${ds}</span><span>Created ${c} \u2022 Closed ${cl}</span></div>`;} document.getElementById('trend').innerHTML=tr;\n  document.getElementById('tickets').innerHTML='<table><tr><th>#</th><th>Subject</th><th>Status</th><th>Channel</th><th>Created</th><th>Agent</th></tr>'+arr.slice(0,100).map(t=>`<tr><td>${t.ticketNumber||''}</td><td>${(t.subject||'').slice(0,80)}</td><td>${statusOf(t)}</td><td>${t.channel||''}</td><td>${fmt(t.createdTime)}</td><td>${agentOf(t)}</td></tr>`).join('')+'</table><p class=\"muted\">Showing '+Math.min(arr.length,100)+' of '+arr.length+' filtered</p>';\n  const sel=document.getElementById('d').value||today;\n  let dailyArr=ALL; if(rangeDays>0){const cut=new Date(); cut.setDate(cut.getDate()-rangeDays); dailyArr=ALL.filter(t=>new Date(t.createdTime)>=cut);} else dailyArr=ALL.filter(t=>fmt(t.createdTime)===sel);\n  const dClosed=ALL.filter(t=>t.closedTime&&(rangeDays>0?new Date(t.closedTime)>=new Date(new Date().setDate(new Date().getDate()-rangeDays)):fmt(t.closedTime)===sel)).length;\n  document.getElementById('dailyOut').innerHTML=`<p><b>${rangeDays>0?'Last '+rangeDays+' days':'Date '+sel}</b>: Created ${dailyArr.length}, Closed ${dClosed}, Still Open ${dailyArr.filter(t=>statusOf(t)!=='Closed').length}</p><table><tr><th>#</th><th>Subject</th><th>Status</th><th>Agent</th><th>Created</th></tr>`+dailyArr.slice(0,100).map(t=>`<tr><td>${t.ticketNumber}</td><td>${(t.subject||'').slice(0,70)}</td><td>${statusOf(t)}</td><td>${agentOf(t)}</td><td>${fmt(t.createdTime)}</td></tr>`).join('')+'</table>';\n  const ag=groupBy(agentOf).sort((a,b)=>b.closed-a.closed);\n  document.getElementById('agentOut').innerHTML='<table><tr><th>Agent</th><th>Total</th><th>Open</th><th>Hold</th><th>Closed</th><th>Closure %</th><th>Avg Res hrs</th><th>Avg Open Age hrs</th></tr>'+ag.map(x=>`<tr><td>${x.name}</td><td>${x.total}</td><td>${x.open}</td><td>${x.hold}</td><td>${x.closed}</td><td>${x.rate}%</td><td>${x.avgRes}</td><td>${x.avgAge}</td></tr>`).join('')+'</table>';\n  const km=groupBy(kamOf).sort((a,b)=>b.closed-a.closed);\n  document.getElementById('kamOut').innerHTML='<table><tr><th>KAM</th><th>Total</th><th>Open</th><th>Closed</th><th>Closure %</th><th>Avg Res hrs</th></tr>'+km.map(x=>`<tr><td>${x.name}</td><td>${x.total}</td><td>${x.open}</td><td>${x.closed}</td><td>${x.rate}%</td><td>${x.avgRes}</td></tr>`).join('')+'</table>';\n  const sorted=[...ag].sort((a,b)=>b.closed-a.closed); const fastest=[...ag].filter(x=>x.closed>=1&&x.avgRes!=='\u2014').sort((a,b)=>parseFloat(a.avgRes)-parseFloat(b.avgRes));\n  const top=sorted[0];\n  document.getElementById('topPerf').innerHTML=top?`<b>${top.name}</b> \u2014 ${top.closed} closed, ${top.rate}% closure, avg ${top.avgRes} hrs`:'\u2014';\n  const withScore=ag.map(x=>({...x,score:Math.round(x.closed*(x.rate/100)- (x.avgRes==='\u2014'?0:parseFloat(x.avgRes)*0.1))})).sort((a,b)=>b.score-a.score);\n  document.getElementById('leaderOut').innerHTML='<h4>Top 3: Most Closed: '+(sorted[0]?.name||'\u2014')+' \u2022 Fastest: '+(fastest[0]?.name||'\u2014')+' ('+(fastest[0]?.avgRes||'\u2014')+' hrs) \u2022 Highest Closure: '+([...ag].sort((a,b)=>b.rate-a.rate)[0]?.name||'\u2014')+'</h4><table><tr><th>Rank</th><th>Agent</th><th>Closed</th><th>Open</th><th>Total</th><th>Closure %</th><th>Avg Res</th><th>Score</th></tr>'+withScore.map((x,i)=>`<tr><td>${i+1}</td><td>${x.name}</td><td>${x.closed}</td><td>${x.open}</td><td>${x.total}</td><td>${x.rate}%</td><td>${x.avgRes}</td><td>${x.score}</td></tr>`).join('')+'</table>';\n  document.getElementById('avgOut').innerHTML=`<p class=\"muted\">Avg tickets per agent: ${ag.length?(ALL.length/ag.length).toFixed(1):'\u2014'} \u2022 Avg resolution team: ${avgRes} hrs \u2022 Score = Closed \u00d7 Closure% \u2212 AvgRes\u00d70.1</p>`;\n}\nfunction show(id,btn){document.querySelectorAll('.tab').forEach(e=>e.style.display='none'); document.getElementById(id).style.display='block'; document.querySelectorAll('.tabs button').forEach(b=>b.classList.remove('active')); btn.classList.add('active');}\nfunction setToday(){rangeDays=0; document.getElementById('d').value=new Date().toISOString().slice(0,10); render();}\nfunction setDays(n){rangeDays=n; render();}\nfunction exportCSV(){const arr=filtered(); const rows=[['Ticket','Subject','Status','Channel','Created','Agent']]; arr.forEach(t=>rows.push([t.ticketNumber,(t.subject||'').replace(/,/g,' '),statusOf(t),t.channel||'',fmt(t.createdTime),agentOf(t)])); const blob=new Blob([rows.map(r=>r.join(',')).join('\\n')],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='zoho-desk-report.csv'; a.click();}\n</script></body></html>";
app.get('/', (req, res) => { res.setHeader('Content-Type','text/html'); res.send(DASHBOARD_HTML); });

app.listen(PORT, () => {
  console.log(`\n✅ Zoho Desk Proxy running on port ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`   Tickets: http://localhost:${PORT}/api/tickets`);
  console.log(`   Webhook: POST http://localhost:${PORT}/webhook/zoho`);
  console.log(`   SSE:     GET  http://localhost:${PORT}/webhook/stream`);
  console.log(`   DC: ${DC} | Org: ${ORG_ID ? 'set' : 'MISSING - set .env'}\n`);
});

