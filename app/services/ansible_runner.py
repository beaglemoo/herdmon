import asyncio
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

from app.config import AnsibleConfig


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Job:
    id: str
    playbook: str
    playbook_file: str
    hosts: list[str]
    status: JobStatus
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    return_code: int | None = None
    output_lines: list[str] = field(default_factory=list)
    subscribers: list[asyncio.Queue] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "playbook": self.playbook,
            "playbook_file": self.playbook_file,
            "hosts": self.hosts,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "return_code": self.return_code,
            "output_line_count": len(self.output_lines),
        }


class AnsibleRunner:
    def __init__(self, config: AnsibleConfig):
        self._config = config
        self._semaphore = asyncio.Semaphore(config.max_concurrent_jobs)
        self._jobs: dict[str, Job] = {}

    @property
    def jobs(self) -> list[Job]:
        return sorted(
            self._jobs.values(), key=lambda j: j.created_at, reverse=True
        )

    def get_job(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    async def create_job(
        self,
        playbook_name: str,
        playbook_file: str,
        hosts: list[str],
        extra_args: list[str] | None = None,
    ) -> Job:
        job = Job(
            id=str(uuid.uuid4()),
            playbook=playbook_name,
            playbook_file=playbook_file,
            hosts=hosts,
            status=JobStatus.QUEUED,
            created_at=datetime.now(timezone.utc),
        )
        self._jobs[job.id] = job
        asyncio.create_task(self._run_job(job, extra_args or []))
        return job

    async def _run_job(self, job: Job, extra_args: list[str] | None = None):
        async with self._semaphore:
            job.status = JobStatus.RUNNING
            job.started_at = datetime.now(timezone.utc)
            self._notify(job, None, event="status_change")

            playbook_path = os.path.join(
                self._config.playbook_dir, job.playbook_file
            )
            cmd = [
                "ansible-playbook",
                playbook_path,
                "-i",
                self._config.inventory_path,
            ]

            # Only add --limit if hosts are specified
            if job.hosts:
                cmd.extend(["--limit", ",".join(job.hosts)])

            # Append any extra args (e.g. -e confirm_each_node=false)
            if extra_args:
                cmd.extend(extra_args)

            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=self._config.working_dir,
                )

                async for line_bytes in proc.stdout:
                    line = line_bytes.decode("utf-8", errors="replace").rstrip()
                    job.output_lines.append(line)
                    self._notify(job, line, event="output")

                await asyncio.wait_for(
                    proc.wait(), timeout=self._config.command_timeout
                )
                job.return_code = proc.returncode

            except asyncio.TimeoutError:
                job.output_lines.append(
                    f"\n[moo-updater] Job timed out after {self._config.command_timeout}s"
                )
                self._notify(
                    job,
                    f"[moo-updater] Job timed out after {self._config.command_timeout}s",
                    event="output",
                )
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
                job.return_code = -1

            except Exception as e:
                error_msg = f"[moo-updater] Error: {e}"
                job.output_lines.append(error_msg)
                self._notify(job, error_msg, event="output")
                job.return_code = -1

            job.status = (
                JobStatus.COMPLETED if job.return_code == 0 else JobStatus.FAILED
            )
            job.finished_at = datetime.now(timezone.utc)
            self._notify(job, None, event="done")

    def _notify(self, job: Job, line: str | None, event: str):
        for queue in job.subscribers:
            queue.put_nowait({"event": event, "data": line, "job": job})

    def subscribe(self, job_id: str) -> asyncio.Queue | None:
        job = self._jobs.get(job_id)
        if not job:
            return None

        queue = asyncio.Queue()

        # Replay historical output
        for line in job.output_lines:
            queue.put_nowait({"event": "output", "data": line, "job": job})

        if job.status in (JobStatus.COMPLETED, JobStatus.FAILED):
            queue.put_nowait({"event": "done", "data": None, "job": job})
        else:
            job.subscribers.append(queue)

        return queue
