/**
 * #13952 (regressão #633): o passo do `writer-pool` (#13884 —
 * `pool-descriptions.ts --input` → agent `writer-pool` → `--apply`) entrou só
 * em `orchestrator-stage-2.md`. A skill isolada `/diaria-2-escrita` ia do
 * stitch direto ao `cp 02-draft.md 02-reviewed.md`, então
 * `descriptions-applied.json` nunca era gravado e o `source-not-read` (ERRO
 * para item de pool) travava o gate 4.
 *
 * #14113: a skill deixou de repetir a receita (era a duplicação que deixava
 * as duas cópias divergirem). O passo vive numa cópia só, no fallback do
 * runner, e o runner o executa nas fases `post-writers`/`post-pool`. O guard
 * passa a ser: uma cópia só no conjunto skill + playbooks, com os passos
 * (1)-(4) completos e o `{DISPATCH_AT}` definido antes do uso; e o runner
 * roda `--input` e `--apply`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readStage2Playbook } from "../scripts/lib/stage2-playbook.ts";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const skill = read(".claude/skills/diaria-2-escrita/SKILL.md");
const playbook = readStage2Playbook();
const runner = read("scripts/stage-2-run.ts");

const HEADER = "**Descrição do pool a partir do texto lido";

describe("#13952 — writer-pool na Etapa 2", () => {
  it("uma cópia só do passo: no playbook, nenhuma na skill (#14113)", () => {
    assert.equal(playbook.split("\n").filter((l) => l.startsWith(HEADER)).length, 1);
    assert.ok(!skill.includes(HEADER), "a skill não repete a receita do writer-pool");
  });

  it("os passos citam --input, writer-pool e --apply", () => {
    const line = playbook.split("\n").find((l) => l.startsWith(HEADER))!;
    const s = line.slice(line.indexOf("(1) "));
    assert.match(s, /pool-descriptions\.ts --input --edition-dir \{EDITION_DIR\}\//);
    assert.match(s, /`Agent` → `writer-pool`/);
    assert.match(s, /pool-descriptions\.ts --apply --edition-dir \{EDITION_DIR\}\//);
  });

  // #13956: o passo (2) usa `--since {DISPATCH_AT}`; sem definição antes, o
  // placeholder literal faz `parseSince` recusar e o `--apply` nunca roda.
  it("{DISPATCH_AT} é definido (verify-agent-outputs --now) antes de cada uso", () => {
    const DEF = "`npx tsx scripts/verify-agent-outputs.ts --now` → `{DISPATCH_AT}`";
    const def = playbook.indexOf(DEF);
    assert.ok(def >= 0, "{DISPATCH_AT} nunca é definido com verify-agent-outputs.ts --now");
    const uses = [...playbook.matchAll(/--since \{DISPATCH_AT\}/g)].map((m) => m.index!);
    assert.ok(uses.length > 0, "nenhum uso de --since {DISPATCH_AT}");
    for (const u of uses) assert.ok(def < u, `uso de {DISPATCH_AT} na posição ${u} antes da definição (${def})`);
  });

  it("o runner roda o --input no post-writers e o --apply no post-pool, antes dos lints", () => {
    const input = runner.indexOf('"scripts/pool-descriptions.ts", ["--input"');
    const apply = runner.indexOf('"scripts/pool-descriptions.ts", ["--apply"');
    const lint = runner.indexOf('ctx.run("lint-newsletter-md --stage 2"');
    assert.ok(input > 0 && apply > input, "--input (post-writers) antes do --apply (post-pool)");
    assert.ok(lint > apply, "--apply antes do lint-newsletter-md --stage 2");
  });
});
