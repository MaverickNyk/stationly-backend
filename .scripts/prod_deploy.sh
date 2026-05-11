#!/bin/bash
set -e

REMOTE_USER="ubuntu"
REMOTE_HOST="141.147.91.64"
KEY_PATH="$HOME/workspace/Projects/ssh_oracle_staionly_backend.key"
REMOTE_DIR="~/stationly-backend"
SERVICE_NAME="stationly-backend"
APP_BASE_URL="https://api.stationly.co.uk"
APP_WEB_URL="https://stationly.co.uk"

EXCLUDES="--exclude node_modules --exclude .git --exclude src --exclude .env"

echo "🚀 Deploying backend to PRODUCTION ($REMOTE_HOST)..."

# 1. Local build
echo "📦 Building..."
npm run build || { echo "❌ Build failed. Aborting."; exit 1; }

# 2. Assemble prod .env — take local secrets, inject prod URLs
TEMP_ENV=$(mktemp)
grep -v '^APP_BASE_URL=\|^APP_WEB_URL=' .env > "$TEMP_ENV"
echo "APP_BASE_URL=$APP_BASE_URL" >> "$TEMP_ENV"
echo "APP_WEB_URL=$APP_WEB_URL"   >> "$TEMP_ENV"

# 3. Sync built files
echo "📤 Syncing files..."
rsync -az -e "ssh -i $KEY_PATH" $EXCLUDES ./ "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

# 4. Upload env
echo "🔑 Uploading environment config..."
scp -i "$KEY_PATH" "$TEMP_ENV" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/.env"
rm "$TEMP_ENV"

# 5. Install deps + zero-downtime reload
echo "🔄 Reloading..."
ssh -i "$KEY_PATH" "$REMOTE_USER@$REMOTE_HOST" "
    cd $REMOTE_DIR
    npm ci --omit=dev --silent
    pm2 reload $SERVICE_NAME --update-env || pm2 start dist/server.js --name $SERVICE_NAME
    pm2 save
"

# 6. Health check — 401 means server is up (missing API key), 200 means open endpoint
echo "🏥 Health check..."
sleep 3
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$APP_BASE_URL/api/v1/modes" -H "X-Stationly-Key: test" 2>/dev/null || echo "000")
if [[ "$STATUS" == "401" || "$STATUS" == "403" || "$STATUS" == "200" ]]; then
    echo "✅ Production deployment complete — server responding (HTTP $STATUS)"
else
    echo "⚠️  Unexpected HTTP $STATUS — check logs:"
    echo "    ssh -i $KEY_PATH $REMOTE_USER@$REMOTE_HOST 'pm2 logs $SERVICE_NAME --lines 50'"
    exit 1
fi
