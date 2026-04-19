import asyncio
import logging
from typing import Optional

import httpx

from app.config import OpenClawConfig
from app.services.ansible_runner import AnsibleRunner, Job, JobStatus

logger = logging.getLogger(__name__)

_OUTPUT_TAIL_LINES = 200


class OpenClawClient:
    def __init__(self, config: OpenClawConfig, runner: AnsibleRunner):
        self._config = config
        self._runner = runner
        self._client: Optional[httpx.AsyncClient] = None

    async def start(self):
        if not self._config.enabled:
            return
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(self._config.timeout_seconds)
        )

    async def close(self):
        if self._client is not None:
            await self._client.aclose()

    async def on_job_done(self, job: Job):
        if not self._config.enabled or self._client is None:
            return

        kind = self._config.kinds.get(job.playbook)
        if not kind:
            return

        if job.status not in (JobStatus.COMPLETED, JobStatus.FAILED):
            return

        tail = "\n".join(job.output_lines[-_OUTPUT_TAIL_LINES:])
        payload = {
            "job_id": job.id,
            "playbook": job.playbook,
            "kind": kind,
            "targets": job.hosts,
            "return_code": job.return_code,
            "output_tail": tail,
        }

        try:
            resp = await self._client.post(self._config.verify_url, json=payload)
            resp.raise_for_status()
            report = resp.json()
        except (httpx.HTTPError, ValueError, asyncio.TimeoutError) as e:
            logger.warning("OpenClaw verify failed for job %s: %s", job.id, e)
            report = {
                "status": "unavailable",
                "error": str(e),
                "summary": "AI verification unavailable (OpenClaw unreachable).",
            }

        fired = report.get("fired_actions")
        if fired:
            logger.info("OpenClaw fired_actions for job %s: %s", job.id, fired)

        self._runner.publish_verify(job, report)
