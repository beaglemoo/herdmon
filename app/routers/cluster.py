import asyncio
import time

from fastapi import APIRouter

from app.config import ClusterNode

router = APIRouter(prefix="/api")

# Set by main.py during lifespan
cluster_nodes: list[ClusterNode] = []

# Cache
_cache: dict = {"data": None, "timestamp": 0}
_CACHE_TTL = 30


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
    }

    cmd = (
        "echo '---UPTIME---' && uptime -p && "
        "echo '---KERNEL---' && uname -r && "
        "echo '---PVE---' && (pveversion 2>/dev/null || echo 'N/A') && "
        "echo '---CTS---' && (pct list 2>/dev/null | awk 'NR>1{print $2}' || echo '') && "
        "echo '---VMS---' && (qm list 2>/dev/null | awk 'NR>1{print $3}' || echo '')"
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

    except (asyncio.TimeoutError, Exception):
        pass

    return result


@router.get("/cluster/nodes")
async def get_cluster_nodes():
    now = time.time()

    # Return cached data if fresh
    if _cache["data"] is not None and (now - _cache["timestamp"]) < _CACHE_TTL:
        return {"nodes": _cache["data"]}

    # Query all nodes in parallel
    tasks = [_query_node(node) for node in cluster_nodes]
    results = await asyncio.gather(*tasks)

    _cache["data"] = results
    _cache["timestamp"] = now

    return {"nodes": results}
