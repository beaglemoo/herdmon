import logging

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api")

logger = logging.getLogger(__name__)

# Set by main.py during lifespan
maintenance_base_url: str = "http://192.168.2.226:9090"


@router.get("/maintenance")
async def get_maintenance():
    url = f"{maintenance_base_url}/maintenance"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.warning("OpenClaw maintenance GET failed: %s", e)
        return JSONResponse(
            status_code=502,
            content={"error": "OpenClaw unreachable", "detail": str(e)},
        )


@router.post("/maintenance/enable")
async def enable_maintenance(request: Request):
    url = f"{maintenance_base_url}/maintenance/enable"
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.warning("OpenClaw maintenance enable failed: %s", e)
        return JSONResponse(
            status_code=502,
            content={"error": "OpenClaw unreachable", "detail": str(e)},
        )


@router.post("/maintenance/disable")
async def disable_maintenance():
    url = f"{maintenance_base_url}/maintenance/disable"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.warning("OpenClaw maintenance disable failed: %s", e)
        return JSONResponse(
            status_code=502,
            content={"error": "OpenClaw unreachable", "detail": str(e)},
        )
