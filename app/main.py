from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import load_config
from app.routers import cluster, health, hosts, jobs
from app.services.ansible_runner import AnsibleRunner
from app.services.openclaw import OpenClawClient
from app.services.patchmon import PatchmonClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_config()

    patchmon = PatchmonClient(settings.patchmon)
    await patchmon.start()
    hosts.patchmon_client = patchmon

    hosts.ansible_inventory = hosts.parse_ansible_inventory(
        settings.ansible.inventory_path
    )

    runner = AnsibleRunner(settings.ansible)
    runner.set_playbooks(settings.playbooks)
    jobs.runner = runner
    jobs.playbook_config = settings.playbooks

    cluster.cluster_nodes = settings.cluster_nodes

    health.app_config = settings.app

    openclaw = OpenClawClient(settings.openclaw, runner)
    await openclaw.start()
    runner.set_post_done_hook(openclaw.on_job_done)

    yield

    await openclaw.close()
    await patchmon.close()


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.endswith((".html",)) or path == "/" or path == "/cluster.html":
            response.headers["Cache-Control"] = "no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        elif path.endswith((".js", ".css")):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app = FastAPI(title="moo-updater", version="1.0.0", lifespan=lifespan)
app.add_middleware(NoCacheStaticMiddleware)

app.include_router(hosts.router)
app.include_router(jobs.router)
app.include_router(cluster.router)
app.include_router(health.router)

static_dir = Path(__file__).parent.parent / "static"
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
