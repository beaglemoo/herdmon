# herdmon

A web-based patch management and Proxmox cluster operations dashboard. Built for homelabs running Proxmox with LXC containers and VMs.

## What It Does

**Patch Ops** -- Shows all managed hosts with pending updates, security patches, and reboot status. Select hosts and run Ansible playbooks to update them, with real-time terminal output streamed to the browser. An AI VERDICT panel renders below the terminal after each job, powered by OpenClaw.

**Cluster Ops** -- Displays live Proxmox node status (containers, VMs, kernel version, uptime). Provides per-node update and reboot controls, plus a rolling restart that updates and reboots the entire cluster with workload migration.

## Integrations

| Integration | What It Does |
|-------------|-------------|
| [PatchMon](https://github.com/SelfHostedHub/PatchMon) | Provides host inventory with pending update counts, security patches, OS info, and reboot status |
| [Ansible](https://www.ansible.com/) | Executes playbooks as subprocesses -- system updates (`apt`/`dnf`), LXC app updates, backup-then-update, rolling restarts, self-update |
| [Proxmox VE](https://www.proxmox.com/) | SSH-based cluster node monitoring (`pct list`, `qm list`), VM live migration, CT restart migration |
| [Proxmox Community Scripts](https://community-scripts.github.io/ProxmoxVE/) | LXC application updates via community-maintained update scripts |
| [Proxmox Backup Server](https://www.proxmox.com/en/proxmox-backup-server) | Pre-update LXC snapshots via `vzdump` to PBS storage |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | Monitor pause/resume during rolling restarts to suppress false alerts |
| [OpenClaw](https://openclaw.io) | Post-job AI health verification via `/verify` webhook; renders verdict in terminal overlay |

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
  +-- OpenClaw /verify --> post-job AI health check (async, tolerant)
```

- Real-time output via Server-Sent Events (SSE) -- `ansible-playbook` stdout piped line by line into a browser terminal
- Config-driven playbook definitions -- add new playbooks in `config.yaml`
- Job queue with concurrency limits, timeout protection, and historical output replay
- Jobs can be cancelled mid-run via CANCEL button or `POST /api/jobs/{id}/cancel`
- Playbooks can be chained: on `rc=0` a follow-on job starts automatically

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
- [OpenClaw](https://openclaw.io) with webhook receiver on port 9090 (optional, for AI verification)

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
- **app** -- version check TTL and git dir for the self-update version indicator
- **openclaw** -- URL for the `/verify` webhook and per-playbook kind mapping

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
  - name: "update-lxc-system"
    file: "update-lxc-system.yml"
    description: "apt full-upgrade only -- no community script"
    groups: ["lxc"]

  - name: "update-lxc-apps"
    file: "update-lxc-apps-v2.yml"
    description: "LXC app updates via community script (tagged CTs only)"
    groups: ["lxc"]

  - name: "update-lxc-full"
    file: "update-all.yml"
    description: "apt + community script (full LXC update)"
    groups: ["lxc"]

  - name: "rolling-restart"
    file: "rolling-restart.yml"
    description: "Rolling update and restart of all Proxmox nodes"
    groups: ["proxmox"]
    cluster_operation: true          # skips --limit flag
    extra_args: ["-e", "confirm_each_node=false"]

  - name: "update-herdmon"
    file: "update-herdmon.yml"
    description: "Self-update: git pull + pip install + service restart"
    cluster_operation: true          # no host list required

  - name: "update-lxc-full-then-self"
    file: "update-all.yml"
    description: "Full LXC update then self-update"
    groups: ["lxc"]
    chain: ["update-herdmon"]        # auto-starts update-herdmon after rc=0
```

- **cluster_operation** -- when `true`, the playbook runs without `--limit`
- **extra_args** -- additional arguments passed to `ansible-playbook`
- **chain** -- list of playbook names to run sequentially after `rc=0`

### LXC Update Modes

Three modes are available in the Patch Ops dropdown:

| Mode | Playbook | What it does |
|------|----------|--------------|
| `update-lxc-system` | `update-lxc-system.yml` | `apt full-upgrade` + `autoremove` only |
| `update-lxc-apps` | `update-lxc-apps-v2.yml` | Community-script app updates (tagged CTs) |
| `update-lxc-full` | `update-all.yml` | Both apt and community script |

### App block

```yaml
app:
  version_check_ttl: 300   # seconds; how often to fetch git ls-remote
  git_dir: "/root/moo-updater"
```

Controls the version indicator in the top bar. `GET /api/app/version` returns `{current, remote, behind}`. The UPDATE APP button pulses amber when `behind` is true.

### OpenClaw block

```yaml
openclaw:
  verify_url: "http://192.168.2.226:9090/verify"
  enabled: true
  kinds:
    node-update: proxmox_node
    node-reboot: proxmox_node
    rolling-restart: cluster
    update-lxc-system: lxc
    update-lxc-apps: lxc
    update-lxc-full: lxc
```

Maps playbook names to verification kinds. After a job in this map completes, Herdmon POSTs to `verify_url`. If OpenClaw is unreachable, the job is not affected.

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
| POST | `/api/jobs` | Create job `{"playbook": "...", "hosts": [...], "chain": [...]}` |
| GET | `/api/jobs` | List all jobs |
| GET | `/api/jobs/{id}` | Job details + output |
| GET | `/api/jobs/{id}/stream` | SSE stream of job output |
| POST | `/api/jobs/{id}/cancel` | Cancel a running job (SIGTERM, then SIGKILL after 10 s) |
| GET | `/api/cluster/nodes` | Live cluster node status |
| GET | `/api/app/version` | `{current, remote, behind}` for the UPDATE APP indicator |

## SSE Events

| Event | When |
|-------|------|
| `output` | One line of ansible-playbook stdout |
| `status` | Job state change (RUNNING / COMPLETED / FAILED) |
| `done` | Job finished; includes return code |
| `verify_report` | AI verdict from OpenClaw: `{status, summary, checks, concerns}` |

## Job System

- Jobs have states: `queued` -> `running` -> `completed`/`failed`
- Concurrent job limit configurable (default: 3)
- 30-minute command timeout (configurable); stdout loop wrapped in `asyncio.wait_for` so silent-hang playbooks are killed at the timeout
- SSE subscribers receive real-time output lines
- Late subscribers get historical output replayed
- CANCEL button (or `POST /api/jobs/{id}/cancel`) sends SIGTERM, waits 10 s, then SIGKILL; marks job FAILED with `cancel_reason=user`

## Self-Update

The top bar on both pages shows an UPDATE APP button. When `GET /api/app/version` reports the local HEAD is behind `origin/main`, the button pulses amber. Clicking it runs the `update-herdmon` playbook, which does `git pull`, `pip install -r requirements.txt`, and `systemctl restart moo-updater` on the local machine.

The UPDATE LXCS + APP action on Patch Ops chains the selected LXC update playbook across pending hosts, then auto-starts `update-herdmon` after success.

## License

MIT
