import httpx

from app.config import PatchmonConfig


class PatchmonClient:
    def __init__(self, config: PatchmonConfig):
        self._base_url = config.base_url.rstrip("/")
        self._auth = httpx.BasicAuth(config.token_key, config.token_secret)
        self._client: httpx.AsyncClient | None = None

    async def start(self):
        self._client = httpx.AsyncClient(
            base_url=f"{self._base_url}/api/v1/api",
            auth=self._auth,
            timeout=30.0,
        )

    async def close(self):
        if self._client:
            await self._client.aclose()

    async def get_hosts(self, include_stats: bool = True) -> dict:
        params = {}
        if include_stats:
            params["include"] = "stats"
        resp = await self._client.get("/hosts", params=params)
        resp.raise_for_status()
        return resp.json()

    async def get_host_packages(
        self, host_id: str, updates_only: bool = False
    ) -> dict:
        params = {}
        if updates_only:
            params["updates_only"] = "true"
        resp = await self._client.get(f"/hosts/{host_id}/packages", params=params)
        resp.raise_for_status()
        return resp.json()

    async def get_host_info(self, host_id: str) -> dict:
        resp = await self._client.get(f"/hosts/{host_id}/info")
        resp.raise_for_status()
        return resp.json()
