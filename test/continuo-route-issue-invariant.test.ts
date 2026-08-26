/**
 * Invariante #6196 — cada referência a `gh issue edit` em SKILL.md deve ter
 * `route-issue` como substituto (ou ressaltar #6196 como fallback até merge).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

function findSkmdFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...findSkmdFiles(full));
    } else if (entry.name.endsWith("SKILL.md")) {
      result.push(full);
    }
  }
  return result;
}

describe("invariante #6196 — route-issue referenciado nas SKILLs", () => {
  it("cada SKILL.md que menciona `gh issue edit` também menciona `route-issue`", () => {
    const skillsDir = resolve(import.meta.dirname, "../.claude/skills");
    const skmdFiles = findSkmdFiles(skillsDir);
    const violations: string[] = [];
    for (const file of skmdFiles) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("gh issue edit")) {
          // Check nearby lines (±3 lines) for route-issue reference or #6196 fallback
          const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join("\n");
          const hasRouteIssue = window.includes("route-issue") || window.includes("#6196");
          if (!hasRouteIssue) {
            violations.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }
    assert.strictEqual(
      violations.length,
      0,
      `Issues sem referência a route-issue (#6196):\n  ${violations.join("\n  ")}`,
    );
  });
});
