from __future__ import annotations

import argparse
import os
import runpy
import sys
from pathlib import Path


def is_link(path: Path) -> bool:
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def regular_file(path: Path, label: str) -> Path:
    if is_link(path):
        raise RuntimeError(f"{label} must not be a link: {path}")
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise RuntimeError(f"{label} must be a regular non-symlink file: {resolved}")
    return resolved


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Launch the released DWG Quantity Surveyor MCP for one SID workspace."
    )
    parser.add_argument("--plugin-root", required=True)
    parser.add_argument("--workspace-root", required=True)
    parser.add_argument("--health", action="store_true")
    arguments = parser.parse_args()

    plugin_root = Path(arguments.plugin_root).resolve(strict=True)
    if not plugin_root.is_dir() or is_link(Path(arguments.plugin_root)):
        raise RuntimeError(
            f"DWG Quantity plugin root must be a directory, not a link: {plugin_root}"
        )
    launcher = regular_file(plugin_root / "scripts" / "run_mcp.py", "DWG MCP launcher")
    workspace_root = Path(arguments.workspace_root).resolve(strict=True)
    if not workspace_root.is_dir() or is_link(Path(arguments.workspace_root)):
        raise RuntimeError(
            f"DWG workspace root must be a directory, not a link: {workspace_root}"
        )

    os.environ["DWG_QUANTITY_ROOT"] = str(workspace_root)
    sys.argv = [str(launcher), *(["--health"] if arguments.health else [])]
    runpy.run_path(str(launcher), run_name="__main__")


if __name__ == "__main__":
    main()
