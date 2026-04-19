import asyncio
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Awaitable, Callable, Optional

from app.config import AnsibleConfig, PlaybookEntry


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


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
    cancel_reason: str | None = None
    verify: dict | None = None
    output_lines: list[str] = field(default_factory=list)
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    _proc: Optional[asyncio.subprocess.Process] = None
    _chain: list[str] = field(default_factory=list)

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
            "cancel_reason": self.cancel_reason,
            "verify": self.verify,
            "output_line_count": len(self.output_lines),
        }


PostDoneHook = Callable[["Job"], Awaitable[None]]


class AnsibleRunner:
    def __init__(self, config: AnsibleConfig):
        self._config = config
        self._semaphore = asyncio.Semaphore(config.max_concurrent_jobs)
        self._jobs: dict[str, Job] = {}
        self._playbooks: dict[str, PlaybookEntry] = {}
        self._post_done_hook: PostDoneHook | None = None

    def set_playbooks(self, playbooks: list[PlaybookEntry]):
        self._playbooks = {p.name: p for p in playbooks}

    def set_post_done_hook(self, hook: PostDoneHook):
        self._post_done_hook = hook

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
        chain: list[str] | None = None,
    ) -> Job:
        job = Job(
            id=str(uuid.uuid4()),
            playbook=playbook_name,
            playbook_file=playbook_file,
            hosts=hosts,
            status=JobStatus.QUEUED,
            created_at=datetime.now(timezone.utc),
        )
        if chain:
            job._chain = list(chain)
        self._jobs[job.id] = job
        asyncio.create_task(self._run_job(job, extra_args or []))
        return job

    async def cancel_job(self, job_id: str, reason: str = "user") -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status != JobStatus.RUNNING or job._proc is None:
            return False

        job.cancel_reason = reason
        msg = f"[moo-updater] Job cancelled ({reason})"
        job.output_lines.append(msg)
        self._notify(job, msg, event="output")

        try:
            job._proc.terminate()
            try:
                await asyncio.wait_for(job._proc.wait(), timeout=10)
            except asyncio.TimeoutError:
                job._proc.kill()
                await job._proc.wait()
        except ProcessLookupError:
            pass
        return True

    def publish_verify(self, job: Job, report: dict):
        """Called by the verify hook when an AI verdict is ready."""
        job.verify = report
        self._notify(job, None, event="verify_report")

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
            if job.hosts:
                cmd.extend(["--limit", ",".join(job.hosts)])
            if extra_args:
                cmd.extend(extra_args)

            proc = None
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=self._config.working_dir,
                )
                job._proc = proc

                try:
                    await asyncio.wait_for(
                        self._drain_stdout(job, proc),
                        timeout=self._config.command_timeout,
                    )
                    job.return_code = proc.returncode
                except asyncio.TimeoutError:
                    timeout_msg = (
                        f"[moo-updater] Job timed out after "
                        f"{self._config.command_timeout}s (no progress)"
                    )
                    job.output_lines.append(timeout_msg)
                    self._notify(job, timeout_msg, event="output")
                    try:
                        proc.kill()
                        await proc.wait()
                    except ProcessLookupError:
                        pass
                    job.return_code = -1

            except Exception as e:
                error_msg = f"[moo-updater] Error: {e}"
                job.output_lines.append(error_msg)
                self._notify(job, error_msg, event="output")
                job.return_code = -1

            if job.cancel_reason:
                job.status = JobStatus.CANCELLED
            elif job.return_code == 0:
                job.status = JobStatus.COMPLETED
            else:
                job.status = JobStatus.FAILED
            job.finished_at = datetime.now(timezone.utc)

            if self._post_done_hook:
                asyncio.create_task(self._post_done_hook(job))

            self._notify(job, None, event="done")

            if job.status == JobStatus.COMPLETED and job._chain:
                await self._start_chain(job)

    async def _start_chain(self, previous: Job):
        next_name = previous._chain[0]
        remaining = previous._chain[1:]
        next_pb = self._playbooks.get(next_name)
        if not next_pb:
            msg = f"[moo-updater] Chain aborted: unknown playbook '{next_name}'"
            previous.output_lines.append(msg)
            self._notify(previous, msg, event="output")
            return
        hosts = [] if next_pb.cluster_operation else previous.hosts
        await self.create_job(
            next_pb.name,
            next_pb.file,
            hosts,
            next_pb.extra_args,
            remaining,
        )

    async def _drain_stdout(self, job: Job, proc: asyncio.subprocess.Process):
        async for line_bytes in proc.stdout:
            line = line_bytes.decode("utf-8", errors="replace").rstrip()
            job.output_lines.append(line)
            self._notify(job, line, event="output")
        await proc.wait()

    def _notify(self, job: Job, line: str | None, event: str):
        for queue in job.subscribers:
            queue.put_nowait({"event": event, "data": line, "job": job})

    def subscribe(self, job_id: str) -> asyncio.Queue | None:
        job = self._jobs.get(job_id)
        if not job:
            return None

        queue = asyncio.Queue()

        for line in job.output_lines:
            queue.put_nowait({"event": "output", "data": line, "job": job})

        if job.status in (
            JobStatus.COMPLETED,
            JobStatus.FAILED,
            JobStatus.CANCELLED,
        ):
            if job.verify is not None:
                queue.put_nowait({"event": "verify_report", "data": None, "job": job})
            queue.put_nowait({"event": "done", "data": None, "job": job})
        else:
            job.subscribers.append(queue)

        return queue
