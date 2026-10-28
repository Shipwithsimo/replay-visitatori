#!/usr/bin/env bash
# Installs Replay visitatori on a fresh Ubuntu server (e.g. Oracle Cloud Always Free).
# Usage: curl -fsSL <raw url of this file> | bash      (or: bash oracle-setup.sh)
set -euo pipefail

REPO="${REPO:-Shipwithsimo/replay-visitatori}"
APP_DIR=/opt/replay
ENV_FILE=/etc/replay.env

exec </dev/tty
read -rsp "GitHub token con accesso al repository (lascia vuoto se il repository è pubblico): " GH_TOKEN; echo
read -rsp "Scegli la password del pannello: " DASHBOARD_PASSWORD; echo
read -rp  "Dominio del negozio (es. mio-negozio.myshopify.com): " SHOP_DOMAIN

echo "==> Pacchetti di sistema"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates build-essential iptables-persistent debian-keyring debian-archive-keyring apt-transport-https gnupg

echo "==> Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> Codice"
CLONE_URL="https://github.com/${REPO}.git"
[ -n "$GH_TOKEN" ] && CLONE_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
if [ -d "$APP_DIR/.git" ]; then
  sudo git -C "$APP_DIR" pull --ff-only
else
  sudo git clone --depth 1 "$CLONE_URL" "$APP_DIR"
fi
sudo git -C "$APP_DIR" remote set-url origin "https://github.com/${REPO}.git"
cd "$APP_DIR" && sudo npm ci --omit=dev

echo "==> Configurazione"
sudo mkdir -p /var/lib/replay
sudo tee "$ENV_FILE" >/dev/null <<ENV
NODE_ENV=production
PORT=3000
DATA_DIR=/var/lib/replay
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}
SHOP_DOMAIN=${SHOP_DOMAIN}
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
RETENTION_DAYS=30
ENV
sudo chmod 600 "$ENV_FILE"

sudo tee /etc/systemd/system/replay.service >/dev/null <<UNIT
[Unit]
Description=Replay visitatori
After=network.target

[Service]
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server/index.js
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now replay
sudo systemctl restart replay

echo "==> HTTPS con Caddy"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update -y && sudo apt-get install -y caddy
IP=$(curl -fsS https://api.ipify.org)
DOMAIN="${IP//./-}.sslip.io"
echo "$DOMAIN {
  reverse_proxy localhost:3000
}" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl restart caddy

echo "==> Firewall (le immagini Oracle bloccano 80/443 di default)"
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport $port -j ACCEPT
done
sudo netfilter-persistent save

echo
echo "Fatto. Il server è su: https://${DOMAIN}"
echo "Se non si apre, controlla che nella Security List di Oracle siano aperte le porte 80 e 443."
echo "Per aggiornare in futuro: sudo git -C ${APP_DIR} pull && cd ${APP_DIR} && sudo npm ci --omit=dev && sudo systemctl restart replay"
