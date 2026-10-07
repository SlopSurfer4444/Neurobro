"""Hermes in-process plugin. Explicit trusted bootstrap only; defaults deny."""
from __future__ import annotations

import json
import os
from .neurobro_bridge import Bridge, SCHEMA, TOOL_NAME, unavailable

_bridge: Bridge | None = None
_management = None
_cron = None


def configure_bridge(bridge: Bridge) -> None:
    """In-process embedding option; separate from model-facing tools."""
    global _bridge
    if _bridge is not None and _bridge is not bridge:
        raise RuntimeError("Bridge bootstrap is immutable for this process")
    _bridge = bridge


def _handle(args, *, task_id="", session_id=""):
    if _bridge is None:
        return json.dumps(unavailable("trusted_host_bootstrap_unavailable"))
    return _bridge.handle(args, task_id=task_id, session_id=session_id)


def register(ctx):
    global _management, _cron
    settings = [os.environ.get(name) for name in (
        "NEUROBRO_BRIDGE_BIND", "NEUROBRO_BRIDGE_REGISTRATION_KEY", "NEUROBRO_BROKER_URL")]
    if any(settings) and not all(settings):
        raise RuntimeError("Incomplete explicit trusted bridge configuration")
    if all(settings) and _management is None:
        from .management import BrokerHttpClient, ManagementServer, parse_bind
        client = BrokerHttpClient(settings[2])
        bridge = Bridge(client.call)
        cognition = None
        if os.environ.get("NEUROBRO_COGNITION_SKILLS_ROOT"):
            from .cognition import NativeSkills, CognitionError
            try:
                cognition = NativeSkills.load(bridge=bridge, skills_root=os.environ["NEUROBRO_COGNITION_SKILLS_ROOT"])
            except (CognitionError, ImportError, OSError):
                # Configured does not assert ready: endpoint fails typed closed.
                cognition = None
        server = ManagementServer(bridge, parse_bind(settings[0]), settings[1], cognition=cognition)
        configure_bridge(bridge)
        _management = server
        server.start()
    if os.environ.get("NEUROBRO_CRON_BIND") and _cron is None:
        if _bridge is None:
            raise RuntimeError("Cron requires the trusted broker bridge")
        from .cron_extension import bootstrap
        _cron = bootstrap(ctx, _bridge)
    ctx.register_tool(name=TOOL_NAME, toolset="neurobro", schema=SCHEMA,
                      handler=_handle, description=SCHEMA["description"])
