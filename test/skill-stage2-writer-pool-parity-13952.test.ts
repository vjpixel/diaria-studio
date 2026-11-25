/**
 * #13952 (regressão #633): o passo do `writer-pool` (#13884 —
 * `pool-descriptions.ts --input` → agent `writer-pool` → `--apply`) entrou só
 * em `orchestrator-stage-2.md`. A skill isolada `/diaria-2-escrita` ia do
 * stitch direto ao `cp 02-draft.md 02-reviewed.md`, então
 * `descriptions-applied.json` nunca era gravado e o `source-not-read` (ERRO
 * para item de pool) travava o gate 4.
 *
 * Guard de paridade: os passos (1)-(4) do parágrafo "Descrição do pool a
 * partir do texto lido" são idênticos nos dois playbooks (normalizando
 * `{EDITION_DIR}` → `{EDIR}`), e na skill o passo fica entre o stitch e o
 * `cp` do 2b-news, citado também no Fallback e no modo `newsletter`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const skill = read(".claude/skills/diaria-2-escrita/SKILL.md");
const orch = read(".claude/agents/orchestrator-stage-2.md");

const HEADER = "**Descrição do pool a partir do texto lido";

/** Parágrafo do passo, dos passos (1)-(4) até o fim da linha. */
function poolSteps(md: string, label: string): string {
  const lines = md.split("\n").filter((l) => l.startsWith(HEADER));
  assert.equal(lines.length, 1, `${label}: esperado 1 parágrafo "${HEADER}", achou ${lines.length}`);
  const line = lines[0];
  const start = line.indexOf("(1) ");
  assert.ok(start > 0, `${label}: parágrafo sem o passo (1)`);
  return line.slice(start).replaceAll("{EDITION_DIR}", "{EDIR}").trim();
}

describe("#13952 — writer-pool na skill /diaria-2-escrita", () => {
  it("passos (1)-(4) idênticos aos do orchestrator-stage-2.md", () => {
    assert.equal(poolSteps(skill, "SKILL.md"), poolSteps(orch, "orchestrator-stage-2.md"));
  });

  it("os passos citam --input, writer-pool e --apply", () => {
    const s = poolSteps(skill, "SKILL.md");
    assert.match(s, /pool-descriptions\.ts --input --edition-dir \{EDIR\}\//);
    assert.match(s, /`Agent` → `writer-pool`/);
    assert.match(s, /pool-descriptions\.ts --apply --edition-dir \{EDIR\}\//);
  });

  it("na skill o passo fica depois do stitch e antes do cp do 2b-news", () => {
    const stitch = skill.indexOf("npx tsx scripts/stitch-newsletter.ts --edition-dir {EDIR}/");
    const step = skill.indexOf(HEADER);
    const cp = skill.indexOf("cp {EDIR}/_internal/02-draft.md {EDIR}/02-reviewed.md");
    assert.ok(stitch > 0 && step > 0 && cp > 0, "âncoras ausentes na skill");
    assert.ok(stitch < step, "passo do writer-pool antes do stitch");
    assert.ok(step < cp, "passo do writer-pool depois do cp 02-draft → 02-reviewed");
  });

  // #13956: o passo (2) usa `--since {DISPATCH_AT}`; na skill isolada nada o
  // definia (no orchestrator ele vem do dispatch dos writers, linha "Antes
  // desta mensagem"), e o placeholder literal faz `parseSince` recusar.
  it("{DISPATCH_AT} é definido (verify-agent-outputs --now) antes de cada uso", () => {
    const DEF = "`npx tsx scripts/verify-agent-outputs.ts --now` → `{DISPATCH_AT}`";
    for (const [label, md] of [["SKILL.md", skill], ["orchestrator-stage-2.md", orch]] as const) {
      const def = md.indexOf(DEF);
      assert.ok(def >= 0, `${label}: {DISPATCH_AT} nunca é definido com verify-agent-outputs.ts --now`);
      const uses = [...md.matchAll(/--since \{DISPATCH_AT\}/g)].map((m) => m.index!);
      assert.ok(uses.length > 0, `${label}: nenhum uso de --since {DISPATCH_AT}`);
      for (const u of uses) assert.ok(def < u, `${label}: uso de {DISPATCH_AT} na posição ${u} antes da definição (${def})`);
    }
    // Na skill, a definição fica no próprio passo do writer-pool, fora dos
    // passos (1)-(4) comparados com o orchestrator.
    const line = skill.split("\n").find((l) => l.startsWith(HEADER))!;
    const defInLine = line.indexOf(DEF);
    assert.ok(defInLine >= 0 && defInLine < line.indexOf("(1) "), "SKILL.md: definição fora do cabeçalho do passo do writer-pool");
  });

  it("Fallback e modo newsletter remetem ao passo", () => {
    const fallback = skill.slice(skill.indexOf("### Fallback (writer único legacy)"), skill.indexOf("### Se `$2 = newsletter`:"));
    assert.match(fallback, /#13952[\s\S]*pool-descriptions\.ts --input → writer-pool/);
    const newsletter = skill.slice(skill.indexOf("### Se `$2 = newsletter`:"), skill.indexOf("### Se `$2 = social`:"));
    assert.match(newsletter, /Descrição do pool a partir do texto lido[\s\S]*#13952/);
    const news2b = skill.slice(skill.indexOf("### 2b-news"), skill.indexOf("cp {EDIR}/_internal/02-draft.md {EDIR}/02-reviewed.md"));
    assert.match(news2b, /Descrição do pool a partir do texto lido/);
  });
});
