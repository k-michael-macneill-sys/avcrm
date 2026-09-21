#!/bin/bash
# Generate secrets for Render deployment

echo "🔐 Generating secrets for Render deployment..."
echo ""

JWT_SECRET=$(openssl rand -base64 48)
POSTGRES_PASSWORD=$(openssl rand -base64 24)
SECRETS_KEY=$(openssl rand -base64 48)

echo "Copy these into your Render environment variables:"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "JWT_SECRET"
echo "$JWT_SECRET"
echo ""
echo "POSTGRES_PASSWORD"
echo "$POSTGRES_PASSWORD"
echo ""
echo "SECRETS_KEY (optional, can leave blank)"
echo "$SECRETS_KEY"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Also set these (yours will vary):"
echo ""
echo "DOMAIN: your-app.onrender.com"
echo "ACME_EMAIL: your-email@example.ca"
echo "APP_BASE_URL: https://your-app.onrender.com"
echo "DATABASE_URL: (Render will create this from the PostgreSQL service)"
echo ""
