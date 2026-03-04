import re

from fastapi import APIRouter, HTTPException

from app.services.patchmon import PatchmonClient

router = APIRouter(prefix="/api")

# Set by main.py during lifespan
patchmon_client: PatchmonClient = None
ansible_inventory: dict = {}


def parse_ansible_inventory(inventory_path: str) -> dict:
    """Parse Ansible INI inventory to build IP -> inventory_name mapping
    and host -> groups mapping."""
    ip_to_name = {}
    host_groups = {}
    current_group = None

    try:
        with open(inventory_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith(";"):
                    continue

                # Group header
                group_match = re.match(r"^\[([^\]:]+)\]", line)
                if group_match:
                    group_name = group_match.group(1)
                    # Skip :vars and :children sections
                    if ":" not in group_name:
                        current_group = group_name
                    else:
                        current_group = None
                    continue

                if current_group is None:
                    continue

                # Host entry
                parts = line.split()
                if not parts:
                    continue

                hostname = parts[0]
                ansible_host = None
                for part in parts[1:]:
                    if part.startswith("ansible_host="):
                        ansible_host = part.split("=", 1)[1]
                        break

                ip = ansible_host or hostname
                ip_to_name[ip] = hostname

                if hostname not in host_groups:
                    host_groups[hostname] = set()
                host_groups[hostname].add(current_group)
    except FileNotFoundError:
        pass

    # Convert sets to lists
    return {
        "ip_to_name": ip_to_name,
        "host_groups": {k: list(v) for k, v in host_groups.items()},
    }


@router.get("/hosts")
async def list_hosts():
    try:
        data = await patchmon_client.get_hosts(include_stats=True)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Patchmon API error: {e}")

    hosts = data.get("hosts", [])

    # Enrich with Ansible inventory info
    ip_to_name = ansible_inventory.get("ip_to_name", {})
    host_groups_map = ansible_inventory.get("host_groups", {})

    for host in hosts:
        ip = host.get("ip", "")
        inventory_name = ip_to_name.get(ip)
        host["ansible_name"] = inventory_name
        host["ansible_groups"] = host_groups_map.get(inventory_name, [])
        host["in_ansible"] = inventory_name is not None

    return {"hosts": hosts, "total": len(hosts)}


@router.get("/hosts/{host_id}/packages")
async def get_host_packages(host_id: str, updates_only: bool = False):
    try:
        return await patchmon_client.get_host_packages(host_id, updates_only)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Patchmon API error: {e}")
