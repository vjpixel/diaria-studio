/**
 * validate-agent-frontmatter.ts
 *
 * Sanity check that every `.claude/agents/*.md` and
 * `.claude/skills/*\/SKILL.md` has a YAML frontmatter that parses cleanly
 * under strict YAML rules.
 *
 * Why: the Claude Code runtime rejects (silently!) agent definitions whose
 * frontmatter contains unquoted colons or other YAML traps. Symptom is
 * "Agent type X not found" with no warning that the parser failed (#122).
 *
 * Catches in CI before the agent disappears from the registry in production.
 *
 * Refs #122.
 *
 * Usage:
 *   npx tsx scripts/validate-agent-frontmatter.ts
 *
 * Exit codes:
 *   0  all frontmatters valid
 *   1  one or more failed (file paths + first error line in stderr)
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the YAML frontmatter block (between the first `---` pair) from a
 * markdown file's contents. Returns null if the frontmatter delimiters are
 * missing or malformed.
 */
export function extractFrontmatter(content: string): string | null {
  const lines = content.split("\n");
  if (lines.length < 3 || lines[0].trim() !== "---") return null;
  const closeIdx = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closeIdx === -1) return null;
  return lines.slice(1, closeIdx).join("\n");
}

/**
 * Minimal YAML strict-mode validator that mirrors the kinds of failure the
 * Claude Code runtime exhibits in practice — specifically: unquoted colons
 * in scalar values that aren't inside a quoted string. Walks each top-level
 * `key: value` pair; if `value` is unquoted and contains a `: ` (colon +
 * space, the YAML mapping-separator pattern), reports it.
 *
 * Quoted values (single or double quotes) and block scalar values (|, >)
 * are exempt.
 */
export interface ValidationIssue {
  line: number;
  key: string;
  reason: string;
  excerpt: string;
}

export function findFrontmatterIssues(frontmatter: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Top-level key:value lines look like  `key: value here`
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;

    const value = rawValue.trim();
    if (value === "") continue; // empty value (key only) — fine

    // Quoted values are safe.
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    if (isSingleQuoted || isDoubleQuoted) continue;

    // Block scalars (|, >) are safe.
    if (value === "|" || value === ">") continue;

    // Unquoted scalar — colons followed by space inside the value are
    // ambiguous to YAML and trigger "mapping values are not allowed here".
    const colonSpaceMatch = value.match(/:\s/);
    if (colonSpaceMatch) {
      const excerpt = value.slice(
        Math.max(0, (colonSpaceMatch.index ?? 0) - 20),
        Math.min(value.length, (colonSpaceMatch.index ?? 0) + 30),
      );
      issues.push({
        line: i + 1,
        key,
        reason:
          "unquoted scalar contains ': ' (YAML mapping-separator); wrap value in quotes or rephrase",
        excerpt: `… ${excerpt} …`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

interface FileResult {
  path: string;
  ok: boolean;
  issues: ValidationIssue[];
  error?: string;
}

export function validateFile(path: string): FileResult {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    return {
      path,
      ok: false,
      issues: [],
      error: `read_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const fm = extractFrontmatter(content);
  if (fm === null) {
    return { path, ok: false, issues: [], error: "missing or malformed frontmatter delimiters" };
  }
  const issues = findFrontmatterIssues(fm);
  return { path, ok: issues.length === 0, issues };
}

function listAgentFiles(root: string): string[] {
  const out: string[] = [];
  const agentsDir = join(root, ".claude/agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.endsWith(".md")) out.push(join(agentsDir, f));
    }
  }
  const skillsDir = join(root, ".claude/skills");
  if (existsSync(skillsDir)) {
    for (const skill of readdirSync(skillsDir)) {
      const skillPath = join(skillsDir, skill);
      if (!statSync(skillPath).isDirectory()) continue;
      const skillFile = join(skillPath, "SKILL.md");
      if (existsSync(skillFile)) out.push(skillFile);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = listAgentFiles(ROOT);
  if (files.length === 0) {
    console.error("No agent or skill files found under .claude/.");
    process.exit(0);
  }

  const results = files.map((f) => validateFile(f));
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    console.error(`✓ ${results.length} agent/skill frontmatters are valid YAML.`);
    process.exit(0);
  }

  console.error(`❌ ${failed.length} of ${results.length} files failed validation:`);
  for (const r of failed) {
    console.error(`\n  ${r.path}`);
    if (r.error) {
      console.error(`    error: ${r.error}`);
    }
    for (const issue of r.issues) {
      console.error(
        `    line ${issue.line} · key '${issue.key}' · ${issue.reason}`,
      );
      console.error(`      ${issue.excerpt}`);
    }
  }
  process.exit(1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
