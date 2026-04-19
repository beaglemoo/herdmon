# moo-updater

Web-based patch management and cluster operations UI for Proxmox homelabs. Queries PatchMon for host update status, runs Ansible playbooks with real-time output streaming, and provides Proxmox cluster management.

## Active branch

`feat/review-and-extend` -- the current overhaul branch. Do not commit directly to `main` during this work.

## Project Structure

- `app/` - FastAPI backend
  - `main.py` - App entry point, static mount, lifespan, router registration
  - `config.py` - Config loading from config.yaml (playbooks, cluster nodes, openclaw block, app block)
  - `routers/hosts.py` - Host listing and package detail endpoints
  - `routers/jobs.py` - Job creation, listing, SSE streaming, cancel endpoint
  - `routers/cluster.py` - Cluster node status endpoint (SSH-based)
  - `routers/health.py` - NEW: `GET /api/app/version` (local HEAD vs cached `git ls-remote`)
  - `services/patchmon.py` - Async PatchMon API client (httpx)
  - `services/ansible_runner.py` - Job manager with subprocess streaming, timeout fix, cancel, chain
  - `services/openclaw.py` - NEW: async client for `POST /verify` (tolerant to failures)
- `static/` - Frontend (vanilla JS, no build step)
  - `index.html` + `js/app.js` - Patch Ops page (host updates)
  - `cluster.html` + `js/cluster.js` - Cluster Ops page (node management)
  - `js/common.js` - NEW: shared helpers (escapeHtml, formatDuration, confirm modal, terminal)
  - `js/ansible-parser.js` - NEW: parses PLAY/TASK/host-status/recap lines for live status strip
  - `css/style.css` - Shared styles
- `systemd/` - Systemd service unit
- `deploy.sh` - Deployment script (rsync to target host)
- `config.example.yaml` - Example config including all new blocks

## Pages

- **Patch Ops** (`/`) - Host inventory, package updates, playbook execution, chained UPDATE LXCS + APP action
- **Cluster Ops** (`/cluster.html`) - Proxmox node status, per-node update/reboot, rolling restart

## New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/jobs/{id}/cancel` | Cancel a running job; SIGTERM then SIGKILL after 10 s |
| GET | `/api/app/version` | `{current, remote, behind}` for the UPDATE APP top-bar indicator |

## New SSE Event

`verify_report` -- emitted after the `done` event when the playbook is mapped in `openclaw.kinds`. Payload: `{status, summary, checks, concerns}` from OpenClaw `ops-verify`. If OpenClaw is unreachable, payload is `{status: "unavailable"}`.

## Conventions

- Python 3.11+, FastAPI with uvicorn
- Config-driven playbooks (add new ones in config.yaml)
- Cluster operations use `cluster_operation: true` flag to skip `--limit` arg
- Config file (`config.yaml`) is excluded from deploy rsync
- Port: 8585

### Verify flow

After a job completes, `ansible_runner.py` calls `asyncio.create_task(_post_verify(job))` if the playbook name is in `config.openclaw.kinds`. The `openclaw.py` service POSTs to `openclaw.verify_url` and returns the verdict. The runner emits the result as a `verify_report` SSE event. Failures in the verify call are logged and emitted as `{status: "unavailable"}` -- they do not affect job state.

### Chain

`PlaybookEntry` has an optional `chain: list[str]` field. After a job completes with `rc=0`, each name in `chain` is auto-dispatched as a new job with the same `hosts` list. `CreateJob` (the POST body) also accepts an ad-hoc `chain` list. Used by the UPDATE LXCS + APP button on Patch Ops.

### Cancel

`POST /api/jobs/{id}/cancel` calls `ansible_runner.cancel(job_id)` which sends `proc.terminate()`, waits up to 10 seconds, then calls `proc.kill()`. The job transitions to FAILED with `cancel_reason="user"`. CANCEL button in the terminal overlay is enabled only while the job is RUNNING.

### Timeout fix

The stdout drain loop in `ansible_runner.py` is wrapped in `asyncio.wait_for(..., timeout=command_timeout)`. This ensures a silent-hang playbook (e.g. a debconf prompt without `DEBIAN_FRONTEND=noninteractive`) is killed at the configured timeout, not just when the process writes its last byte.

## Config Blocks

Two new top-level blocks in `config.yaml`:

### app block

```yaml
app:
  version_check_ttl: 300   # seconds between git ls-remote fetches
  git_dir: "/root/moo-updater"
```

### openclaw block

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
