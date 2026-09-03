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
import { isMainModule } from "./lib/cli-args.ts";

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
// MCP tool-name guard (#7279)
// ---------------------------------------------------------------------------

/**
 * Known-good `mcp__<server>__` prefixes, as of this writing. `tools:` is an
 * allowlist BY NAME — a name that doesn't match anything registered doesn't
 * error, it silently grants nothing (#7279: 5 agents nearly lost Beehiiv/
 * Gmail access this way, and `.claude/skills/diaria-mensal/SKILL.md` was
 * caught here with a literal connector UUID baked into prose).
 *
 * Update this list by hand when a connector is genuinely renamed/added —
 * that's a deliberate decision, not something to infer. A prefix missing
 * here fails loud in CI instead of failing silent at dispatch time.
 */
export const KNOWN_MCP_PREFIXES = [
  "mcp__clarice__",
  "mcp__kit__",
  "mcp__claude-in-chrome__",
  "mcp__claude_ai_Beehiiv__",
  "mcp__claude_ai_Gmail__",
  "mcp__claude_ai_Buffer__",
] as const;

// A claude.ai connector id looks like a raw UUID segment
// (mcp__ed929847-ab29-43d9-a6ba-60b687b65702__tool). That id is per-account/
// per-machine — never a stable name to hardcode in versioned prose or
// frontmatter (#7279).
const UUID_MCP_SEGMENT = /^mcp__[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__/i;

export interface McpToolIssue {
  line: number;
  tool: string;
  reason: string;
}

/**
 * Scans full file content (not just frontmatter — the #7279 offender lived
 * in skill body prose) for `mcp__<server>__<tool>` references and flags any
 * whose `<server>` segment isn't a known-good prefix.
 */
export function findUnknownMcpToolNames(content: string): McpToolIssue[] {
  const issues: McpToolIssue[] = [];
  const lines = content.split("\n");
  const toolPattern = /mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_]+/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = line.match(toolPattern);
    if (!matches) continue;
    for (const tool of matches) {
      if (UUID_MCP_SEGMENT.test(tool)) {
        issues.push({
          line: i + 1,
          tool,
          reason: "raw connector UUID baked into versioned text — use the stable mcp__claude_ai_<Nome>__ form",
        });
        continue;
      }
      const known = KNOWN_MCP_PREFIXES.some((prefix) => tool.startsWith(prefix));
      if (!known) {
        issues.push({
          line: i + 1,
          tool,
          reason: "prefix not in KNOWN_MCP_PREFIXES — new connector name, typo, or stale rename?",
        });
      }
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
  mcpIssues: McpToolIssue[];
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
      mcpIssues: [],
      error: `read_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const fm = extractFrontmatter(content);
  if (fm === null) {
    return {
      path,
      ok: false,
      issues: [],
      mcpIssues: [],
      error: "missing or malformed frontmatter delimiters",
    };
  }
  const issues = findFrontmatterIssues(fm);
  const mcpIssues = findUnknownMcpToolNames(content);
  return { path, ok: issues.length === 0 && mcpIssues.length === 0, issues, mcpIssues };
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
    for (const mcpIssue of r.mcpIssues) {
      console.error(
        `    line ${mcpIssue.line} · mcp tool '${mcpIssue.tool}' · ${mcpIssue.reason}`,
      );
    }
  }
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main();
}
