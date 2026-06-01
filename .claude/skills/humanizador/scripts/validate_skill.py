#!/usr/bin/env python3
"""Validate SKILL.md frontmatter and README/SKILL consistency.

Checks:
1. SKILL.md frontmatter is parseable YAML.
2. Required fields are present and well-typed.
3. version is semver (MAJOR.MINOR.PATCH).
4. allowed-tools is a list of strings.
5. README.md mentions the same version that SKILL.md declares.
6. The number of numbered patterns in SKILL.md matches the count claimed in README.md.

Exits non-zero on any failure, printing all collected errors.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SKILL_PATH = ROOT / "SKILL.md"
README_PATH = ROOT / "README.md"

REQUIRED_FIELDS = {
    "name": str,
    "version": str,
    "description": str,
    "license": str,
    "compatibility": str,
    "allowed-tools": list,
}

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
PATTERN_HEADING_RE = re.compile(r"^### (\d+)\.\s", re.MULTILINE)
README_COUNT_RE = re.compile(r"(\d+)\s+padrões")


def load_frontmatter(path: Path) -> tuple[dict, list[str]]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        errors.append(f"{path.name}: file does not start with YAML frontmatter (`---`).")
        return {}, errors
    end = text.find("\n---", 4)
    if end == -1:
        errors.append(f"{path.name}: closing `---` for frontmatter not found.")
        return {}, errors
    raw = text[4:end]
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        errors.append(f"{path.name}: frontmatter is not valid YAML: {exc}")
        return {}, errors
    if not isinstance(data, dict):
        errors.append(f"{path.name}: frontmatter must be a mapping, got {type(data).__name__}.")
        return {}, errors
    return data, errors


def validate_frontmatter(data: dict) -> list[str]:
    errors: list[str] = []
    for field, expected_type in REQUIRED_FIELDS.items():
        if field not in data:
            errors.append(f"frontmatter: missing required field `{field}`.")
            continue
        value = data[field]
        if not isinstance(value, expected_type):
            errors.append(
                f"frontmatter: `{field}` must be {expected_type.__name__}, "
                f"got {type(value).__name__}."
            )
    version = data.get("version")
    if isinstance(version, str) and not SEMVER_RE.match(version):
        errors.append(f"frontmatter: `version` must be semver (X.Y.Z), got {version!r}.")
    tools = data.get("allowed-tools")
    if isinstance(tools, list):
        for i, tool in enumerate(tools):
            if not isinstance(tool, str):
                errors.append(
                    f"frontmatter: `allowed-tools[{i}]` must be a string, "
                    f"got {type(tool).__name__}."
                )
    return errors


def count_patterns(skill_text: str) -> int:
    numbers = [int(m.group(1)) for m in PATTERN_HEADING_RE.finditer(skill_text)]
    return max(numbers) if numbers else 0


def check_consistency(skill_data: dict, skill_text: str, readme_text: str) -> list[str]:
    errors: list[str] = []
    version = skill_data.get("version")
    if isinstance(version, str) and version not in readme_text:
        errors.append(
            f"consistency: SKILL.md version {version!r} not found in README.md "
            "(check 'Histórico de versões')."
        )

    pattern_count = count_patterns(skill_text)
    if pattern_count == 0:
        errors.append("consistency: no numbered patterns (`### N.`) found in SKILL.md.")
        return errors

    readme_counts = {int(m.group(1)) for m in README_COUNT_RE.finditer(readme_text)}
    if not readme_counts:
        errors.append(
            "consistency: README.md does not mention pattern count "
            "(expected something like '26 padrões')."
        )
    elif pattern_count not in readme_counts:
        errors.append(
            f"consistency: SKILL.md has {pattern_count} numbered patterns, "
            f"but README.md mentions {sorted(readme_counts)}."
        )
    return errors


def main() -> int:
    all_errors: list[str] = []

    skill_data, fm_load_errors = load_frontmatter(SKILL_PATH)
    all_errors.extend(fm_load_errors)
    if skill_data:
        all_errors.extend(validate_frontmatter(skill_data))

    skill_text = SKILL_PATH.read_text(encoding="utf-8")
    readme_text = README_PATH.read_text(encoding="utf-8")
    if skill_data:
        all_errors.extend(check_consistency(skill_data, skill_text, readme_text))

    if all_errors:
        print("SKILL validation failed:")
        for err in all_errors:
            print(f"  - {err}")
        return 1

    pattern_count = count_patterns(skill_text)
    print(
        f"SKILL.md OK — version {skill_data['version']}, "
        f"{pattern_count} numbered patterns, README consistent."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
