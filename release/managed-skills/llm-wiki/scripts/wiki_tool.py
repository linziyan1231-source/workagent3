#!/usr/bin/env python3
"""Deterministic mechanics for the llm-wiki skills.

The script intentionally does not call an LLM. It initializes a workspace,
computes due work, performs structural lint, snapshots preimages, applies
machine-state retention, and manages a project lease. Semantic decisions remain
in the skills.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote


CONFIG_SCHEMA = "llm-wiki.config.v2"
LEGACY_CONFIG_SCHEMA = "llm-wiki.config.v1"
MANIFEST_SCHEMA = "llm-wiki.manifest.v1"
DREAM_MODEL = "gpt-5.6-luna"
DREAM_REASONING_EFFORT = "xhigh"
START_MARKER = "<!-- wiki-llm:managed:start -->"
END_MARKER = "<!-- wiki-llm:managed:end -->"
PAGE_DIRS = ("topics", "decisions", "entities", "procedures", "syntheses", "archive")
REQUIRED_PAGE_FIELDS = (
    "type",
    "title",
    "description",
    "status",
    "knowledge_state",
    "generated",
    "stale_after",
    "valid_until",
    "purge_after",
    "sources",
)
ALLOWED_OKF_STATUSES = {"draft", "stable", "deprecated"}
ALLOWED_KNOWLEDGE_STATES = {
    "active",
    "review_due",
    "contested",
    "expired",
    "superseded",
    "archived",
}
ALLOWED_WEEKDAYS = {"MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"}
MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
FRONTMATTER_ROOT_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$")
FRONTMATTER_MAP_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$")
REPARSE_POINT_ATTRIBUTE = 0x400
TERMINAL_RUN_STATES = {"completed", "complete", "no_work", "rolled_back"}


class WikiError(RuntimeError):
    pass


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_utc(value: dt.datetime | None = None) -> str:
    current = value or utc_now()
    return current.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value: Any) -> dt.datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"null", "none", "~"}:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise WikiError(f"invalid ISO date/time: {text}") from exc
    if isinstance(parsed, dt.datetime):
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    raise WikiError(f"invalid ISO date/time: {text}")


def project_root(path: str) -> Path:
    root = Path(path).expanduser().resolve()
    if not root.is_dir():
        raise WikiError(f"project root is not a directory: {root}")
    return root


def confined(root: Path, relative: str | Path) -> Path:
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts:
        raise WikiError(f"path must be project-relative: {relative}")
    target = (root / rel).resolve(strict=False)
    try:
        common = Path(os.path.commonpath((str(root), str(target))))
    except ValueError as exc:
        raise WikiError(f"path escapes project root: {relative}") from exc
    if common != root:
        raise WikiError(f"path escapes project root: {relative}")
    return target


def relative_posix(root: Path, path: Path) -> str:
    return path.resolve(strict=False).relative_to(root).as_posix()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def read_json(path: Path, *, required: bool = True) -> dict[str, Any]:
    if not path.exists():
        if required:
            raise WikiError(f"missing JSON file: {path}")
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise WikiError(f"invalid JSON file {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise WikiError(f"JSON root must be an object: {path}")
    return value


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def workspace_paths(root: Path) -> tuple[Path, Path, Path, Path]:
    bootstrap_config = root / "wiki-llm" / "config.json"
    config = read_json(bootstrap_config)
    if config.get("schema") not in {CONFIG_SCHEMA, LEGACY_CONFIG_SCHEMA}:
        raise WikiError(f"unsupported config schema in {bootstrap_config}")
    workspace_value = config.get("workspace_dir", "wiki-llm")
    state_value = config.get("state_dir", ".agent-state/wiki-llm")
    if not isinstance(workspace_value, str) or not workspace_value.strip():
        raise WikiError("config workspace_dir must be a nonempty project-relative string")
    if not isinstance(state_value, str) or not state_value.strip():
        raise WikiError("config state_dir must be a nonempty project-relative string")
    workspace = confined(root, workspace_value)
    state = confined(root, state_value)
    manifest = state / "manifest.json"
    return workspace, state, manifest, bootstrap_config


def parse_scalar(text: str) -> Any:
    value = text.strip()
    if not value or value.lower() in {"null", "none", "~"}:
        return None
    if value.startswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise WikiError(f"unsupported canonical YAML scalar: {value}") from exc
    if value.startswith("'"):
        if not value.endswith("'") or "'" in value[1:-1]:
            raise WikiError(f"unsupported canonical YAML scalar: {value}")
        return value[1:-1]
    if value.startswith("["):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise WikiError(
                "canonical inline lists must be JSON arrays with double-quoted strings"
            ) from exc
        if not isinstance(parsed, list):
            raise WikiError(f"unsupported canonical YAML scalar: {value}")
        return parsed
    if value.startswith(("{", "|", ">", "&", "*", "!")):
        raise WikiError(f"unsupported canonical YAML scalar: {value}")
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    if re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value):
        return int(value)
    if re.fullmatch(r"-?(?:0|[1-9][0-9]*)\.[0-9]+", value):
        return float(value)
    return value


def read_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise WikiError(f"cannot read Markdown file {path}: {exc}") from exc
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if end is None:
        raise WikiError(f"unclosed frontmatter: {path}")
    fields: dict[str, Any] = {}
    index = 1
    while index < end:
        line = lines[index]
        if not line.strip() or line.lstrip().startswith("#"):
            index += 1
            continue
        if line.startswith((" ", "\t")):
            raise WikiError(
                f"unsupported canonical YAML indentation at line {index + 1}: {path}"
            )
        match = FRONTMATTER_ROOT_RE.fullmatch(line)
        if not match:
            raise WikiError(
                f"unsupported canonical YAML at line {index + 1}: {path}"
            )
        key, raw = match.group(1), (match.group(2) or "")
        if key in fields:
            raise WikiError(f"duplicate frontmatter key {key}: {path}")
        if raw.strip():
            fields[key] = parse_scalar(raw)
            index += 1
            continue
        if index + 1 >= end or not lines[index + 1].strip():
            raise WikiError(
                f"empty frontmatter value for {key}; use null or []: {path}"
            )
        items: list[Any] = []
        mapping_value: dict[str, Any] = {}
        cursor = index + 1
        block_kind: str | None = None
        while cursor < end:
            child = lines[cursor]
            if not child.strip() or child.lstrip().startswith("#"):
                cursor += 1
                continue
            if not child.startswith((" ", "\t")):
                break
            if child.startswith("\t"):
                raise WikiError(
                    f"tabs are not allowed in canonical YAML at line {cursor + 1}: {path}"
                )
            item = re.fullmatch(r"  -\s+(.+?)\s*", child)
            if item:
                if block_kind == "mapping":
                    raise WikiError(f"mixed list and mapping for {key}: {path}")
                block_kind = "list"
                raw_item = item.group(1)
                item_mapping = FRONTMATTER_MAP_RE.fullmatch(raw_item)
                if item_mapping:
                    item_key = item_mapping.group(1)
                    item_raw = item_mapping.group(2)
                    if item_raw is None or not item_raw.strip():
                        raise WikiError(
                            f"nested mappings are not supported at line {cursor + 1}: {path}"
                        )
                    mapping: dict[str, Any] = {item_key: parse_scalar(item_raw)}
                    cursor += 1
                    while cursor < end:
                        if not lines[cursor].strip() or lines[cursor].lstrip().startswith("#"):
                            cursor += 1
                            continue
                        nested = re.fullmatch(
                            r"    ([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?",
                            lines[cursor],
                        )
                        if not nested:
                            break
                        nested_key, nested_raw = nested.group(1), nested.group(2)
                        if nested_key in mapping:
                            raise WikiError(
                                f"duplicate frontmatter key {nested_key}: {path}"
                            )
                        if nested_raw is None or not nested_raw.strip():
                            raise WikiError(
                                f"nested mappings are not supported at line {cursor + 1}: {path}"
                            )
                        mapping[nested_key] = parse_scalar(nested_raw)
                        cursor += 1
                    items.append(mapping)
                    continue
                items.append(parse_scalar(raw_item))
                cursor += 1
                continue
            nested_mapping = re.fullmatch(
                r"  ([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?", child
            )
            if nested_mapping:
                if block_kind == "list":
                    raise WikiError(f"mixed list and mapping for {key}: {path}")
                block_kind = "mapping"
                nested_key, nested_raw = nested_mapping.group(1), nested_mapping.group(2)
                if nested_key in mapping_value:
                    raise WikiError(f"duplicate frontmatter key {nested_key}: {path}")
                if nested_raw is None or not nested_raw.strip():
                    raise WikiError(
                        f"nested mappings are not supported at line {cursor + 1}: {path}"
                    )
                mapping_value[nested_key] = parse_scalar(nested_raw)
                cursor += 1
                continue
            raise WikiError(
                f"unsupported canonical YAML indentation at line {cursor + 1}: {path}"
            )
        if block_kind is None:
            raise WikiError(f"empty frontmatter value for {key}; use null or []: {path}")
        fields[key] = items if block_kind == "list" else mapping_value
        index = cursor
    return fields, text


def extract_link_destination(raw: str) -> str | None:
    value = raw.strip()
    if value.startswith("<") and ">" in value:
        value = value[1 : value.index(">")]
    else:
        value = value.split(maxsplit=1)[0]
    value = unquote(value).split("#", 1)[0].split("?", 1)[0].strip()
    if not value or value.startswith(("#", "mailto:")):
        return None
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", value):
        return None
    return value


def add_finding(
    findings: list[dict[str, Any]],
    severity: str,
    code: str,
    path: str,
    message: str,
    *,
    evidence: Iterable[str] = (),
    suggested_action: str | None = None,
) -> None:
    item: dict[str, Any] = {
        "severity": severity,
        "code": code,
        "path": path,
        "message": message,
        "evidence": list(evidence),
    }
    if suggested_action:
        item["suggested_action"] = suggested_action
    findings.append(item)


def template_content(name: str, project_name: str, generated_at: str) -> str:
    template = Path(__file__).resolve().parent.parent / "assets" / "workspace" / name
    if not template.is_file():
        raise WikiError(f"missing plugin asset: {template}")
    return (
        template.read_text(encoding="utf-8")
        .replace("{{PROJECT_NAME}}", project_name)
        .replace("{{GENERATED_AT}}", generated_at)
    )


def detect_workspace_state(root: Path) -> str:
    workspace = root / "wiki-llm"
    state = root / ".agent-state" / "wiki-llm"
    config_path = workspace / "config.json"
    if config_path.exists():
        config = read_json(config_path)
        schema = config.get("schema")
        if schema == CONFIG_SCHEMA:
            return "current-okf"
        if schema == LEGACY_CONFIG_SCHEMA:
            return "legacy-migration-required"
        raise WikiError(f"unsupported config schema in {config_path}")

    agents = root / "AGENTS.md"
    has_managed_block = agents.is_file() and START_MARKER in agents.read_text(
        encoding="utf-8"
    )
    workspace_has_content = workspace.exists() and (
        not workspace.is_dir() or any(workspace.iterdir())
    )
    state_has_content = state.exists() and (not state.is_dir() or any(state.iterdir()))
    if workspace_has_content or state_has_content or has_managed_block:
        return "legacy-migration-required"
    return "new"


def init_workspace(root: Path, apply: bool) -> dict[str, Any]:
    workspace_state = detect_workspace_state(root)
    if workspace_state == "legacy-migration-required":
        return {
            "applied": False,
            "workspace_state": workspace_state,
            "actions": [
                {
                    "action": "migration-required",
                    "path": "wiki-llm",
                    "reason": "existing Wiki or machine state requires an explicit lossless migration plan",
                }
            ],
        }

    workspace = root / "wiki-llm"
    state = root / ".agent-state" / "wiki-llm"
    directories = [
        workspace,
        *(workspace / name for name in ("references", "references/sources", *PAGE_DIRS)),
        state,
        *(state / name for name in ("candidates", "preimages", "runs", "lint")),
    ]
    generated_at = utc_now()
    generated_date = generated_at.date().isoformat()
    index_content = template_content("index.md", root.name, generated_date)
    log_content = template_content("log.md", root.name, generated_date)
    contract_content = template_content("contract.md", root.name, generated_date)
    config_content = template_content("config.json", root.name, generated_date)
    contract_path = workspace / "contract.md"
    manifest_path = state / "manifest.json"
    seed_existing_contract = not manifest_path.exists() and contract_path.is_file()
    manifest_contract_content = (
        contract_path.read_text(encoding="utf-8")
        if seed_existing_contract
        else contract_content
    )
    if seed_existing_contract:
        contract_fields, _ = read_frontmatter(contract_path)
    else:
        contract_fields = {
            "type": "Knowledge Contract",
            "status": "stable",
            "knowledge_state": "active",
            "stale_after": None,
            "valid_until": None,
            "purge_after": None,
        }
    files = {
        workspace / "index.md": index_content,
        workspace / "log.md": log_content,
        workspace / "contract.md": contract_content,
        workspace / "config.json": config_content,
        manifest_path: json.dumps(
            {
                "schema": MANIFEST_SCHEMA,
                "generated_at": iso_utc(generated_at),
                "next_due_at": None,
                "sources": {},
                "pages": {
                    "contract.md": {
                        "sha256": sha256_text(manifest_contract_content),
                        "type": contract_fields.get("type"),
                        "status": contract_fields.get("status"),
                        "knowledge_state": contract_fields.get("knowledge_state"),
                        "stale_after": contract_fields.get("stale_after"),
                        "valid_until": contract_fields.get("valid_until"),
                        "purge_after": contract_fields.get("purge_after"),
                        "purge_eligible": False,
                    }
                },
                "pending": [],
            },
            indent=2,
        )
        + "\n",
    }
    actions: list[dict[str, str]] = []
    for directory in directories:
        actions.append(
            {
                "action": "keep-directory" if directory.is_dir() else "create-directory",
                "path": relative_posix(root, directory),
            }
        )
    for path in files:
        actions.append(
            {
                "action": "keep-file" if path.exists() else "create-file",
                "path": relative_posix(root, path),
            }
        )

    agents = root / "AGENTS.md"
    existing = agents.read_text(encoding="utf-8") if agents.exists() else ""
    start_count, end_count = existing.count(START_MARKER), existing.count(END_MARKER)
    if (start_count, end_count) not in {(0, 0), (1, 1)}:
        raise WikiError("AGENTS.md has duplicate or unbalanced llm-wiki managed markers")
    if start_count == 0:
        actions.append(
            {
                "action": "append-managed-block" if agents.exists() else "create-agents",
                "path": "AGENTS.md",
            }
        )
    else:
        actions.append({"action": "keep-managed-block", "path": "AGENTS.md"})

    if not apply:
        return {
            "applied": False,
            "workspace_state": workspace_state,
            "actions": actions,
        }

    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)
    for path, content in files.items():
        if not path.exists():
            atomic_write_text(path, content)

    if start_count == 0:
        if agents.exists():
            stamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
            preimage = (
                state
                / "preimages"
                / f"setup-{stamp}-{uuid.uuid4().hex[:8]}"
                / "AGENTS.md"
            )
            preimage.parent.mkdir(parents=True, exist_ok=False)
            shutil.copy2(agents, preimage)
        block = template_content("AGENTS.block.md", root.name, generated_date).strip()
        separator = "" if not existing else ("\n" if existing.endswith("\n") else "\n\n")
        atomic_write_text(agents, existing + separator + block + "\n")

    return {"applied": True, "workspace_state": workspace_state, "actions": actions}


def excluded_source(relative: str, patterns: list[str], workspace_rel: str, state_rel: str) -> bool:
    hard = (workspace_rel.rstrip("/"), state_rel.rstrip("/"), ".git")
    if any(relative == prefix or relative.startswith(prefix + "/") for prefix in hard):
        return True
    for pattern in patterns:
        normalized = pattern.replace("\\", "/")
        if normalized.endswith("/**"):
            prefix = normalized[:-3].rstrip("/")
            if relative == prefix or relative.startswith(prefix + "/"):
                return True
        if fnmatch.fnmatch(relative, normalized):
            return True
    return False


def discover_configured_sources(root: Path, config: dict[str, Any]) -> list[str]:
    roots = config.get("source_roots", [])
    extension_values = config.get("source_extensions", [])
    exclude_values = config.get("exclude", [])
    for field, value in (
        ("source_roots", roots),
        ("source_extensions", extension_values),
        ("exclude", exclude_values),
    ):
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise WikiError(f"config {field} must be a list of strings")
    extensions = {item.lower() for item in extension_values}
    patterns = list(exclude_values)
    workspace_rel = str(config.get("workspace_dir", "wiki-llm")).replace("\\", "/")
    state_rel = str(config.get("state_dir", ".agent-state/wiki-llm")).replace("\\", "/")
    maximum = config.get("max_scan_files", 5000)
    if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum <= 0:
        raise WikiError("config max_scan_files must be a positive integer")
    discovered: set[str] = set()
    for configured in roots:
        target = confined(root, str(configured))
        if target.is_file():
            relative = relative_posix(root, target)
            if not excluded_source(relative, patterns, workspace_rel, state_rel):
                if not extensions or target.suffix.lower() in extensions:
                    discovered.add(relative)
            continue
        if not target.is_dir():
            continue
        for candidate in target.rglob("*"):
            if not candidate.is_file():
                continue
            relative = relative_posix(root, candidate)
            if excluded_source(relative, patterns, workspace_rel, state_rel):
                continue
            if extensions and candidate.suffix.lower() not in extensions:
                continue
            discovered.add(relative)
            if len(discovered) > maximum:
                raise WikiError(f"configured source scan exceeds max_scan_files={maximum}")
    return sorted(discovered)


def is_reserved_markdown(workspace: Path, path: Path) -> bool:
    if path.name.lower() == "index.md":
        return True
    return path.parent == workspace and path.name.lower() == "log.md"


def manifest_page_record(
    pages: dict[str, Any], workspace_relative: str, page_relative: str
) -> tuple[str, dict[str, Any] | None]:
    prefix = workspace_relative.rstrip("/") + "/"
    key = page_relative[len(prefix) :] if page_relative.startswith(prefix) else page_relative
    record = pages.get(key, pages.get(page_relative))
    return key, record if isinstance(record, dict) else None


def compute_status(root: Path) -> dict[str, Any]:
    workspace, state, manifest_path, config_path = workspace_paths(root)
    config = read_json(config_path)
    manifest = read_json(manifest_path)
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise WikiError(f"unsupported manifest schema in {manifest_path}")
    sources = manifest.get("sources", {})
    pages = manifest.get("pages", {})
    if not isinstance(sources, dict) or not isinstance(pages, dict):
        raise WikiError("manifest sources and pages must be objects")

    discovered = discover_configured_sources(root, config)
    registered: dict[str, tuple[str, dict[str, Any]]] = {}
    for source_id, record in sources.items():
        if not isinstance(record, dict):
            continue
        locator = record.get("locator")
        locator_type = record.get("locator_type", "file")
        if locator and locator_type == "file":
            registered[str(locator).replace("\\", "/")] = (str(source_id), record)

    new_sources = [path for path in discovered if path not in registered]
    changed_sources: list[dict[str, str]] = []
    missing_sources: list[dict[str, str]] = []
    for locator, (source_id, record) in sorted(registered.items()):
        path = confined(root, locator)
        if not path.is_file():
            missing_sources.append({"source_id": source_id, "locator": locator})
            continue
        current_hash = sha256_file(path)
        expected = str(record.get("sha256", ""))
        if expected and current_hash != expected:
            changed_sources.append(
                {
                    "source_id": source_id,
                    "locator": locator,
                    "expected_sha256": expected,
                    "actual_sha256": current_hash,
                }
            )

    now = utc_now()
    due_checks: list[dict[str, str]] = []
    expired: list[dict[str, str]] = []
    purge_due: list[dict[str, str]] = []
    structural_issues: list[dict[str, str]] = []
    manifest_drift: list[dict[str, str]] = []
    future_dates: list[dt.datetime] = []
    for source_id, record in sources.items():
        if not isinstance(record, dict):
            structural_issues.append(
                {"path": relative_posix(root, manifest_path), "issue": f"invalid source record {source_id}"}
            )
            continue
        for field, bucket in (
            ("stale_after", due_checks),
            ("valid_until", expired),
            ("purge_after", purge_due),
        ):
            value = record.get(field)
            if field == "stale_after" and value is None:
                value = record.get("check_after")
            try:
                parsed = parse_time(value)
            except WikiError as exc:
                structural_issues.append(
                    {"path": relative_posix(root, manifest_path), "issue": f"source {source_id} {field}: {exc}"}
                )
                continue
            if parsed is None:
                continue
            if parsed <= now:
                bucket.append({"kind": "source", "id": str(source_id), "at": iso_utc(parsed)})
            else:
                future_dates.append(parsed)

    workspace_relative = relative_posix(root, workspace)
    canonical_page_keys: set[str] = set()
    if workspace.is_dir():
        for path in sorted(workspace.rglob("*.md")):
            if is_reserved_markdown(workspace, path):
                continue
            page_relative = relative_posix(root, path)
            page_key, manifest_record = manifest_page_record(
                pages, workspace_relative, page_relative
            )
            canonical_page_keys.add(page_key)
            try:
                fields, _ = read_frontmatter(path)
            except WikiError as exc:
                structural_issues.append({"path": page_relative, "issue": str(exc)})
                continue
            if not fields.get("type"):
                structural_issues.append(
                    {"path": page_relative, "issue": "concept is missing frontmatter type"}
                )
                continue
            if manifest_record is None:
                manifest_drift.append(
                    {"path": page_relative, "issue": "concept is not recorded in manifest"}
                )
            else:
                expected_hash = manifest_record.get("sha256")
                actual_hash = sha256_file(path)
                if not isinstance(expected_hash, str) or expected_hash != actual_hash:
                    manifest_drift.append(
                        {
                            "path": page_relative,
                            "issue": "content hash differs from manifest",
                        }
                    )
            for field, bucket in (
                ("stale_after", due_checks),
                ("valid_until", expired),
                ("purge_after", purge_due),
            ):
                value = fields.get(field)
                try:
                    parsed = parse_time(value)
                except WikiError as exc:
                    structural_issues.append(
                        {"path": page_relative, "issue": f"{field}: {exc}"}
                    )
                    continue
                if parsed is not None:
                    if parsed <= now:
                        bucket.append({"kind": "page", "id": page_key, "at": iso_utc(parsed)})
                    else:
                        future_dates.append(parsed)
                if manifest_record is not None:
                    manifest_value = manifest_record.get(field)
                    if field == "stale_after" and manifest_value is None:
                        manifest_value = manifest_record.get("check_after")
                    try:
                        manifest_parsed = parse_time(manifest_value)
                    except WikiError as exc:
                        structural_issues.append(
                            {
                                "path": relative_posix(root, manifest_path),
                                "issue": f"page {page_key} {field}: {exc}",
                            }
                        )
                        continue
                    if parsed != manifest_parsed:
                        manifest_drift.append(
                            {
                                "path": page_relative,
                                "issue": f"{field} differs from manifest",
                            }
                        )

    for raw_key in pages:
        key = str(raw_key).replace("\\", "/")
        normalized = key[len(workspace_relative) + 1 :] if key.startswith(workspace_relative + "/") else key
        if normalized not in canonical_page_keys:
            manifest_drift.append(
                {
                    "path": f"{workspace_relative}/{normalized}",
                    "issue": "manifest page is missing from the bundle",
                }
            )

    candidates = []
    candidate_root = state / "candidates"
    if candidate_root.is_dir():
        candidates = sorted(
            relative_posix(root, path)
            for path in candidate_root.rglob("*")
            if path.is_file()
        )

    incomplete_runs: list[dict[str, str]] = []
    run_root = state / "runs"
    if run_root.is_dir():
        for path in sorted(run_root.glob("*.json")):
            try:
                record = read_json(path)
            except WikiError:
                incomplete_runs.append({"path": relative_posix(root, path), "status": "invalid"})
                continue
            status = str(record.get("status", "unknown"))
            if status.lower() not in TERMINAL_RUN_STATES:
                incomplete_runs.append({"path": relative_posix(root, path), "status": status})

    reasons = {
        "new_sources": new_sources,
        "changed_sources": changed_sources,
        "missing_sources": missing_sources,
        "due_checks": due_checks,
        "expired": expired,
        "purge_due": purge_due,
        "candidates": candidates,
        "incomplete_runs": incomplete_runs,
        "structural_issues": structural_issues,
        "manifest_drift": manifest_drift,
    }
    needs_dream = any(bool(value) for value in reasons.values())
    return {
        "schema": "llm-wiki.status.v1",
        "generated_at": iso_utc(now),
        "workspace": relative_posix(root, workspace),
        "needs_dream": needs_dream,
        "next_due_at": iso_utc(min(future_dates)) if future_dates else None,
        **reasons,
    }


def virtual_file(root: Path, overlay: Path | None, relative: str) -> Path:
    if overlay is not None:
        candidate = overlay / Path(relative)
        if candidate.is_file():
            return candidate
    return confined(root, relative)


def iter_compiled_pages(root: Path, workspace: Path, overlay: Path | None) -> dict[str, Path]:
    pages: dict[str, Path] = {}
    if workspace.is_dir():
        for path in workspace.rglob("*.md"):
            if not is_reserved_markdown(workspace, path):
                pages[relative_posix(root, path)] = path
    if overlay is not None:
        staged = overlay / relative_posix(root, workspace)
        if staged.is_dir():
            for path in staged.rglob("*.md"):
                canonical = workspace / path.relative_to(staged)
                if not is_reserved_markdown(workspace, canonical):
                    relative = path.relative_to(overlay).as_posix()
                    pages[relative] = path
    return pages


def lint_workspace(
    root: Path, selected_paths: list[str] | None = None, overlay: Path | None = None
) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    try:
        workspace, state, manifest_path, config_path = workspace_paths(root)
        config = read_json(virtual_file(root, overlay, relative_posix(root, config_path)))
        manifest = read_json(virtual_file(root, overlay, relative_posix(root, manifest_path)))
    except WikiError as exc:
        add_finding(findings, "error", "WORKSPACE_INVALID", ".", str(exc))
        return {"schema": "llm-wiki.lint.v1", "findings": findings, "summary": summarize(findings)}

    if config.get("schema") not in {CONFIG_SCHEMA, LEGACY_CONFIG_SCHEMA}:
        add_finding(
            findings,
            "error",
            "CONFIG_SCHEMA",
            relative_posix(root, config_path),
            f"expected schema {CONFIG_SCHEMA}",
        )
    if config.get("schema") == LEGACY_CONFIG_SCHEMA:
        add_finding(
            findings,
            "warning",
            "OKF_MIGRATION_REQUIRED",
            relative_posix(root, config_path),
            "legacy workspace should be migrated to the OKF v0.2 profile",
        )
    knowledge_format = config.get("knowledge_format")
    if config.get("schema") == CONFIG_SCHEMA and knowledge_format != {
        "name": "okf",
        "version": "0.2",
        "profile": "workagent3-wiki-v1",
    }:
        add_finding(
            findings,
            "error",
            "OKF_PROFILE_INVALID",
            relative_posix(root, config_path),
            "knowledge_format must select OKF 0.2 and workagent3-wiki-v1",
        )
    if config.get("schema") == CONFIG_SCHEMA:
        state_retention = config.get("state_retention")
        if not isinstance(state_retention, dict):
            add_finding(
                findings,
                "error",
                "STATE_RETENTION_INVALID",
                relative_posix(root, config_path),
                "state_retention must be an object",
            )
        else:
            for field in (
                "completed_runs_days",
                "preimages_days",
                "lint_reports_days",
            ):
                value = state_retention.get(field)
                if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                    add_finding(
                        findings,
                        "error",
                        "STATE_RETENTION_INVALID",
                        relative_posix(root, config_path),
                        f"state_retention.{field} must be a positive integer",
                    )
    maximum = config.get("max_scan_files", 5000)
    if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum <= 0:
        add_finding(
            findings,
            "error",
            "CONFIG_MAX_SCAN_FILES_INVALID",
            relative_posix(root, config_path),
            "max_scan_files must be a positive integer",
        )
    for field in ("source_roots", "source_extensions", "exclude"):
        value = config.get(field, [])
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            add_finding(
                findings,
                "error",
                "CONFIG_LIST_INVALID",
                relative_posix(root, config_path),
                f"{field} must be a list of strings",
            )
    dream_config = config.get("dream")
    if not isinstance(dream_config, dict):
        add_finding(
            findings,
            "error",
            "CONFIG_DREAM_TYPE",
            relative_posix(root, config_path),
            "dream must be an object",
        )
    else:
        if dream_config.get("model") != DREAM_MODEL:
            add_finding(
                findings,
                "error",
                "DREAM_MODEL_INVALID",
                relative_posix(root, config_path),
                f"dream.model must be {DREAM_MODEL}",
            )
        if dream_config.get("reasoning_effort") != DREAM_REASONING_EFFORT:
            add_finding(
                findings,
                "error",
                "DREAM_REASONING_INVALID",
                relative_posix(root, config_path),
                f"dream.reasoning_effort must be {DREAM_REASONING_EFFORT}",
            )
        weekly_deep_day = dream_config.get("weekly_deep_day")
        if weekly_deep_day is None:
            add_finding(
                findings,
                "warning",
                "WEEKLY_DEEP_DAY_MISSING",
                relative_posix(root, config_path),
                "dream.weekly_deep_day is missing; scheduler fallback is SUN",
            )
        elif weekly_deep_day not in ALLOWED_WEEKDAYS:
            add_finding(
                findings,
                "error",
                "WEEKLY_DEEP_DAY_INVALID",
                relative_posix(root, config_path),
                "dream.weekly_deep_day must be MON, TUE, WED, THU, FRI, SAT, or SUN",
            )
    if manifest.get("schema") != MANIFEST_SCHEMA:
        add_finding(
            findings,
            "error",
            "MANIFEST_SCHEMA",
            relative_posix(root, manifest_path),
            f"expected schema {MANIFEST_SCHEMA}",
        )

    agents_path = virtual_file(root, overlay, "AGENTS.md")
    if not agents_path.is_file():
        add_finding(findings, "error", "AGENTS_MISSING", "AGENTS.md", "AGENTS.md is missing")
    else:
        agents = agents_path.read_text(encoding="utf-8")
        if agents.count(START_MARKER) != 1 or agents.count(END_MARKER) != 1:
            add_finding(
                findings,
                "error",
                "AGENTS_MARKERS",
                "AGENTS.md",
                "expected exactly one balanced llm-wiki managed block",
            )

    required_files = ("index.md", "log.md", "contract.md", "config.json")
    for name in required_files:
        relative = f"{relative_posix(root, workspace)}/{name}"
        if not virtual_file(root, overlay, relative).is_file():
            add_finding(findings, "error", "REQUIRED_FILE_MISSING", relative, "required file missing")

    pages = iter_compiled_pages(root, workspace, overlay)
    selected: set[str] | None = None
    if selected_paths:
        selected = set()
        for item in selected_paths:
            path = confined(root, item)
            selected.add(relative_posix(root, path))
            staged = virtual_file(root, overlay, relative_posix(root, path))
            if staged.is_file() and staged.suffix.lower() == ".md":
                pages[relative_posix(root, path)] = staged

    sources = manifest.get("sources", {})
    manifest_pages = manifest.get("pages", {})
    if not isinstance(sources, dict):
        add_finding(findings, "error", "MANIFEST_SOURCES_TYPE", relative_posix(root, manifest_path), "sources must be an object")
        sources = {}
    if not isinstance(manifest_pages, dict):
        add_finding(findings, "error", "MANIFEST_PAGES_TYPE", relative_posix(root, manifest_path), "pages must be an object")
        manifest_pages = {}

    active_pages: set[str] = set()
    for relative, path in sorted(pages.items()):
        if selected is not None and relative not in selected:
            continue
        try:
            fields, text = read_frontmatter(path)
        except WikiError as exc:
            add_finding(findings, "error", "FRONTMATTER_INVALID", relative, str(exc))
            continue
        missing = [field for field in REQUIRED_PAGE_FIELDS if field not in fields]
        if missing:
            add_finding(
                findings,
                "error",
                "FRONTMATTER_REQUIRED",
                relative,
                "missing required frontmatter fields",
                evidence=missing,
            )
        status = fields.get("status")
        if status not in ALLOWED_OKF_STATUSES:
            add_finding(
                findings,
                "error",
                "OKF_STATUS_INVALID",
                relative,
                f"invalid OKF status: {status}",
            )
        knowledge_state = fields.get("knowledge_state")
        if knowledge_state not in ALLOWED_KNOWLEDGE_STATES:
            add_finding(
                findings,
                "error",
                "KNOWLEDGE_STATE_INVALID",
                relative,
                f"invalid knowledge_state: {knowledge_state}",
            )
        if knowledge_state in {"active", "review_due", "contested"} and status != "deprecated":
            active_pages.add(relative)
        generated = fields.get("generated")
        if not isinstance(generated, dict) or not generated.get("by"):
            add_finding(findings, "error", "OKF_GENERATED_INVALID", relative, "generated.by is required by this profile")
        elif generated.get("at") is not None:
            try:
                parse_time(generated["at"])
            except WikiError as exc:
                add_finding(findings, "error", "DATE_INVALID", relative, f"generated.at: {exc}")
        verified = fields.get("verified")
        if verified is not None:
            verification_entries = verified if isinstance(verified, list) else [verified]
            for entry in verification_entries:
                if not isinstance(entry, dict) or not entry.get("by"):
                    add_finding(findings, "error", "OKF_VERIFIED_INVALID", relative, "verified entries require by")
                    continue
                if entry.get("at") is not None:
                    try:
                        parse_time(entry["at"])
                    except WikiError as exc:
                        add_finding(findings, "error", "DATE_INVALID", relative, f"verified.at: {exc}")
        for field in ("stale_after", "valid_until", "purge_after"):
            if field not in fields or fields.get(field) is None:
                continue
            try:
                parse_time(fields[field])
            except WikiError as exc:
                add_finding(findings, "error", "DATE_INVALID", relative, f"{field}: {exc}")

        manifest_key = relative
        workspace_prefix = relative_posix(root, workspace) + "/"
        if relative.startswith(workspace_prefix):
            manifest_key = relative[len(workspace_prefix) :]
        manifest_present = manifest_key in manifest_pages or relative in manifest_pages
        manifest_record = manifest_pages.get(
            manifest_key, manifest_pages.get(relative, {})
        )
        if manifest_present and not isinstance(manifest_record, dict):
            add_finding(
                findings,
                "error",
                "MANIFEST_PAGE_RECORD_TYPE",
                relative_posix(root, manifest_path),
                f"manifest record for {manifest_key} must be an object",
            )
            manifest_record = {}
        if manifest_present:
            expected_hash = manifest_record.get("sha256")
            if not isinstance(expected_hash, str) or expected_hash != sha256_file(path):
                add_finding(
                    findings,
                    "error",
                    "MANIFEST_PAGE_HASH_DRIFT",
                    relative,
                    "concept content hash differs from the manifest cache",
                )
            for field in ("stale_after", "valid_until", "purge_after"):
                try:
                    page_deadline = parse_time(fields.get(field))
                    manifest_deadline = parse_time(manifest_record.get(field))
                except WikiError:
                    continue
                if page_deadline != manifest_deadline:
                    add_finding(
                        findings,
                        "error",
                        "MANIFEST_DEADLINE_DRIFT",
                        relative,
                        f"frontmatter {field} differs from the manifest cache",
                    )
        purge_after = fields.get("purge_after")
        if purge_after is not None and not (
            isinstance(manifest_record, dict) and manifest_record.get("purge_eligible") is True
        ):
            add_finding(
                findings,
                "error",
                "PURGE_NOT_ELIGIBLE",
                relative,
                "purge_after requires manifest purge_eligible=true",
            )

        source_entries = fields.get("sources")
        if source_entries is None:
            source_entries = []
        if not isinstance(source_entries, list):
            add_finding(findings, "error", "OKF_SOURCES_TYPE", relative, "sources must be a list")
            source_entries = []
        for source_entry in source_entries:
            if not isinstance(source_entry, dict) or not source_entry.get("resource"):
                add_finding(findings, "error", "OKF_SOURCE_RESOURCE", relative, "each sources entry requires resource")
                continue
            source_id = source_entry.get("id")
            if source_id is None:
                continue
            if source_id not in sources:
                add_finding(
                    findings,
                    "error",
                    "SOURCE_ID_UNKNOWN",
                    relative,
                    f"unknown source ID: {source_id}",
                )

        if fields.get("type") == "Attested Computation":
            for field in ("runtime", "parameters", "executor", "attester"):
                if fields.get(field) in (None, "", []):
                    add_finding(
                        findings,
                        "error",
                        "OKF_ATTESTED_FIELD_REQUIRED",
                        relative,
                        f"Attested Computation requires {field}",
                    )
            if fields.get("computation") in (None, "") and not re.search(
                r"^#\s+Computation\s*$", text, re.MULTILINE
            ):
                add_finding(
                    findings,
                    "error",
                    "OKF_ATTESTED_FIELD_REQUIRED",
                    relative,
                    "Attested Computation requires computation metadata or a Computation section",
                )

        for raw in MARKDOWN_LINK_RE.findall(text):
            destination = extract_link_destination(raw)
            if destination is None:
                continue
            if ".agent-state/" in destination.replace("\\", "/"):
                add_finding(
                    findings,
                    "error",
                    "STATE_LINKED_AS_KNOWLEDGE",
                    relative,
                    f"Wiki page links into machine state: {destination}",
                )
                continue
            target = (
                workspace / destination.lstrip("/")
                if destination.startswith("/")
                else confined(root, relative).parent / destination
            ).resolve(strict=False)
            try:
                target_relative = relative_posix(root, target)
            except ValueError:
                add_finding(
                    findings,
                    "warning",
                    "LINK_ESCAPES_PROJECT",
                    relative,
                    f"link escapes project root: {destination}",
                )
                continue
            if not virtual_file(root, overlay, target_relative).exists():
                add_finding(
                    findings,
                    "warning",
                    "LINK_BROKEN",
                    relative,
                    f"missing link target: {destination}",
                )

        if not manifest_present:
            add_finding(
                findings,
                "error"
                if knowledge_state in {"active", "review_due", "contested"}
                and status != "deprecated"
                else "warning",
                "PAGE_NOT_IN_MANIFEST",
                relative,
                "concept is not recorded in manifest",
            )

    index_relative = f"{relative_posix(root, workspace)}/index.md"
    index_path = virtual_file(root, overlay, index_relative)
    index_targets: set[str] = set()
    index_fields: dict[str, Any] = {}
    if index_path.is_file():
        try:
            index_fields, index_text = read_frontmatter(index_path)
        except WikiError as exc:
            add_finding(
                findings, "error", "FRONTMATTER_INVALID", index_relative, str(exc)
            )
        else:
            for raw in MARKDOWN_LINK_RE.findall(index_text):
                destination = extract_link_destination(raw)
                if destination is None:
                    continue
                target = (
                    workspace / destination.lstrip("/")
                    if destination.startswith("/")
                    else confined(root, index_relative).parent / destination
                ).resolve(strict=False)
                try:
                    index_targets.add(relative_posix(root, target))
                except ValueError:
                    continue
    for relative in sorted(active_pages):
        if relative not in index_targets:
            add_finding(
                findings,
                "warning",
                "INDEX_MISSING_PAGE",
                relative,
                "current concept is not directly listed in index.md",
            )

    if index_path.is_file():
        if str(index_fields.get("okf_version")) != "0.2":
            add_finding(findings, "error", "OKF_VERSION_MISSING", index_relative, "root index.md must declare okf_version 0.2")
    log_relative = f"{relative_posix(root, workspace)}/log.md"
    log_path = virtual_file(root, overlay, log_relative)
    if log_path.is_file():
        log_text = log_path.read_text(encoding="utf-8")
        for heading in re.findall(r"^##\s+(.+?)\s*$", log_text, re.MULTILINE):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", heading):
                add_finding(findings, "error", "OKF_LOG_DATE_INVALID", log_relative, f"log date heading must be YYYY-MM-DD: {heading}")

    for key in manifest_pages:
        key_text = str(key).replace("\\", "/")
        relative = key_text if key_text.startswith(relative_posix(root, workspace) + "/") else f"{relative_posix(root, workspace)}/{key_text}"
        if not virtual_file(root, overlay, relative).is_file():
            add_finding(
                findings,
                "error",
                "MANIFEST_PAGE_MISSING",
                relative,
                "manifest references a missing page",
            )

    hashes: dict[str, str] = {}
    for source_id, record in sources.items():
        if not isinstance(record, dict):
            add_finding(
                findings,
                "error",
                "SOURCE_RECORD_TYPE",
                relative_posix(root, manifest_path),
                f"source {source_id} must be an object",
            )
            continue
        source_hash = record.get("sha256")
        if source_hash:
            if source_hash in hashes:
                add_finding(
                    findings,
                    "warning",
                    "SOURCE_HASH_DUPLICATE",
                    relative_posix(root, manifest_path),
                    f"sources {hashes[source_hash]} and {source_id} share a content hash",
                )
            hashes[str(source_hash)] = str(source_id)
        if record.get("locator_type", "file") == "file" and record.get("locator"):
            locator = str(record["locator"])
            source_path = confined(root, locator)
            if source_path.is_file() and source_hash:
                actual = sha256_file(source_path)
                if actual != source_hash:
                    add_finding(
                        findings,
                        "warning",
                        "SOURCE_CHANGED",
                        locator,
                        f"source hash differs from manifest record {source_id}",
                    )

    return {
        "schema": "llm-wiki.lint.v1",
        "generated_at": iso_utc(),
        "scope": sorted(selected) if selected is not None else "full",
        "findings": findings,
        "summary": summarize(findings),
    }


def summarize(findings: list[dict[str, Any]]) -> dict[str, int]:
    result = {"error": 0, "warning": 0, "info": 0}
    for finding in findings:
        severity = finding.get("severity")
        if severity in result:
            result[severity] += 1
    return result


def snapshot(root: Path, run_id: str, paths: list[str]) -> dict[str, Any]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise WikiError("run ID must be 1-128 safe filename characters")
    _, state, _, _ = workspace_paths(root)
    destination = state / "preimages" / run_id
    destination.mkdir(parents=True, exist_ok=True)
    records: dict[str, Any] = {}
    for item in sorted(set(paths)):
        source = confined(root, item)
        relative = relative_posix(root, source)
        target = destination / Path(relative)
        if source.is_file():
            digest = sha256_file(source)
            if target.exists() and sha256_file(target) != digest:
                raise WikiError(f"preimage already exists with different content: {relative}")
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copy2(source, target)
            records[relative] = {"sha256": digest, "exists": True}
        elif source.exists():
            raise WikiError(f"snapshot target is not a file: {relative}")
        else:
            records[relative] = {"sha256": None, "exists": False}
    descriptor = destination / "snapshot.json"
    existing = read_json(descriptor, required=False)
    merged = dict(existing.get("paths", {})) if existing else {}
    merged.update(records)
    atomic_write_json(
        descriptor,
        {
            "schema": "llm-wiki.preimage.v1",
            "run_id": run_id,
            "captured_at": existing.get("captured_at", iso_utc()) if existing else iso_utc(),
            "paths": merged,
        },
    )
    return {
        "run_id": run_id,
        "snapshot": relative_posix(root, descriptor),
        "paths": records,
    }


def acquire_lock(root: Path, run_id: str, ttl_minutes: int, break_stale: bool) -> dict[str, Any]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise WikiError("run ID must be 1-128 safe filename characters")
    _, state, _, _ = workspace_paths(root)
    state.mkdir(parents=True, exist_ok=True)
    lock_path = state / "lock.json"
    now = utc_now()
    value = {
        "schema": "llm-wiki.lock.v1",
        "run_id": run_id,
        "pid": os.getpid(),
        "acquired_at": iso_utc(now),
        "expires_at": iso_utc(now + dt.timedelta(minutes=ttl_minutes)),
    }
    for _ in range(2):
        try:
            descriptor = os.open(str(lock_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        except FileExistsError:
            existing = read_json(lock_path)
            expired = bool(parse_time(existing.get("expires_at")) and parse_time(existing.get("expires_at")) <= now)
            if break_stale and expired:
                lock_path.unlink()
                continue
            raise WikiError(
                f"workspace is locked by run {existing.get('run_id', 'unknown')}"
                + (" (expired; use --break-stale to replace)" if expired else "")
            )
        else:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(value, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            return {"acquired": True, "lock": relative_posix(root, lock_path), **value}
    raise WikiError("failed to acquire workspace lock")


def release_lock(root: Path, run_id: str) -> dict[str, Any]:
    _, state, _, _ = workspace_paths(root)
    lock_path = state / "lock.json"
    if not lock_path.exists():
        return {"released": False, "already_free": True}
    existing = read_json(lock_path)
    if existing.get("run_id") != run_id:
        raise WikiError(f"lock belongs to run {existing.get('run_id', 'unknown')}, not {run_id}")
    lock_path.unlink()
    return {"released": True, "run_id": run_id}


def is_reparse_point(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise WikiError(f"cannot inspect cleanup target {path}: {exc}") from exc
    return path.is_symlink() or bool(
        getattr(metadata, "st_file_attributes", 0) & REPARSE_POINT_ATTRIBUTE
    )


def validate_cleanup_target(state: Path, target: Path, *, tree: bool) -> None:
    try:
        target.relative_to(state)
    except ValueError as exc:
        raise WikiError(f"cleanup target escapes machine state: {target}") from exc
    if target == state:
        raise WikiError("refusing to delete the machine-state root")

    cursor = target
    while True:
        if cursor.exists() and is_reparse_point(cursor):
            raise WikiError(f"cleanup target crosses a reparse point: {cursor}")
        if cursor == state:
            break
        cursor = cursor.parent

    if tree and target.is_dir():
        for directory, dirnames, filenames in os.walk(
            target, topdown=True, followlinks=False
        ):
            current = Path(directory)
            for name in [*dirnames, *filenames]:
                child = current / name
                if is_reparse_point(child):
                    raise WikiError(f"cleanup tree contains a reparse point: {child}")


def cleanup_state(root: Path, apply: bool) -> dict[str, Any]:
    _, state, _, config_path = workspace_paths(root)
    config = read_json(config_path)
    retention = config.get("state_retention")
    if not isinstance(retention, dict):
        raise WikiError("config state_retention must be an object")

    values: dict[str, int] = {}
    for field in ("completed_runs_days", "preimages_days", "lint_reports_days"):
        value = retention.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise WikiError(f"config state_retention.{field} must be a positive integer")
        values[field] = value

    now = utc_now()

    def older_than(path: Path, days: int) -> bool:
        try:
            modified = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc)
        except OSError as exc:
            raise WikiError(f"cannot inspect cleanup age for {path}: {exc}") from exc
        return modified <= now - dt.timedelta(days=days)

    actions: list[dict[str, str]] = []
    incomplete_run_ids: set[str] = set()
    runs = state / "runs"
    if runs.is_dir():
        validate_cleanup_target(state, runs, tree=True)
        for path in sorted(runs.glob("*.json")):
            try:
                record = read_json(path)
            except WikiError:
                incomplete_run_ids.add(path.stem)
                continue
            run_state = str(record.get("status", record.get("state", ""))).lower()
            if run_state not in TERMINAL_RUN_STATES:
                incomplete_run_ids.add(path.stem)
                continue
            if older_than(path, values["completed_runs_days"]):
                actions.append(
                    {
                        "action": "delete-file",
                        "path": relative_posix(root, path),
                        "reason": "completed run record exceeded retention",
                    }
                )

    preimages = state / "preimages"
    if preimages.is_dir():
        validate_cleanup_target(state, preimages, tree=True)
        for path in sorted(preimages.iterdir()):
            if path.name in incomplete_run_ids or not path.is_dir():
                continue
            if older_than(path, values["preimages_days"]):
                actions.append(
                    {
                        "action": "delete-tree",
                        "path": relative_posix(root, path),
                        "reason": "recoverable preimage exceeded retention",
                    }
                )

    lint_root = state / "lint"
    if lint_root.is_dir():
        validate_cleanup_target(state, lint_root, tree=True)
        for path in sorted(item for item in lint_root.rglob("*") if item.is_file()):
            if older_than(path, values["lint_reports_days"]):
                actions.append(
                    {
                        "action": "delete-file",
                        "path": relative_posix(root, path),
                        "reason": "lint report exceeded retention",
                    }
                )

    actions.sort(key=lambda item: (item["path"], item["action"]))
    if apply:
        for item in actions:
            target = confined(root, item["path"])
            validate_cleanup_target(state, target, tree=item["action"] == "delete-tree")
        for item in actions:
            target = confined(root, item["path"])
            if item["action"] == "delete-tree":
                shutil.rmtree(target)
            else:
                target.unlink()

    return {
        "schema": "llm-wiki.cleanup.v1",
        "applied": apply,
        "actions": actions,
        "summary": {"delete_count": len(actions)},
    }


def emit(value: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, indent=2, ensure_ascii=False))
        return
    if "summary" in value and "findings" in value:
        summary = value["summary"]
        print(
            f"errors={summary.get('error', 0)} warnings={summary.get('warning', 0)} "
            f"info={summary.get('info', 0)}"
        )
        for finding in value["findings"]:
            print(
                f"{finding['severity'].upper()} {finding['code']} "
                f"{finding['path']}: {finding['message']}"
            )
        return
    print(json.dumps(value, indent=2, ensure_ascii=False))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="Preview or initialize a workspace")
    init.add_argument("--root", required=True)
    init.add_argument("--apply", action="store_true")
    init.add_argument("--json", action="store_true")

    status = commands.add_parser("status", help="Compute source and deadline work")
    status.add_argument("--root", required=True)
    status.add_argument("--json", action="store_true")

    lint = commands.add_parser("lint", help="Run deterministic structural lint")
    lint.add_argument("--root", required=True)
    lint.add_argument("--paths", nargs="+", default=[])
    lint.add_argument("--overlay-dir")
    lint.add_argument("--json", action="store_true")

    preimage = commands.add_parser("snapshot", help="Capture recoverable preimages")
    preimage.add_argument("--root", required=True)
    preimage.add_argument("--run-id", required=True)
    preimage.add_argument("--paths", nargs="+", required=True)
    preimage.add_argument("--json", action="store_true")

    lock = commands.add_parser("lock", help="Acquire or release a project lease")
    lock_commands = lock.add_subparsers(dest="lock_action", required=True)
    acquire = lock_commands.add_parser("acquire")
    acquire.add_argument("--root", required=True)
    acquire.add_argument("--run-id", required=True)
    acquire.add_argument("--ttl-minutes", type=int, default=120)
    acquire.add_argument("--break-stale", action="store_true")
    acquire.add_argument("--json", action="store_true")
    release = lock_commands.add_parser("release")
    release.add_argument("--root", required=True)
    release.add_argument("--run-id", required=True)
    release.add_argument("--json", action="store_true")

    cleanup = commands.add_parser(
        "cleanup-state", help="Preview or apply machine-state retention"
    )
    cleanup.add_argument("--root", required=True)
    cleanup.add_argument("--apply", action="store_true")
    cleanup.add_argument("--json", action="store_true")

    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        root = project_root(args.root)
        if args.command == "init":
            result = init_workspace(root, args.apply)
        elif args.command == "status":
            result = compute_status(root)
        elif args.command == "lint":
            overlay = None
            if args.overlay_dir:
                overlay_candidate = Path(args.overlay_dir)
                if overlay_candidate.is_absolute():
                    resolved = overlay_candidate.resolve()
                    try:
                        common = Path(os.path.commonpath((str(root), str(resolved))))
                    except ValueError as exc:
                        raise WikiError(
                            "overlay directory must stay inside project root"
                        ) from exc
                    if common != root:
                        raise WikiError("overlay directory must stay inside project root")
                    overlay = resolved
                else:
                    overlay = confined(root, overlay_candidate)
                if not overlay.is_dir():
                    raise WikiError(f"overlay directory does not exist: {overlay}")
            result = lint_workspace(root, args.paths, overlay)
        elif args.command == "snapshot":
            result = snapshot(root, args.run_id, args.paths)
        elif args.command == "lock" and args.lock_action == "acquire":
            if args.ttl_minutes <= 0:
                raise WikiError("ttl-minutes must be positive")
            result = acquire_lock(root, args.run_id, args.ttl_minutes, args.break_stale)
        elif args.command == "lock" and args.lock_action == "release":
            result = release_lock(root, args.run_id)
        elif args.command == "cleanup-state":
            result = cleanup_state(root, args.apply)
        else:
            raise WikiError("unsupported command")
        emit(result, args.json)
        if args.command == "lint" and result["summary"]["error"]:
            return 1
        return 0
    except (WikiError, OSError) as exc:
        error = {"error": str(exc), "command": args.command}
        emit(error, getattr(args, "json", False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
