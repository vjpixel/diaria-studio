/**
 * #14108: o pre-flight do Claude in Chrome (#143) no playbook da Etapa 0
 * dizia que, sem Chrome, a Etapa 5 gravava `05-published.json` com
 * `status: "skipped"` e marcava o LinkedIn como `pending_manual`, e pedia
 * `[y/n]` ao editor. Isso contradiz o Stage 5: o LinkedIn sai pelo Worker
 * (#971) e `chromeMcp === false` só troca o teste pela UI do Kit pelo
 * `--send-test` (§5c-1-kit). Este teste trava o texto correto no Stage 0 e
 * a frase de origem no Stage 5, e impede a volta do texto antigo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readStage0Playbook } from "../scripts/lib/stage01-playbook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = (f: string) => readFileSync(resolve(ROOT, ".claude/agents", f), "utf8");

/** Bloco do pre-flight do Chrome: do bullet #143 até o bullet do Gmail. */
function chromePreflightBlock(text: string): string {
  const start = text.indexOf("**Pre-flight Claude in Chrome MCP (#143).**");
  assert.ok(start >= 0, "bullet do pre-flight do Chrome (#143) sumiu do playbook da Etapa 0");
  const end = text.indexOf("**Pre-flight Gmail MCP", start);
  assert.ok(end > start, "bullet do pre-flight do Gmail deveria vir logo depois do Chrome");
  return text.slice(start, end);
}

describe("#14108 pre-flight do Chrome na Etapa 0", () => {
  const block = chromePreflightBlock(agent("orchestrator-stage-0-preflight.md"));

  it("sem Chrome, a Etapa 5 só troca o teste pela UI do Kit pelo --send-test", () => {
    assert.match(
      block,
      /`CHROME_MCP = false` só troca o teste pela UI do Kit pelo fallback `--send-test` \(§5c-1-kit/,
    );
    assert.match(block, /Nenhum canal vira `pending_manual` por isso/);
  });

  it("não manda marcar LinkedIn como pending_manual nem gravar 05-published.json", () => {
    assert.doesNotMatch(block, /LinkedIn entries com `status: "pending_manual"`/);
    assert.doesNotMatch(block, /gravar `_internal\/05-published\.json`/);
  });

  it("Chrome ausente não abre prompt [y/n] (#5321): warn + banner", () => {
    assert.doesNotMatch(block, /aguardar `\[y\/n\]`/);
    assert.match(block, /Não perguntar `\[y\/n\]` em nenhum modo/);
  });

  it("o texto antigo não sobrevive em nenhum arquivo do playbook da Etapa 0", () => {
    assert.doesNotMatch(readStage0Playbook(), /LinkedIn entries com `status: "pending_manual"`/);
  });

  it("a fonte do comportamento no Stage 5 continua dizendo o mesmo", () => {
    const s5 = agent("orchestrator-stage-5.md");
    assert.match(s5, /`chromeMcp === false` so troca o teste pela UI do Kit pelo fallback `--send-test` \(§5c-1-kit\)/);
    assert.match(s5, /LinkedIn nao usa Chrome/);
  });
});
