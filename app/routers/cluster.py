import asyncio
import re
import time

from fastapi import APIRouter

from app.config import ClusterNode

router = APIRouter(prefix="/api")

# Set by main.py during lifespan
cluster_nodes: list[ClusterNode] = []

# Cache
_cache: dict = {"data": None, "timestamp": 0}
_CACHE_TTL = 15


def _parse_ha_status(ha_lines: list[str], node_name: str) -> dict:
    """Parse ha-manager status output for a given node."""
    result = {
        "is_ha_master": False,
        "ha_lrm_state": None,
        "ha_services_pinned": None,
        "maintenance": None,
    }

    if not ha_lines or all(l.strip() == "" for l in ha_lines):
        return result

    services_pinned = 0
    in_maintenance_section = False

    for line in ha_lines:
        line = line.strip()
        if not line:
            continue

        # master pve3 (active, <timestamp>)
        m = re.match(r"^master\s+(\S+)", line)
        if m:
            result["is_ha_master"] = (m.group(1) == node_name)
            continue

        # lrm pveN (state, <timestamp>)
        m = re.match(r"^lrm\s+(\S+)\s+\((\w+),", line)
        if m and m.group(1) == node_name:
            result["ha_lrm_state"] = m.group(2)
            continue

        # service ct:328 (pve3, started)
        m = re.match(r"^service\s+\S+\s+\((\S+),", line)
        if m:
            node_in_service = m.group(1).rstrip(",")
            if node_in_service == node_name:
                services_pinned += 1
            continue

        # node-maintenance: section header
        if line.startswith("node-maintenance:"):
            in_maintenance_section = True
            continue

        # Lines under node-maintenance: section look like "  pveN: enabled"
        if in_maintenance_section:
            if re.match(r"^\S", line):
                in_maintenance_section = False
            else:
                m = re.match(r"(\S+):\s*(\w+)", line)
                if m and m.group(1) == node_name:
                    result["maintenance"] = m.group(2) == "enabled"

    result["ha_services_pinned"] = services_pinned
    if result["ha_lrm_state"] is None:
        result["ha_lrm_state"] = "unknown"
    if result["maintenance"] is None:
        result["maintenance"] = False

    return result


async def _query_node(node: ClusterNode) -> dict:
    """SSH into a node and gather status info."""
    result = {
        "name": node.name,
        "ip": node.ip,
        "type": node.type,
        "online": False,
        "uptime": None,
        "kernel": None,
        "pve_version": None,
        "running_cts": 0,
        "running_vms": 0,
        "total_cts": 0,
        "total_vms": 0,
        "is_ha_master": None,
        "ha_lrm_state": None,
        "ha_services_pinned": None,
        "maintenance": None,
    }

    cmd = (
        "echo '---UPTIME---' && uptime -p && "
        "echo '---KERNEL---' && uname -r && "
        "echo '---PVE---' && (pveversion 2>/dev/null || echo 'N/A') && "
        "echo '---CTS---' && (pct list 2>/dev/null | awk 'NR>1{print $2}' || echo '') && "
        "echo '---VMS---' && (qm list 2>/dev/null | awk 'NR>1{print $3}' || echo '') && "
        "echo '---HA---' && (ha-manager status 2>/dev/null || true)"
    )

    try:
        proc = await asyncio.create_subprocess_exec(
            "ssh",
            "-o", "ConnectTimeout=5",
            "-o", "StrictHostKeyChecking=no",
            "-o", "BatchMode=yes",
            f"root@{node.ip}",
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)

        if proc.returncode != 0:
            return result

        output = stdout.decode("utf-8", errors="replace")
        result["online"] = True

        sections = {}
        current_section = None
        for line in output.strip().split("\n"):
            line = line.strip()
            if line.startswith("---") and line.endswith("---"):
                current_section = line.strip("-")
                sections[current_section] = []
            elif current_section:
                sections[current_section].append(line)

        if "UPTIME" in sections:
            result["uptime"] = " ".join(sections["UPTIME"]).strip()

        if "KERNEL" in sections:
            result["kernel"] = " ".join(sections["KERNEL"]).strip()

        if "PVE" in sections:
            result["pve_version"] = " ".join(sections["PVE"]).strip()

        if "CTS" in sections:
            statuses = [s for s in sections["CTS"] if s]
            result["total_cts"] = len(statuses)
            result["running_cts"] = sum(1 for s in statuses if s == "running")

        if "VMS" in sections:
            statuses = [s for s in sections["VMS"] if s]
            result["total_vms"] = len(statuses)
            result["running_vms"] = sum(1 for s in statuses if s == "running")

        if "HA" in sections:
            ha_fields = _parse_ha_status(sections["HA"], node.name)
            result.update(ha_fields)

    except (asyncio.TimeoutError, Exception):
        pass

    return result


@router.get("/cluster/nodes")
async def get_cluster_nodes():
    now = time.time()

    if _cache["data"] is not None and (now - _cache["timestamp"]) < _CACHE_TTL:
        return {"nodes": _cache["data"]}

    tasks = [_query_node(node) for node in cluster_nodes]
    results = await asyncio.gather(*tasks)

    _cache["data"] = results
    _cache["timestamp"] = now

    return {"nodes": results}
