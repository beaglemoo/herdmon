# moo-updater

Web-based patch management and cluster operations UI for Proxmox homelabs. Queries PatchMon for host update status, runs Ansible playbooks with real-time output streaming, and provides Proxmox cluster management. HA-aware drain and NFS remediation added 2026-04-19.

## Active branch

`feat/ha-aware-drain` -- current branch. Do not commit directly to `main`.

## Project Structure

- `app/` - FastAPI backend
  - `main.py` - App entry point, static mount, lifespan, router registration
  - `config.py` - Config loading from config.yaml (playbooks, cluster nodes, openclaw block, app block)
  - `routers/hosts.py` - Host listing and package detail endpoints
  - `routers/jobs.py` - Job creation, listing, SSE streaming, cancel endpoint
  - `routers/cluster.py` - Cluster node status endpoint (SSH-based); includes HA fields + nfs-state endpoint
  - `routers/maintenance.py` - NEW: `/api/maintenance` proxy to OpenClaw
  - `routers/health.py` - `GET /api/app/version` (local HEAD vs cached `git ls-remote`)
  - `services/patchmon.py` - Async PatchMon API client (httpx)
  - `services/ansible_runner.py` - Job manager with subprocess streaming, timeout fix, cancel, chain
  - `services/openclaw.py` - Async client for `POST /verify`; parses `actions` field from verdict
- `static/` - Frontend (vanilla JS, no build step)
  - `index.html` + `js/app.js` - Patch Ops page (host updates, REMEDIATE NFS button)
  - `cluster.html` + `js/cluster.js` - Cluster Ops page (HA badges, DRAIN/REBOOT split, maintenance pill, health panel)
  - `js/common.js` - Shared helpers (escapeHtml, formatDuration, confirm modal, terminal)
  - `js/ansible-parser.js` - Parses PLAY/TASK/host-status/recap lines for live status strip
  - `css/style.css` - Shared styles (includes MASTER badge, maintenance pill, amber page border, health table)
- `systemd/` - Systemd service unit
- `deploy.sh` - Deployment script (rsync to target host)
- `config.example.yaml` - Example config including all new blocks

## Pages

- **Patch Ops** (`/`) - Host inventory, package updates, playbook execution, REMEDIATE NFS button, chained UPDATE LXCS + APP
- **Cluster Ops** (`/cluster.html`) - Proxmox node status with HA fields, DRAIN/REBOOT/UPDATE per node, global maintenance pill, post-reboot health panel

## HA-Awareness Summary

All 38 LXCs and 3 VMs are HA-managed. The backend now parses `ha-manager status` output (via SSH on each PVE node) to populate per-node HA fields. Direct `qm migrate`/`pct migrate` commands are gone from the rolling-restart playbook; HA CRM handles all guest placement.

Key implementation facts:
- `cluster.py._query_node()` SSH block extended to run `ha-manager status 2>/dev/null | awk ...`
- `ha_manager_status`, `is_ha_master`, `ha_services_pinned`, `maintenance` added to node response
- `/api/cluster/nfs-state` endpoint SSHes to each of the 6 NFS client LXCs, runs `findmnt -t nfs,nfs4 -n -o TARGET,FSTYPE`, returns `{host: [{target, ok}]}` (30 s cache)
- `maintenance.py` proxies three endpoints to OpenClaw: `GET /api/maintenance`, `POST /api/maintenance/enable`, `POST /api/maintenance/disable`

## New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/jobs/{id}/cancel` | Cancel a running job; SIGTERM then SIGKILL after 10 s |
| GET | `/api/app/version` | `{current, remote, behind}` for the UPDATE APP top-bar indicator |
| GET | `/api/cluster/nfs-state` | NFS mount state for 6 NFS client LXCs (30 s cache) |
| GET | `/api/maintenance` | Current OpenClaw maintenance state (proxied) |
| POST | `/api/maintenance/enable` | Enable OpenClaw maintenance (proxied) |
| POST | `/api/maintenance/disable` | Disable OpenClaw maintenance (proxied) |

## New SSE Event

`verify_report` -- emitted after the `done` event when the playbook is mapped in `openclaw.kinds`. Payload: `{status, summary, checks, concerns, actions?, fired_actions?}` from OpenClaw `ops-verify`.

- `actions` -- optional; present when `ops-verify` proposes `remediate-nfs` for one or more targets.
- `fired_actions` -- included when OpenClaw already fired jobs: `[{type, targets, reason, job_id, fired_at}]` on success, `[{type, targets, error}]` on rejection, `[{skipped: "cooldown"}]` on rate limit.

If OpenClaw is unreachable, payload is `{status: "unavailable"}`.

## Conventions

- Python 3.11+, FastAPI with uvicorn
- Config-driven playbooks (add new ones in config.yaml)
- Cluster operations use `cluster_operation: true` flag to skip `--limit` arg
- Config file (`config.yaml`) is excluded from deploy rsync
- Port: 8585

### Verify flow

After a job completes, `ansible_runner.py` calls `asyncio.create_task(_post_verify(job))` if the playbook name is in `config.openclaw.kinds`. The `openclaw.py` service POSTs to `openclaw.verify_url` and returns the verdict including the optional `actions` field. The runner emits the result as a `verify_report` SSE event. Failures in the verify call are logged and emitted as `{status: "unavailable"}`.

### Chain

`PlaybookEntry` has an optional `chain: list[str]` field. After a job completes with `rc=0`, each name in `chain` is auto-dispatched as a new job with the same `hosts` list. `CreateJob` (the POST body) also accepts an ad-hoc `chain` list. Used by the UPDATE LXCS + APP button on Patch Ops.

### Cancel

`POST /api/jobs/{id}/cancel` calls `ansible_runner.cancel(job_id)` which sends `proc.terminate()`, waits up to 10 seconds, then calls `proc.kill()`. The job transitions to FAILED with `cancel_reason="user"`. CANCEL button in the terminal overlay is enabled only while the job is RUNNING.

### Timeout fix

The stdout drain loop in `ansible_runner.py` is wrapped in `asyncio.wait_for(..., timeout=command_timeout)`. This ensures a silent-hang playbook is killed at the configured timeout.

### PatchMon refresh task

Every update playbook and `remediate-nfs.yml` ends with a `patchmon-agent report` task (`ignore_errors: yes`, `changed_when: false`). This forces each managed host to push fresh package data to PatchMon immediately.

### Static-asset caching

HTML responses carry `Cache-Control: no-store`; JS/CSS carry `Cache-Control: no-cache, must-revalidate`. Script/stylesheet tags carry a `?v=<unix-timestamp>` query string. Bump the timestamp with a `sed` one-liner whenever a release needs a guaranteed cache break.

### Bootstrap caveat

Any NFS client host missing the Ansible SSH key will show `ok: false, mounts: 0` in `/api/cluster/nfs-state`. Run `bootstrap-root-ssh.yml --limit <host>` with `LINUX_PASSWORD` from Infisical `/ssh` to fix it before the NFS state endpoint can query that host.

## Config Blocks

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
  maintenance_base_url: "http://192.168.2.226:9090"
  enabled: true
  kinds:
    node-update: proxmox_node
    node-reboot: proxmox_node
    rolling-restart: cluster
    update-lxc-system: lxc
    update-lxc-apps: lxc
    update-lxc-full: lxc
```

`maintenance_base_url` is consumed by `app/routers/maintenance.py` for the three `/api/maintenance` proxy endpoints.

### New playbook entries

```yaml
- name: "drain-node"
  file: "drain-node.yml"
  description: "Put a PVE node into HA maintenance without rebooting"

- name: "undrain-node"
  file: "undrain-node.yml"
  description: "Exit HA maintenance on a PVE node"

- name: "remediate-nfs"
  file: "remediate-nfs.yml"
  description: "Remount NFS on paperless + nzbget + arr stack and kick services"
  groups: ["nfs_clients"]
  cluster_operation: true
```
