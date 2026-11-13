# Zoho Desk Live Proxy - Deploy in 2 mins

## 1. Local test
npm install
cp .env.example .env  # fill it
node server.js

## 2. Deploy to Render (free)
- New Web Service -> Connect repo / upload these files
- Build: npm install
- Start: npm start
- Env vars: set all from .env.example
- Copy your Render URL: https://your-app.onrender.com

## 3. In Zoho Desk
Workflow Webhook URL: https://your-app.onrender.com/webhook/zoho

## 4. In Dashboard App
Proxy Base URL: https://your-app.onrender.com
Live Mode: Webhook (Instant)

## Endpoints
GET /api/health
GET /api/tickets
GET /api/agents
GET /api/departments
POST /webhook/zoho
GET /webhook/stream
GET /api/webhook-log
