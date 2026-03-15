# Configuration for deploying the Node.js backend
REMOTE_USER="ubuntu"
REMOTE_HOST="141.147.91.64"
KEY_PATH="../ssh_oracle_staionly_backend.key"
REMOTE_DIR="~/stationly-backend"
SERVICE_NAME="stationly-backend"

# Exclude directories (upload dist, ignore src and typescript)
EXCLUDES="--exclude node_modules --exclude .git --exclude src --exclude .env"

echo "🚀 Starting Node.js backend deployment to Oracle Cloud..."

# 1. Local Build Check
echo "📦 Running local build test..."
npm run build
if [ $? -ne 0 ]; then
    echo "❌ Local build failed. Aborting deployment."
    exit 1
fi

# 2. Sync files to remote server
echo "📤 Syncing files to remote server..."
rsync -avz -e "ssh -i $KEY_PATH" $EXCLUDES ./ $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/

# 2.5 Ensure environment variables are set
if [ -f ".env" ]; then
    echo "🔑 Uploading local .env to server..."
    scp -i "$KEY_PATH" .env "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/.env"
else
    echo "⚠️  No local .env file found. Make sure the server has environment variables configured!"
fi

# 3. Remote Build and Restart
echo "🔄 Executing remote restart..."
ssh -i "$KEY_PATH" "$REMOTE_USER@$REMOTE_HOST" "
    cd $REMOTE_DIR
    echo 'Installing PM2 if not present...'
    sudo npm install -g pm2
    echo 'Installing production dependencies...'
    npm ci --only=production
    echo 'Restarting PM2 process...'
    pm2 restart $SERVICE_NAME || pm2 start dist/server.js --name $SERVICE_NAME
    pm2 save
"

echo "✅ Node.js deployment complete!"
