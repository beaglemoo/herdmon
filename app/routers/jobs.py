import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from app.config import PlaybookEntry
from app.services.ansible_runner import AnsibleRunner

router = APIRouter(prefix="/api")

# Set by main.py during lifespan
runner: AnsibleRunner = None
playbook_config: list[PlaybookEntry] = []


class CreateJobRequest(BaseModel):
    playbook: str
    hosts: list[str] = []


@router.get("/playbooks")
async def list_playbooks():
    return {
        "playbooks": [
            {
                "name": p.name,
                "file": p.file,
                "description": p.description,
                "groups": p.groups,
                "cluster_operation": p.cluster_operation,
            }
            for p in playbook_config
        ]
    }


@router.post("/jobs")
async def create_job(request: CreateJobRequest):
    # Find the playbook config entry
    pb = next((p for p in playbook_config if p.name == request.playbook), None)
    if not pb:
        raise HTTPException(status_code=400, detail=f"Unknown playbook: {request.playbook}")

    if not request.hosts and not pb.cluster_operation:
        raise HTTPException(status_code=400, detail="No hosts specified")

    job = await runner.create_job(pb.name, pb.file, request.hosts, pb.extra_args)
    return {"job_id": job.id, "status": job.status.value}


@router.get("/jobs")
async def list_jobs():
    return {
        "jobs": [job.to_dict() for job in runner.jobs]
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = runner.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    result = job.to_dict()
    result["output"] = job.output_lines
    return result


@router.get("/jobs/{job_id}/stream")
async def stream_job(job_id: str):
    queue = runner.subscribe(job_id)
    if queue is None:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        while True:
            msg = await queue.get()
            event = msg["event"]
            job = msg["job"]

            if event == "output":
                yield {"event": "output", "data": msg["data"]}
            elif event == "status_change":
                yield {
                    "event": "status",
                    "data": json.dumps({"status": job.status.value}),
                }
            elif event == "done":
                yield {
                    "event": "done",
                    "data": json.dumps({
                        "status": job.status.value,
                        "return_code": job.return_code,
                    }),
                }
                # Remove subscriber
                if queue in job.subscribers:
                    job.subscribers.remove(queue)
                break

    return EventSourceResponse(event_generator())
