#!/usr/bin/env python3
"""Validate the Canvas domain contract without depending on one source spelling."""

from __future__ import annotations

import re
import sys
from pathlib import Path

SUPPORTED_DOMAINS = ("gptch.cloud", "artworkers.online", "aiunify.xyz")


def fail(message: str) -> None:
    print(f"canvas-contract: {message}", file=sys.stderr)
    raise SystemExit(1)


def assignment(source: str, name: str) -> str:
    match = re.search(
        rf"(?:const|let|var)\s+{re.escape(name)}\s*=\s*(?P<expr>[^;]+);",
        source,
        re.MULTILINE,
    )
    if not match:
        fail(f"missing {name} assignment")
    return match.group("expr").strip()


def fixed_base_has_precedence(expression: str) -> bool:
    normalized = expression.strip()
    while normalized.startswith("(") and normalized.endswith(")"):
        normalized = normalized[1:-1].strip()
    return bool(
        re.fullmatch(r"FIXED_API_BASE_URL(?:\s*\|\|\s*.+)?", normalized, re.DOTALL)
    )


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: validate-canvas-contract.py <canvas-dir> <selected-domain>")

    canvas_dir = Path(sys.argv[1])
    selected_domain = sys.argv[2]
    if selected_domain not in SUPPORTED_DOMAINS:
        fail(f"unsupported selected domain: {selected_domain}")

    env_path = canvas_dir / "web/src/constant/env.ts"
    config_path = canvas_dir / "web/src/stores/use-config-store.ts"
    for path in (env_path, config_path):
        if not path.is_file():
            fail(f"missing source file: {path}")

    env_source = env_path.read_text(encoding="utf-8")
    config_source = config_path.read_text(encoding="utf-8")
    fixed_expr = assignment(env_source, "FIXED_API_BASE_URL")
    if "import.meta.env.VITE_FIXED_API_BASE_URL" not in fixed_expr:
        fail("FIXED_API_BASE_URL must derive from VITE_FIXED_API_BASE_URL")
    if not re.search(
        r"import\s*\{\s*FIXED_API_BASE_URL\s*\}\s*from\s*[\"'][^\"']*constant/env[\"']",
        config_source,
    ):
        fail("use-config-store must import FIXED_API_BASE_URL from constant/env")

    openai_expr = assignment(config_source, "OPENAI_BASE_URL")
    if not fixed_base_has_precedence(openai_expr):
        fail("OPENAI_BASE_URL must prefer FIXED_API_BASE_URL before any fallback")

    # Documentation defaults and help links are not API origins. Restrict the
    # cross-domain prohibition to the API configuration source we just proved
    # is consumed by the Canvas request configuration.
    for domain in SUPPORTED_DOMAINS:
        if domain != selected_domain and f'"https://{domain}"' in config_source:
            fail(f"config store contains forbidden API origin {domain}")

    print("canvas_contract=semantic-pass")
    print(f"selected_domain={selected_domain}")


if __name__ == "__main__":
    main()
