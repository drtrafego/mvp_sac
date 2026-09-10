"""Exporta atomicamente o snapshot sanitizado usado pelo painel estatico."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Mapping

from .autonomia_readonly import _bounded_limit, _iso, build_from_env


def export_snapshot(env: Mapping[str, str] = os.environ) -> Path:
    raw_target = env.get("AUTONOMIA_SNAPSHOT_PATH", "").strip()
    if not raw_target:
        raise ValueError("AUTONOMIA_SNAPSHOT_PATH obrigatorio")
    target = Path(raw_target)
    parent = target.parent.resolve(strict=True)
    if target.is_symlink():
        raise ValueError("snapshot nao pode ser symlink")
    limit = _bounded_limit(env.get("AUTONOMIA_SNAPSHOT_LIMIT"))
    payload = build_from_env(env).repository.snapshot(limit)
    encoded = (json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=_iso) + "\n").encode()
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=f".{target.name}.", suffix=".tmp",
                                         dir=parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, target)
        temporary = None
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    try:
        target = export_snapshot()
    except Exception as exc:
        # Exibe apenas o tipo; excecoes de driver podem conter DSN/PII.
        print(f"snapshot falhou: {type(exc).__name__}", file=os.sys.stderr)
        return 1
    print(f"snapshot atualizado: {target.name}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
