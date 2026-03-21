import os
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8585


class PatchmonConfig(BaseModel):
    base_url: str = "http://localhost:3000"
    token_key: str = ""
    token_secret: str = ""


class AnsibleConfig(BaseModel):
    playbook_dir: str = "/root/ansible/playbooks"
    inventory_path: str = "/root/ansible/inventory/hosts"
    working_dir: str = "/root/ansible"
    max_concurrent_jobs: int = 3
    command_timeout: int = 1800


class ClusterNode(BaseModel):
    name: str
    ip: str
    type: str = "proxmox"  # proxmox or pbs


class PlaybookEntry(BaseModel):
    name: str
    file: str
    description: str
    groups: list[str] = []
    cluster_operation: bool = False
    extra_args: list[str] = []


class Settings(BaseModel):
    server: ServerConfig = ServerConfig()
    patchmon: PatchmonConfig = PatchmonConfig()
    ansible: AnsibleConfig = AnsibleConfig()
    playbooks: list[PlaybookEntry] = []
    cluster_nodes: list[ClusterNode] = []


def load_config(config_path: Optional[str] = None) -> Settings:
    if config_path is None:
        config_path = os.environ.get(
            "MOO_UPDATER_CONFIG",
            str(Path(__file__).parent.parent / "config.yaml"),
        )

    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(path) as f:
        data = yaml.safe_load(f)

    return Settings(**data)
