"""Read-only, approved skill disclosure over the trusted registration plane.

This is deliberately smaller than native skill activation: no supporting-file
arguments, template preprocessing, dependency setup, or ambient skill exposure.
The host owns grant/scope/lineage validation before and after this call.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
from typing import Any

from .neurobro_bridge import Bridge, HERMES_PIN

MAX_READ_BYTES = 256 * 1024
PROTOCOL_VERSION = 1
_DESCRIPTOR_FIELDS = {"id", "nativeName", "sha256", "ownerId", "accountId", "scope", "sourceRefs", "state"}
_PINNED_BLOBS = {
    "tools/skills_tool.py": "2cff382992920bb7a6e65dc2e7473409229fd7c2",
    "tools/skills_tool_setup.py": "17d6dcf6ac37325e8499c5dbb25099fb7011a351",
    "tools/skills_tool_plugin.py": "f37f60cffeae53a9b2703864f6469389ec4165e6",
    "tools/skills_tool_dedup.py": "71de7d1ef1c04db04921ebc3377401ffc0a67908",
    "agent/skill_utils.py": "8f8b115bc0ea645e977ca925affffa9dda8c0361",
}


class CognitionError(ValueError):
    """Typed, credential/path-free failure returned by the management plane."""


def _string(value: Any, limit: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > limit or re.search(r"[\x00-\x1f\x7f]", value):
        raise CognitionError("cognition_invalid_request")
    return value


def descriptor(value: Any) -> dict:
    if not isinstance(value, dict) or set(value) != _DESCRIPTOR_FIELDS:
        raise CognitionError("cognition_invalid_descriptor")
    for field in ("id", "nativeName", "ownerId", "accountId", "scope"):
        _string(value[field])
    if value["state"] != "approved" or not isinstance(value["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["sha256"]):
        raise CognitionError("cognition_skill_not_approved")
    if not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*", value["nativeName"]):
        raise CognitionError("cognition_native_name_invalid")
    if value["scope"] != "global" and not re.fullmatch(r"(?:chat|task):[^\s:]+", value["scope"]):
        raise CognitionError("cognition_scope_invalid")
    refs = value["sourceRefs"]
    if not isinstance(refs, list) or len(refs) > 32 or len(set(_string(ref, 2048) for ref in refs)) != len(refs):
        raise CognitionError("cognition_lineage_invalid")
    return {**value, "sourceRefs": list(refs)}


def _frontmatter(text: str) -> dict[str, str]:
    """A strict scalar-only YAML subset; other activation metadata is denied."""
    text = text.removeprefix("\ufeff").replace("\r\n", "\n")
    if not text.startswith("---\n"):
        raise CognitionError("cognition_frontmatter_invalid")
    end = text.find("\n---\n", 4)
    if end < 0 or end > 16384:
        raise CognitionError("cognition_frontmatter_invalid")
    result: dict[str, str] = {}
    for line in text[4:end].split("\n"):
        if not line.strip():
            continue
        match = re.fullmatch(r"(name|description):[ ]*(.+)", line)
        if not match or match[1] in result:
            raise CognitionError("cognition_activation_metadata_denied")
        value = match[2]
        if value.startswith('"'):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                raise CognitionError("cognition_frontmatter_invalid") from None
        elif value.startswith("'"):
            if not value.endswith("'") or re.search(r"(?<!')'(?!')", value[1:-1]):
                raise CognitionError("cognition_frontmatter_invalid")
            value = value[1:-1].replace("''", "'")
        elif re.search(r"[:#\[\]{}&*!|>'\"%`]|^(?:true|false|null|yes|no|on|off|[-?])$", value, re.I):
            raise CognitionError("cognition_frontmatter_invalid")
        result[match[1]] = _string(value, 1024 if match[1] == "description" else 180)
    if set(result) != {"name", "description"}:
        raise CognitionError("cognition_frontmatter_invalid")
    return result


def _fenced_path(path: Path) -> Path:
    """Reject symlinks/junctions and multiply-linked files in every component."""
    absolute = Path(os.path.abspath(path))
    for current in [*reversed(absolute.parents), absolute]:
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise CognitionError("cognition_path_link_denied")
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise CognitionError("cognition_path_link_denied")
    if absolute.resolve(strict=True) != absolute:
        raise CognitionError("cognition_path_mismatch")
    return absolute


def _read(path: Path, remaining: int) -> tuple[bytes, tuple]:
    path = _fenced_path(path)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > remaining:
            raise CognitionError("cognition_read_limit_or_file_invalid")
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, min(65536, remaining - total + 1))
            if not chunk:
                break
            chunks.append(chunk); total += len(chunk)
            if total > remaining:
                raise CognitionError("cognition_read_limit_or_file_invalid")
        after = os.fstat(fd)
        identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        if identity != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise CognitionError("cognition_skill_changed")
    finally:
        os.close(fd)
    _fenced_path(path)
    final = path.stat()
    if identity != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns):
        raise CognitionError("cognition_skill_changed")
    return b"".join(chunks), identity


class NativeSkills:
    def __init__(self, *, bridge: Bridge, skills_root: str | Path, native: Any):
        self.bridge, self.native = bridge, native
        self.root = _fenced_path(Path(skills_root))
        if not self.root.is_dir():
            raise CognitionError("cognition_root_invalid")

    @classmethod
    def load(cls, *, bridge: Bridge, skills_root: str | Path):
        spec = importlib.util.find_spec("tools.skills_tool")
        if spec is None or not spec.origin:
            raise CognitionError("cognition_native_unavailable")
        source = _fenced_path(Path(spec.origin))
        checkout = source.parents[1]
        for relative, expected in _PINNED_BLOBS.items():
            raw = _fenced_path(checkout / relative).read_bytes()
            if hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() != expected:
                raise CognitionError("cognition_native_pin_mismatch")
        native = importlib.import_module("tools.skills_tool")
        if Path(native.__file__).resolve(strict=True) != source:
            raise CognitionError("cognition_native_pin_mismatch")
        return cls(bridge=bridge, skills_root=skills_root, native=native)

    def _roots(self):
        roots, active = self.native._skill_search_dirs()
        if _fenced_path(Path(active)) != self.root or not roots or any(_fenced_path(Path(path)) != self.root for _tier, path in roots):
            raise CognitionError("cognition_native_roots_not_isolated")
        return roots

    def _catalog(self):
        # Native listing reads every discoverable SKILL.md; bound and preflight
        # that set before it enters any native metadata/environment gate.
        # Reserve half of the total direct-byte budget for the mandatory
        # after-call verification. Stock handlers can reread the same bounded
        # native catalog; this is not a claim about their internal I/O count.
        files, entries, remaining = {}, 0, MAX_READ_BYTES // 2
        for directory, dirs, names in os.walk(self.root, followlinks=False):
            entries += len(dirs) + len(names)
            if entries > 4096:
                raise CognitionError("cognition_catalog_limit")
            for name in dirs + names:
                _fenced_path(Path(directory) / name)
            for name in names:
                path = Path(directory) / name
                support = any(parent != self.root and parent.is_relative_to(self.root) and (parent / "SKILL.md").is_file()
                              for parent in path.parents if parent != path.parent)
                if name == "SKILL.md" and not support:
                    raw, identity = _read(path, remaining); remaining -= len(raw)
                    try:
                        content = raw.decode("utf-8", errors="strict")
                    except UnicodeError:
                        raise CognitionError("cognition_skill_utf8_invalid") from None
                    normalized = content.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
                    files[path] = (raw, identity, None, content, normalized)
                elif name.lower().endswith(".md") and not support and not (Path(directory) / "SKILL.md").is_file():
                    raise CognitionError("cognition_legacy_catalog_denied")
        return files

    def read(self, body: Any) -> dict:
        if not isinstance(body, dict) or set(body) not in ({"session_id", "operation", "descriptors"}, {"session_id", "operation", "descriptors", "skill_id"}):
            raise CognitionError("cognition_invalid_request")
        session, operation = _string(body["session_id"], 8192), body["operation"]
        if operation not in ("list", "view") or (operation == "view") != ("skill_id" in body):
            raise CognitionError("cognition_invalid_request")
        if not isinstance(body["descriptors"], list) or len(body["descriptors"]) > 64:
            raise CognitionError("cognition_invalid_request")
        allowed = [descriptor(value) for value in body["descriptors"]]
        if len({item["id"] for item in allowed}) != len(allowed) or len({item["nativeName"] for item in allowed}) != len(allowed):
            raise CognitionError("cognition_duplicate_descriptor")
        selected = next((item for item in allowed if item["id"] == body.get("skill_id")), None)
        if operation == "view" and selected is None:
            raise CognitionError("cognition_skill_not_approved")
        # The original registered admission identity survives compaction. No
        # credential is read or returned by this guard.
        with self.bridge.registered_session(session):
            if operation == "list" and not allowed:
                return {"ok": True, "value": {"skills": []}}
            roots, catalog = self._roots(), self._catalog()
            approved = {}
            for item in allowed:
                path = self.root.joinpath(*item["nativeName"].split("/"), "SKILL.md")
                data = catalog.get(path)
                if data is None or hashlib.sha256(data[0]).hexdigest() != item["sha256"]:
                    raise CognitionError("cognition_skill_hash_mismatch")
                metadata = _frontmatter(data[3])
                if self.native._safe_frontmatter(content=data[4]) != metadata:
                    raise CognitionError("cognition_native_metadata_mismatch")
                data = (data[0], data[1], metadata, data[3], data[4])
                error, skill_dir, located = self.native._locate_skill(item["nativeName"], None, roots)
                if error is not None or Path(located) != path or Path(skill_dir) != path.parent:
                    raise CognitionError("cognition_native_resolution_mismatch")
                approved[item["id"]] = (item, path, data)
            if operation == "list":
                result = self._result(self.native.skills_list(task_id=session))
                rows = result.get("skills")
                if not isinstance(rows, list):
                    raise CognitionError("cognition_native_result_invalid")
                visible = {row.get("name") for row in rows if isinstance(row, dict)}
                value = {"skills": [{**item, **data[2]} for item, _path, data in approved.values() if item["nativeName"] in visible or data[2]["name"] in visible]}
            else:
                item, path, data = approved[selected["id"]]
                result = self._result(self.native.skill_view(item["nativeName"], task_id=session, preprocess=False))
                if result.get("_source_path") != str(path) or result.get("content") != data[4]:
                    raise CognitionError("cognition_native_content_mismatch")
                value = {"skill": {**item, **data[2]}, "content": data[3]}
            if self._roots() != roots:
                raise CognitionError("cognition_native_roots_changed")
            for path, data in catalog.items():
                try:
                    after, identity = _read(path, len(data[0]))
                except (CognitionError, OSError):
                    raise CognitionError("cognition_skill_changed") from None
                if identity != data[1] or after != data[0]:
                    raise CognitionError("cognition_skill_changed")
            return {"ok": True, "value": value}

    @staticmethod
    def _result(raw: Any) -> dict:
        if not isinstance(raw, str) or len(raw.encode()) > MAX_READ_BYTES + 65536:
            raise CognitionError("cognition_native_result_invalid")
        result = json.loads(raw)
        if not isinstance(result, dict) or result.get("success") is not True:
            raise CognitionError("cognition_native_unavailable")
        return result


def readiness(cognition: NativeSkills | None) -> dict:
    return {"cognitionSkills": cognition is not None, "cognitionProtocolVersion": PROTOCOL_VERSION, "cognitionSourcePin": HERMES_PIN}
