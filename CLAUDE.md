# moo-updater

Web-based patch management and cluster operations UI for Proxmox homelabs. Queries PatchMon for host update status, runs Ansible playbooks with real-time output streaming, and provides Proxmox cluster management.

## Project Structure

- `app/` - FastAPI backend
  - `main.py` - App entry point, static mount, lifespan
  - `config.py` - Config loading from config.yaml (playbooks, cluster nodes)
  - `routers/hosts.py` - Host listing and package detail endpoints
  - `routers/jobs.py` - Job creation, listing, and SSE streaming
  - `routers/cluster.py` - Cluster node status endpoint (SSH-based)
  - `services/patchmon.py` - Async PatchMon API client (httpx)
  - `services/ansible_runner.py` - Job manager with subprocess streaming
- `static/` - Frontend (vanilla JS, no build step)
  - `index.html` + `js/app.js` - Patch Ops page (host updates)
  - `cluster.html` + `js/cluster.js` - Cluster Ops page (node management)
  - `css/style.css` - Shared styles
- `systemd/` - Systemd service unit
- `deploy.sh` - Deployment script (rsync to target host)

## Pages

- **Patch Ops** (`/`) - Host inventory, package updates, playbook execution
- **Cluster Ops** (`/cluster.html`) - Proxmox node status, per-node update/reboot, rolling restart

## Conventions

- Python 3.11+, FastAPI with uvicorn
- Config-driven playbooks (add new ones in config.yaml)
- Cluster operations use `cluster_operation: true` flag to skip `--limit` arg
- Config file (`config.yaml`) is excluded from deploy rsync
- Port: 8585
