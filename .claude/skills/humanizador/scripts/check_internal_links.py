#!/usr/bin/env python3
"""Check that internal links in tracked Markdown files resolve to real paths.

Scope: relative file links (e.g. `./SKILL.md`, `scripts/foo.py`) and same-file
anchor links (e.g. `#instalação`). External `http(s)://` and `mailto:` links
are out of scope (the workflow has a separate optional job for those).

Anchors are matched against ATX headings in the target file, normalized with
the same algorithm GitHub uses (lowercase, spaces → hyphens, drop most
punctuation, keep unicode letters/digits and hyphens). The matching is
intentionally loose to avoid false negatives on accent variations.
"""

from __future__ import annotations

import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET_FILES = ["README.md", "SKILL.md", "WARP.md", "CONTRIBUTING.md"]

LINK_RE = re.compile(r"\[(?:[^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$", re.MULTILINE)


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE)
    text = re.sub(r"\s+", "-", text)
    return text.strip("-")


def collect_anchors(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    return {slugify(m.group(2)) for m in HEADING_RE.finditer(text)}


def check_file(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    own_anchors = collect_anchors(path)

    for match in LINK_RE.finditer(text):
        target = match.group(1)
        if target.startswith(("http://", "https://", "mailto:", "tel:")):
            continue
        if target.startswith("#"):
            anchor = slugify(target[1:])
            if anchor and anchor not in own_anchors:
                errors.append(f"{path.name}: anchor `{target}` not found in same file.")
            continue

        path_part, _, anchor = target.partition("#")
        if not path_part:
            continue
        resolved = (path.parent / path_part).resolve()
        if not resolved.exists():
            errors.append(f"{path.name}: link `{target}` → `{path_part}` does not exist.")
            continue
        if anchor and resolved.suffix.lower() == ".md":
            anchor_slug = slugify(anchor)
            if anchor_slug and anchor_slug not in collect_anchors(resolved):
                errors.append(
                    f"{path.name}: anchor `#{anchor}` not found in `{path_part}`."
                )
    return errors


def main() -> int:
    all_errors: list[str] = []
    for name in TARGET_FILES:
        path = ROOT / name
        if not path.exists():
            all_errors.append(f"missing file: {name}")
            continue
        all_errors.extend(check_file(path))

    if all_errors:
        print("Internal link check failed:")
        for err in all_errors:
            print(f"  - {err}")
        return 1
    print("Internal links OK across:", ", ".join(TARGET_FILES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
