import asyncio
import time
from pathlib import Path

from fastapi import APIRouter

from app.config import AppConfig

router = APIRouter(prefix="/api")

# Set by main.py during lifespan
app_config: AppConfig = AppConfig()

_cache: dict = {
    "current": None,
    "remote": None,
    "checked_at": 0,
}


async def _run(cmd: list[str], cwd: str) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, (stdout or stderr).decode("utf-8", errors="replace").strip()


async def _git_current(repo: str) -> str | None:
    rc, out = await _run(["git", "rev-parse", "HEAD"], repo)
    return out if rc == 0 else None


async def _git_remote(repo: str, branch: str) -> str | None:
    # branch may be "origin/main"; split for ls-remote
    if "/" in branch:
        remote, ref = branch.split("/", 1)
    else:
        remote, ref = "origin", branch
    rc, out = await _run(["git", "ls-remote", remote, ref], repo)
    if rc != 0 or not out:
        return None
    return out.split()[0]


@router.get("/app/version")
async def app_version():
    repo = app_config.repo_dir
    if not Path(repo).exists():
        return {
            "current": None,
            "remote": None,
            "behind": False,
            "error": f"repo not found: {repo}",
        }

    now = time.time()
    current = await _git_current(repo)

    cached_remote = _cache["remote"]
    cache_age = now - _cache["checked_at"]
    if cached_remote and cache_age < app_config.remote_check_ttl_seconds:
        remote = cached_remote
    else:
        remote = await _git_remote(repo, app_config.tracking_branch)
        if remote is not None:
            _cache["remote"] = remote
            _cache["checked_at"] = now

    behind = bool(current and remote and current != remote)
    return {
        "current": current,
        "remote": remote,
        "behind": behind,
        "tracking_branch": app_config.tracking_branch,
    }
