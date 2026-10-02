/**
 * #9399 — o Stage 0/1 headless (`claude -p`, single-turn) não consegue aprovar
 * chamadas MCP: toda tool MCP de leitura que o Stage 0 usa precisa estar em
 * `permissions.allow` do `.claude/settings.json` versionado, senão a edição
 * falha (261002) ou o passo é pulado em silêncio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
const allow: string[] = settings.permissions.allow;

const REQUIRED_READ_ONLY = [
  "mcp__claude_ai_Gmail__list_labels",
  "mcp__claude_ai_Beehiiv__get_current_user",
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Beehiiv__list_posts",
  "mcp__claude_ai_Beehiiv__get_post_content",
  "mcp__claude_ai_Beehiiv__list_post_clicks",
];

describe("settings.json allowlist do Stage 0 headless (#9399)", () => {
  for (const tool of REQUIRED_READ_ONLY) {
    it(`libera ${tool}`, () => {
      assert.ok(allow.includes(tool), `${tool} ausente de permissions.allow`);
    });
  }

  it("probes de needsMcpProbes (stage-0-run.ts) estão liberados", () => {
    const src = readFileSync("scripts/stage-0-run.ts", "utf8");
    const block = src.slice(src.indexOf("needsMcpProbes: {"));
    const probes = [...block.slice(0, 900).matchAll(/'(mcp__[a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
    assert.ok(probes.length >= 3, "esperava ≥3 probes MCP");
    for (const p of probes) assert.ok(allow.includes(p), `${p} ausente de permissions.allow`);
  });

  it("não libera tools MCP de escrita desses servidores", () => {
    const writes = allow.filter((t) =>
      /^mcp__claude_ai_(Gmail|Beehiiv)__(send|create|delete|save|edit|update|reply|forward|trash)/.test(t),
    );
    assert.deepEqual(writes, []);
  });
});
