# herdmon

A web-based patch management and Proxmox cluster operations dashboard. Built for homelabs running Proxmox with LXC containers and VMs.

## What It Does

**Patch Ops** -- Shows all managed hosts with pending updates, security patches, and reboot status. Select hosts and run Ansible playbooks to update them, with real-time terminal output streamed to the browser.

**Cluster Ops** -- Displays live Proxmox node status (containers, VMs, kernel version, uptime). Provides per-node update and reboot controls, plus a rolling restart that updates and reboots the entire cluster with workload migration.

## Integrations

| Integration | What It Does |
|-------------|-------------|
| [PatchMon](https://github.com/SelfHostedHub/PatchMon) | Provides host inventory with pending update counts, security patches, OS info, and reboot status |
| [Ansible](https://www.ansible.com/) | Executes playbooks as subprocesses -- system updates (`apt`/`dnf`), LXC app updates, backup-then-update, rolling restarts |
| [Proxmox VE](https://www.proxmox.com/) | SSH-based cluster node monitoring (`pct list`, `qm list`), VM live migration, CT restart migration |
| [Proxmox Community Scripts](https://community-scripts.github.io/ProxmoxVE/) | LXC application updates via community-maintained update scripts |
| [Proxmox Backup Server](https://www.proxmox.com/en/proxmox-backup-server) | Pre-update LXC snapshots via `vzdump` to PBS storage |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | Monitor pause/resume during rolling restarts to suppress false alerts |

## How It Works

```
Browser
  |
herdmon (FastAPI + vanilla JS)
  |
  +-- PatchMon API ------> host/package data
  +-- SSH to PVE nodes --> live cluster status (cached 30s)
  +-- ansible-playbook --> job execution with SSE streaming
  +-- Uptime Kuma -------> monitor pause/resume via Socket.IO
```

- Real-time output via Server-Sent Events (SSE) -- `ansible-playbook` stdout piped line by line into a browser terminal
- Config-driven playbook definitions -- add new playbooks in `config.yaml`
- Job queue with concurrency limits, timeout protection, and historical output replay

## Stack

- **Backend:** Python 3.11+, FastAPI, uvicorn
- **Frontend:** Vanilla JS, no build step, no framework
- **Streaming:** SSE via [sse-starlette](https://github.com/sysid/sse-starlette)
- **Styling:** Custom CSS, command-center aesthetic (amber phosphor theme)

## Setup

### Prerequisites

- Python 3.11+
- Ansible installed and configured with an inventory
- [PatchMon](https://github.com/SelfHostedHub/PatchMon) running (for host update data)
- SSH key access from the host running herdmon to all managed nodes
- [Uptime Kuma](https://github.com/louislam/uptime-kuma) (optional, for monitor pause/resume during rolling restarts)

### Install

```bash
git clone https://github.com/beaglemoo/herdmon.git
cd herdmon
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Configure

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` with your environment:

- **patchmon** -- URL and credentials for your PatchMon instance
- **ansible** -- paths to your playbook directory, inventory file, and working directory
- **playbooks** -- define which Ansible playbooks are available in the UI
- **cluster_nodes** -- list your Proxmox nodes and backup server for the Cluster Ops page

### Run

```bash
# Development
uvicorn app.main:app --host 0.0.0.0 --port 8585 --reload

# Production (systemd)
cp systemd/moo-updater.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now moo-updater
```

### Deploy to Remote Host

The included `deploy.sh` rsyncs the app to a remote server:

```bash
export MOO_DEPLOY_HOST=your-ansible-host
export MOO_DEPLOY_USER=root
./deploy.sh
```

## Configuration

### Playbooks

Each playbook entry in `config.yaml` defines an operation available in the UI:

```yaml
playbooks:
  - name: "update-all"
    file: "update-all.yml"
    description: "Update system packages"
    groups: ["debian", "ubuntu", "lxc"]

  - name: "rolling-restart"
    file: "rolling-restart.yml"
    description: "Rolling update and restart of all Proxmox nodes"
    groups: ["proxmox"]
    cluster_operation: true          # skips --limit flag
    extra_args: ["-e", "confirm_each_node=false"]
```

- **cluster_operation** -- when `true`, the playbook runs without `--limit` (targets all hosts defined in the playbook itself)
- **extra_args** -- additional arguments passed to `ansible-playbook`
- **groups** -- Ansible inventory groups this playbook applies to

### Cluster Nodes

```yaml
cluster_nodes:
  - name: "node1"
    ip: "10.0.0.1"
    type: "proxmox"    # shows CT/VM counts, UPDATE + REBOOT buttons
  - name: "backup"
    ip: "10.0.0.4"
    type: "pbs"        # shows REBOOT button only
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hosts` | List hosts with PatchMon data |
| GET | `/api/hosts/{id}/packages` | Package details for a host |
| GET | `/api/playbooks` | List configured playbooks |
| POST | `/api/jobs` | Create job `{"playbook": "...", "hosts": [...]}` |
| GET | `/api/jobs` | List all jobs |
| GET | `/api/jobs/{id}` | Job details + output |
| GET | `/api/jobs/{id}/stream` | SSE stream of job output |
| GET | `/api/cluster/nodes` | Live cluster node status |

## Job System

- Jobs have states: `queued` -> `running` -> `completed`/`failed`
- Concurrent job limit configurable (default: 3)
- 30-minute command timeout (configurable)
- SSE subscribers receive real-time output lines
- Late subscribers get historical output replayed

## License

MIT
