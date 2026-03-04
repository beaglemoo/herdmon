#!/usr/bin/env bash
set -euo pipefail

TARGET_HOST="192.168.0.100"
TARGET_USER="root"
TARGET_DIR="/root/moo-updater"
SERVICE_NAME="moo-updater"

echo "Deploying ${SERVICE_NAME} to ${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}"

/opt/homebrew/bin/rsync -avz --info=progress2 \
    --exclude='venv/' \
    --exclude='__pycache__/' \
    --exclude='logs/' \
    --exclude='config.yaml' \
    --exclude='.git/' \
    --exclude='*.pyc' \
    --exclude='*.egg-info/' \
    -e "ssh -o StrictHostKeyChecking=no" \
    ./ "${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/"

echo "Setting up remote environment..."

ssh -o StrictHostKeyChecking=no "${TARGET_USER}@${TARGET_HOST}" bash -s <<'REMOTE'
set -euo pipefail

TARGET_DIR="/root/moo-updater"
SERVICE_NAME="moo-updater"

cd "${TARGET_DIR}"

if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

echo "Installing dependencies..."
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# Create config from example if it doesn't exist
if [ ! -f "config.yaml" ]; then
    echo "Creating config.yaml from example..."
    cp config.example.yaml config.yaml
    echo "WARNING: Edit config.yaml with your Patchmon credentials!"
fi

echo "Installing systemd service..."
cp systemd/${SERVICE_NAME}.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "Service status:"
systemctl status "${SERVICE_NAME}" --no-pager || true
REMOTE

echo "Deployment complete."
