#!/usr/bin/env python3
"""Smoke test runner for the humanizador skill.

Loads SKILL.md as the system prompt, runs each fixture in tests/fixtures/
through the Claude API, and applies qualitative assertions defined in YAML.

Usage:
    pip install anthropic pyyaml
    export ANTHROPIC_API_KEY=...
    python3 scripts/smoke_test.py
    python3 scripts/smoke_test.py --fixture travessao
    python3 scripts/smoke_test.py --dry-run    # validate fixtures, no API
    python3 scripts/smoke_test.py --list       # show fixtures without running
    python3 scripts/smoke_test.py --model claude-haiku-4-5-20251001  # cheaper
    python3 scripts/smoke_test.py --runs 5 --tolerance 2  # 5 runs, allow 2 fails

Each fixture runs N times (default 3) and is considered PASS if at most
`tolerance` runs fail (default 1). Mitigates LLM sampling flakiness without
hiding real regressions: 3-of-3 fail = real bug; 1-of-3 fail = noise tolerated.

Each fixture is a pair under tests/fixtures/:
    <name>.input.md         AI-flavored text fed to the skill
    <name>.assertions.yml   qualitative checks on the output

Supported assertion keys (all optional):
    description: free-text label, ignored by the runner
    travessoes_max: int     max count of "—" in output
    banned_phrases: [str]   substrings that must not appear (case-insensitive)
    required_paragraph_count_min: int
    required_paragraph_count_max: int
    min_chars: int
    max_chars: int

Exits non-zero if any fixture fails.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SKILL_PATH = ROOT / "SKILL.md"
FIXTURES_DIR = ROOT / "tests" / "fixtures"

DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_TOKENS = 4096


@dataclass
class Fixture:
    name: str
    input_text: str
    assertions: dict


def load_fixtures(filter_substr: str | None = None) -> list[Fixture]:
    if not FIXTURES_DIR.exists():
        return []
    fixtures: list[Fixture] = []
    for input_file in sorted(FIXTURES_DIR.glob("*.input.md")):
        name = input_file.name.removesuffix(".input.md")
        if filter_substr and filter_substr not in name:
            continue
        assertions_file = FIXTURES_DIR / f"{name}.assertions.yml"
        if not assertions_file.exists():
            print(f"WARNING: {name} has no assertions file, skipping", file=sys.stderr)
            continue
        try:
            assertions = yaml.safe_load(assertions_file.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            print(f"ERROR: {name} assertions YAML invalid: {exc}", file=sys.stderr)
            continue
        fixtures.append(
            Fixture(
                name=name,
                input_text=input_file.read_text(encoding="utf-8"),
                assertions=assertions,
            )
        )
    return fixtures


def load_system_prompt() -> str:
    """Return the prompt portion of SKILL.md (everything after frontmatter)."""
    text = SKILL_PATH.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise RuntimeError("SKILL.md does not start with YAML frontmatter")
    end = text.find("\n---", 4)
    if end == -1:
        raise RuntimeError("SKILL.md frontmatter not closed")
    return text[end + 4 :].strip()


def call_claude(client, system_prompt: str, user_text: str, model: str) -> str:
    """Invoke the API with prompt caching on the system prompt."""
    response = client.messages.create(
        model=model,
        max_tokens=DEFAULT_MAX_TOKENS,
        system=[
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": f"Humanize este texto:\n\n{user_text}",
            }
        ],
    )
    chunks: list[str] = []
    for block in response.content:
        if getattr(block, "type", None) == "text":
            chunks.append(block.text)
    return "\n".join(chunks).strip()


def check_assertions(output: str, assertions: dict) -> list[str]:
    failures: list[str] = []

    if "travessoes_max" in assertions:
        count = output.count("—")
        if count > assertions["travessoes_max"]:
            failures.append(
                f"travessoes_max: encontrou {count}, esperado ≤ {assertions['travessoes_max']}"
            )

    if "banned_phrases" in assertions:
        lower_output = output.lower()
        for phrase in assertions["banned_phrases"]:
            if phrase.lower() in lower_output:
                failures.append(f"banned_phrase apareceu: {phrase!r}")

    paragraphs = [p for p in output.split("\n\n") if p.strip()]
    if "required_paragraph_count_min" in assertions:
        target = assertions["required_paragraph_count_min"]
        if len(paragraphs) < target:
            failures.append(
                f"required_paragraph_count_min: {len(paragraphs)} parágrafos, "
                f"esperado ≥ {target}"
            )
    if "required_paragraph_count_max" in assertions:
        target = assertions["required_paragraph_count_max"]
        if len(paragraphs) > target:
            failures.append(
                f"required_paragraph_count_max: {len(paragraphs)} parágrafos, "
                f"esperado ≤ {target}"
            )

    if "min_chars" in assertions and len(output) < assertions["min_chars"]:
        failures.append(
            f"min_chars: {len(output)} chars, esperado ≥ {assertions['min_chars']}"
        )
    if "max_chars" in assertions and len(output) > assertions["max_chars"]:
        failures.append(
            f"max_chars: {len(output)} chars, esperado ≤ {assertions['max_chars']}"
        )

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Smoke test the humanizador skill",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Claude model ID")
    parser.add_argument("--fixture", default=None, help="Run only fixtures matching substring")
    parser.add_argument("--list", action="store_true", help="List fixtures and exit")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate fixture loading without calling the API",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Print each output")
    parser.add_argument(
        "--runs",
        type=int,
        default=3,
        help="Quantas vezes rodar cada fixture (default: 3)",
    )
    parser.add_argument(
        "--tolerance",
        type=int,
        default=1,
        help="Quantas falhas tolerar por fixture, de N runs (default: 1)",
    )
    args = parser.parse_args()

    if args.runs < 1:
        print("ERRO: --runs precisa ser ≥ 1.", file=sys.stderr)
        return 1
    if args.tolerance < 0 or args.tolerance >= args.runs:
        print(
            f"ERRO: --tolerance precisa estar em [0, runs-1] (runs={args.runs}).",
            file=sys.stderr,
        )
        return 1

    fixtures = load_fixtures(args.fixture)
    if not fixtures:
        print("Nenhum fixture encontrado em tests/fixtures/.", file=sys.stderr)
        return 1

    if args.list or args.dry_run:
        print(f"{len(fixtures)} fixture(s) carregado(s):")
        for fx in fixtures:
            keys = ", ".join(k for k in fx.assertions if k != "description") or "(nenhuma)"
            desc = fx.assertions.get("description", "")
            print(f"  - {fx.name} [{keys}]" + (f" — {desc}" if desc else ""))
        if args.list or args.dry_run:
            return 0

    try:
        import anthropic
    except ImportError:
        print(
            "ERRO: pacote `anthropic` não instalado. Rode `pip install anthropic`.",
            file=sys.stderr,
        )
        return 1

    if "ANTHROPIC_API_KEY" not in os.environ:
        print("ERRO: ANTHROPIC_API_KEY não está setada.", file=sys.stderr)
        return 1

    client = anthropic.Anthropic()
    system_prompt = load_system_prompt()

    passes = 0
    fails = 0
    for fx in fixtures:
        print(f"\n[{fx.name}] rodando contra {args.model} × {args.runs}...")
        run_failures = 0
        for i in range(args.runs):
            try:
                output = call_claude(client, system_prompt, fx.input_text, args.model)
            except Exception as exc:
                print(f"  run {i+1}: ERRO na chamada da API: {exc}")
                run_failures += 1
                continue

            if args.verbose:
                print(f"  --- output run {i+1} ---\n{output}\n  --- /output ---")

            failures = check_assertions(output, fx.assertions)
            if failures:
                print(f"  run {i+1}: FAIL")
                for f in failures:
                    print(f"    - {f}")
                run_failures += 1
            else:
                print(f"  run {i+1}: PASS")

        run_passes = args.runs - run_failures
        if run_failures <= args.tolerance:
            tag = " (dentro da tolerância)" if run_failures > 0 else ""
            print(f"  resultado: {run_passes}/{args.runs} PASS{tag}")
            passes += 1
        else:
            print(
                f"  resultado: {run_passes}/{args.runs} PASS — "
                f"FAIL (excedeu tolerância {args.tolerance})"
            )
            fails += 1

    print(f"\n{passes} passou, {fails} falhou (de {len(fixtures)} fixtures)")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
