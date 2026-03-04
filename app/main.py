from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import load_config
from app.routers import hosts, jobs
from app.services.ansible_runner import AnsibleRunner
from app.services.patchmon import PatchmonClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_config()

    # Initialize Patchmon client
    patchmon = PatchmonClient(settings.patchmon)
    await patchmon.start()
    hosts.patchmon_client = patchmon

    # Parse Ansible inventory
    hosts.ansible_inventory = hosts.parse_ansible_inventory(
        settings.ansible.inventory_path
    )

    # Initialize Ansible runner
    runner = AnsibleRunner(settings.ansible)
    jobs.runner = runner
    jobs.playbook_config = settings.playbooks

    yield

    await patchmon.close()


app = FastAPI(title="moo-updater", version="1.0.0", lifespan=lifespan)

app.include_router(hosts.router)
app.include_router(jobs.router)

# Serve static files (must be last - catches all unmatched routes)
static_dir = Path(__file__).parent.parent / "static"
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
