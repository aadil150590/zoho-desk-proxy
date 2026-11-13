#!/bin/bash
# Create Zoho Desk Webhook via API - run once
ORG_ID="YOUR_ORG_ID"
ACCESS_TOKEN="YOUR_ACCESS_TOKEN"
WEBHOOK_URL="https://your-app.onrender.com/webhook/zoho"

curl -X POST "https://desk.zoho.com/api/v1/webhooks?orgId=$ORG_ID" \
  -H "Authorization: Zoho-oauthtoken $ACCESS_TOKEN" \
  -H "orgId: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Live Dashboard Webhook\", \"url\": \"$WEBHOOK_URL\", \"method\": \"POST\", \"isActive\": true}"

echo ""
echo "Webhook created. Now go to Desk > Setup > Automation > Workflows"
echo "Create Workflow: Live Dashboard - Ticket Updates"
echo "Trigger: Create + Edit | Action: Webhook -> Live Dashboard Webhook"
