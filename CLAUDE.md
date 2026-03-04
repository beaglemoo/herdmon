# moo-updater

Web-based patch management UI for the sillymoo.dev homelab. Queries Patchmon for host update status and runs Ansible playbooks to apply updates with real-time output streaming.

## Project Structure

- `app/` - FastAPI backend
  - `main.py` - App entry point, static mount, lifespan
  - `config.py` - Config loading from config.yaml
  - `routers/hosts.py` - Host listing and package detail endpoints
  - `routers/jobs.py` - Job creation, listing, and SSE streaming
  - `services/patchmon.py` - Async Patchmon API client (httpx)
  - `services/ansible_runner.py` - Job manager with subprocess streaming
- `static/` - Frontend (vanilla JS, no build step)
- `systemd/` - Systemd service unit
- `deploy.sh` - Deployment script (rsync to Ansible VM)

## Conventions

- No emojis in code or documentation
- Python 3.11+, FastAPI with uvicorn
- Config-driven playbooks (add new ones in config.yaml)
- Deploy target: root@192.168.0.100:/root/moo-updater/
- Port: 8585

## Key APIs

- Patchmon: `http://192.168.0.54:3000/api/v1/api/hosts` (Basic Auth)
- Ansible playbooks: `/root/ansible/playbooks/` on the Ansible VM
