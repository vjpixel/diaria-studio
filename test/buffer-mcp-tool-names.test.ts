/**
 * buffer-mcp-tool-names.test.ts (#11564)
 *
 * Regressão: o playbook do Stage 5 (§5c-3b) mandava chamar
 * `mcp__claude_ai_Buffer__execute_mutation` e proibia `create_post`, mas o
 * conector Buffer atual não expõe `execute_mutation` (edição 261029: o
 * ToolSearch não achou; `create_post` aceitou `assets` como array).
 *
 * Guard: todo nome `mcp__claude_ai_Buffer__{tool}` citado em prompts/skills/
 * scripts/docs precisa existir na lista de ferramentas do conector. Quando o
 * conector ganhar ou perder ferramentas, atualizar BUFFER_MCP_TOOLS com a
 * lista que o ToolSearch devolve na sessão (não de memória).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Ferramentas expostas pelo conector claude.ai Buffer (lista de 29/10/2026). */
const BUFFER_MCP_TOOLS = new Set([
  "create_idea",
  "create_post",
  "create_post_template",
  "delete_post",
  "delete_post_template",
  "edit_post",
  "get_account",
  "get_aggregated_post_metrics",
  "get_channel",
  "get_post",
  "get_post_template",
  "list_channels",
  "list_idea_groups",
  "list_ideas",
  "list_post_templates",
  "list_posts",
  "update_post_template",
]);

const SCAN_DIRS = [".claude/agents", ".claude/skills", "scripts", "context", "docs", "hermes"];
const EXTENSIONS = /\.(md|ts|mjs|js|json|sh)$/;
const SKIP = new Set(["node_modules", "worktrees", "__snapshots__"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTENSIONS.test(name)) out.push(p);
  }
}

describe("nomes de ferramenta do MCP Buffer (#11564)", () => {
  it("todo mcp__claude_ai_Buffer__* citado existe no conector", () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
    const unknown: string[] = [];
    const re = /mcp__claude_ai_Buffer__([a-z_]+)/g;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(re)) {
        if (!BUFFER_MCP_TOOLS.has(m[1])) unknown.push(`${relative(ROOT, f)}: ${m[1]}`);
      }
    }
    assert.deepEqual(unknown, [], `ferramentas Buffer inexistentes citadas:\n${unknown.join("\n")}`);
  });

  it("Stage 5 §5c-3b usa create_post como chamada primária do X", () => {
    const s = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-5.md"), "utf8");
    const start = s.indexOf("**Passo 5c-3b:");
    const end = s.indexOf("**Passo 5c-3c:");
    assert.ok(start >= 0 && end > start, "seções 5c-3b/5c-3c não encontradas");
    const sec = s.slice(start, end);
    assert.match(sec, /chamar `mcp__claude_ai_Buffer__create_post`/);
    assert.doesNotMatch(sec, /NAO `create_post`/);
  });
});
