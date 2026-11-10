/**
 * test/stage4-intro-count-sync-12594.test.ts (#12594)
 *
 * Edição 261109: a intro dizia "selecionei os 12 mais relevantes" com 13 itens
 * no rascunho e, depois dos cortes do editor no gate, 10 itens; o editor
 * corrigiu à mão. O playbook do Stage 4 passa a recalcular o N pelo conteúdo
 * (`sync-intro-count.ts`) antes do pré-render (§4b) e de novo antes do
 * sentinel (§4e), com re-render quando o número muda. Trava a posição dos
 * dois passos no playbook e o comportamento do script no cenário real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const PLAYBOOK = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-4.md"), "utf8");
const SYNC_CMD = "npx tsx scripts/sync-intro-count.ts --md {EDITION_DIR}/02-reviewed.md";

function section(start: string, end: string): string {
  const i = PLAYBOOK.indexOf(start);
  const j = PLAYBOOK.indexOf(end, i + 1);
  assert.ok(i >= 0 && j > i, `seção ${start} encontrada`);
  return PLAYBOOK.slice(i, j);
}

describe("Stage 4 recalcula a contagem da intro (#12594)", () => {
  it("§4b roda sync-intro-count antes do pré-render do newsletter", () => {
    const s4b = section("### 4b. Pré-render técnico", "### 4c.");
    const sync = s4b.indexOf(SYNC_CMD);
    const render = s4b.indexOf("Pre-render do newsletter HTML");
    assert.ok(sync >= 0, "sync-intro-count no §4b");
    assert.ok(render > sync, "sync antes do pré-render");
  });

  it("§4e roda sync-intro-count antes do sentinel e manda re-renderizar quando muda", () => {
    const s4e = section("### 4e. Escrever sentinel de conclusão", "## Fluxo pós-gate");
    const sync = s4e.indexOf(SYNC_CMD);
    const sentinel = s4e.indexOf("pipeline-sentinel.ts write");
    assert.ok(sync >= 0, "sync-intro-count no §4e");
    assert.ok(sentinel > sync, "sync antes do sentinel");
    const para = s4e.slice(sync, s4e.indexOf("\n", sync));
    assert.match(para, /"changed": true/);
    assert.match(para, /render-newsletter-html\.ts/);
  });

  it("o script corrige 12 → 10 depois do corte do gate (cenário 261109)", () => {
    const items = (n: number, sec: string) =>
      Array.from({ length: n }, (_, k) => `**[${sec} ${k}](https://example${k}.com/${sec.toLowerCase()})**  \nDescrição ${k}.`).join("\n\n");
    const destaque = (n: number) =>
      `**DESTAQUE ${n} | 🚀 LANÇAMENTO**\n\n**[Título ${n}](https://d${n}.example.org/a)**\n\nCorpo.\n\nPor que isso importa:\n\nImpacto.`;
    const md = [
      "Nesta edição, a IA analisou 40 conteúdos (2 enviados por mim e 38 encontrados automaticamente) e selecionei os 12 mais relevantes.",
      "---",
      destaque(1),
      "---",
      destaque(2),
      "---",
      destaque(3),
      "---",
      "**🚀 LANÇAMENTOS**\n\n" + items(2, "Lanc"),
      "---",
      "**📡 RADAR**\n\n" + items(5, "Radar"),
    ].join("\n\n");
    const dir = mkdtempSync(join(tmpdir(), "intro-12594-"));
    try {
      const file = join(dir, "02-reviewed.md");
      writeFileSync(file, md);
      const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/sync-intro-count.ts"), "--md", file], {
        cwd: ROOT,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.changed, true);
      assert.equal(out.actual, 10);
      assert.match(readFileSync(file, "utf8"), /selecionei os 10 mais relevantes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
