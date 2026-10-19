# VPS setup: history first, validated demo later

Prepared service templates are in `deploy/systemd`. No server has been purchased or configured. Choose Ubuntu 24.04 LTS on x86-64, ideally 2 vCPU / 4 GB RAM / 40 GB disk. Check the final monthly total including tax and IPv4 against the US$10 budget. Disk usage must be monitored as additional symbols are collected. No domain name is required.

## Provisioning

Create the provider account yourself and supply payment details there. Add your laptop's SSH public key; never share the private key. Choose an available European location and create the server. Allow inbound SSH (TCP 22) from your current public IP using the provider firewall; no public web or database ports are needed. Keep outbound access available for historical downloads and the broker connection. Verify the server SSH host-key fingerprint through the provider console before accepting it.

On the new VPS as administrator:

```sh
sudo apt update
sudo apt install -y python3 python3-venv build-essential git rsync sqlite3 ca-certificates
sudo adduser --system --group --home /opt/tradingbot tradingbot
sudo install -d -o tradingbot -g tradingbot -m 700 /opt/tradingbot/data
```

Install an official Node.js 24 LTS x64 release from https://nodejs.org/en/download with checksum verification. Node and npm must be accessible to the service account through `/usr/local/bin` or `/usr/bin`, rather than only through an interactive user's shell. Check `node --version` and `npm --version`. The history downloader uses only Python's standard library; installing the full ML requirements is unnecessary for acquisition.

## Transfer the project and state

Transfer the current project to `/opt/tradingbot` over SSH, excluding `.git`, `.env*`, `node_modules`, `dist`, `.venv`, and `data` initially. Do not use rsync `--delete`. Transfer credentials separately, only when broker access is needed, and set ownership to `tradingbot:tradingbot` and mode 0600. Preserve the refreshed token cache if present; never paste credentials into chat.

Before moving history, stop the laptop downloader gracefully and copy the entire `data/history/dukascopy/EURUSD-2025H1` directory, including its manifest and raw archives. Do not copy it while the downloader is writing. Resume only one downloader against each archive directory.

Before any execution migration, stop the laptop's bot and all database writers. Preserve the existing `data` state, research evidence, deployment files and database: do not start a fresh ledger on an account with bot-owned trades. With writers stopped, create a consistent SQLite snapshot using `sqlite3 data/trading.db '.backup /tmp/trading-transfer.db'`; transfer that snapshot as the VPS's `data/trading.db`. Do not copy just the live SQLite main file while WAL writers are active. Retain a protected off-server backup. Never run the laptop and VPS execution instances simultaneously.

On the VPS after transfer:

```sh
sudo chown -R tradingbot:tradingbot /opt/tradingbot
cd /opt/tradingbot
sudo -u tradingbot npm ci
sudo -u tradingbot npm run typecheck
sudo -u tradingbot npm run cfd:run -- --status
sudo install -m 644 deploy/systemd/cfd-history.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/cfd-demo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cfd-history.service
```

History runs in four-hour acquisition windows, restarts after failures with a five-minute delay, and stops on successful export. Check for persistent failures rather than assuming every retry makes progress. Reboot resumes acquisition. Successful acquisition still requires coverage and cost validation.

```sh
sudo systemctl status cfd-history.service
sudo journalctl -u cfd-history.service -n 50 --no-pager
sudo journalctl -u cfd-history.service -f
 df -h /opt/tradingbot
```

Configure journald disk limits (for example `SystemMaxUse=200M`) and maintain encrypted backups outside this server. Back up SQLite consistently, plus evidence, history manifests and private credential state. Test restoration before relying on unattended execution.

## Demo execution only after validation

Leave `cfd-demo.service` disabled until an eligible deployment exists at `/opt/tradingbot/data/deployment.json`. Its interval is 1,000 ms; change the unit to match the approved interval if different, then reload systemd. The runner retains all evidence checks. Review `docs/CFD_CONTINUOUS_WORKFLOW.md` for limits and manual-position coexistence.

Once validated and configured:

```sh
sudo systemctl enable --now cfd-demo.service
sudo journalctl -u cfd-demo.service -f
```

Pause actions with `sudo -u tradingbot touch /opt/tradingbot/data/CFD_STOP`. Resume by removing that file. Stop execution with `sudo systemctl stop cfd-demo.service`; disable startup with `sudo systemctl disable cfd-demo.service`. Broker stops remain active; stopping the service does not flatten trades.

Local unit syntax verification is not remote deployment verification. After provisioning, verify history progress, permissions, restart/reboot behavior, credential loading and read-only broker observation before enabling eligible demo execution.
