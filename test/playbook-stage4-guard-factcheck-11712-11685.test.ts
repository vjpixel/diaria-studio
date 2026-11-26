/**
 * #11712 / #11685 — resíduo de playbook (a lib já foi mergeada nas PRs #11716 e #11717).
 *
 * Agent prompt não tem teste comportamental; este arquivo trava a presença e a
 * ORDEM das instruções, e que o marcador citado no playbook é o mesmo que o
 * script imprime (sem isso o playbook e o código derivam em silêncio).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readStage4Playbook } from "../scripts/lib/stage4-playbook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const stage2 = read(".claude/agents/orchestrator-stage-2.md");
const stage4 = readStage4Playbook();
const factChecker = read("scripts/run-fact-checker.ts");

/** Linha do bullet de exit `n` da pré-condição do Stage 3 (antes do §4a). */
function stage3PreconditionBullet(n: number): string {
  const pre = stage4.slice(0, stage4.indexOf("### 4a."));
  const line = pre.split("\n").find((l) => l.startsWith(`- \`${n}\` →`));
  assert.ok(line, `bullet do exit ${n} da pré-condição do Stage 3 não encontrado`);
  return line;
}

describe("Stage 4: pré-condição do Stage 3 passa pelo guard antes do FATAL (#11712)", () => {
  it("exit 1 roda o guard --step 3 antes de mandar re-rodar /diaria-3-imagens", () => {
    const l = stage3PreconditionBullet(1);
    const guard = l.indexOf("stale-edition-guard.ts check --edition-dir {EDITION_DIR} --step 3`");
    const fatal = l.indexOf("Re-rodar `/diaria-3-imagens");
    assert.ok(guard >= 0, "guard --step 3 ausente no exit 1");
    assert.ok(fatal > guard, "FATAL antes do guard no exit 1");
    assert.match(l, /exit 4 .*halt banner/);
    assert.match(l, /Qualquer outro exit ≠ 0 \(2, crash\) = mesmo halt/);
    assert.match(l, /--force/);
  });
  it("exit 2 roda o guard --step 3 --outputs-missing antes do FATAL", () => {
    const l = stage3PreconditionBullet(2);
    const guard = l.indexOf("stale-edition-guard.ts check --edition-dir {EDITION_DIR} --step 3 --outputs-missing");
    const fatal = l.indexOf("Outputs do Stage 3 ausentes");
    assert.ok(guard >= 0, "guard --step 3 --outputs-missing ausente no exit 2");
    assert.ok(fatal > guard, "FATAL antes do guard no exit 2");
    assert.match(l, /Qualquer outro exit ≠ 0 \(2, crash\) = mesmo halt/);
  });
});

describe("Stage 2: Clarice sem sugestões no social usa --note (#11685 item 2)", () => {
  it("o --note aparece depois do --record-run --step clarice do social e antes do --write", () => {
    const record = stage2.indexOf("--record-run --step clarice --pre {EDITION_DIR}/_internal/03-social-post-humanizador.md");
    const note = stage2.indexOf('--note "Clarice sem sugestões"', record);
    const write = stage2.indexOf("check-humanizer-social.ts --write", record);
    assert.ok(record >= 0, "registro da Clarice do social ausente no Stage 2");
    assert.ok(note > record, "--note ausente depois do registro da Clarice");
    assert.ok(write > record, "--write ausente");
    assert.ok(note < write, "--note precisa vir antes do --write");
  });
});

// Desde o #14116 o passo 2 de §4c.6 é o composto `stage4-factcheck-post.ts`,
// que traduz o "exit 1 + FACT-CHECK DEFASADO" do `--check-blocking` para o
// exit próprio `3` (OUTCOME_EXIT.stale). O contrato do #11685 é o mesmo:
// defasado → re-despachar o fact-checker; o exit 1 restante é "indisponível".
describe("Stage 4 §4c.6: fact-check DEFASADO re-despacha o fact-checker (#11685 item 1, exit 3 do composto #14116)", () => {
  const marker = "FACT-CHECK DEFASADO (#11685)";
  const compound = read("scripts/stage4-factcheck-post.ts");
  it("o marcador do playbook é o que o script imprime e o que o composto reconhece", () => {
    assert.ok(factChecker.includes(marker), "run-fact-checker.ts não imprime mais o marcador");
    assert.ok(compound.includes(`"${marker}"`), "stage4-factcheck-post.ts não reconhece mais o marcador");
    assert.match(compound, /\bstale: 3,/, "composto não mapeia mais DEFASADO (stale) para o exit 3");
  });
  it("§4c.6 trata o DEFASADO (exit 3) como re-despacho, não como indisponível", () => {
    const sec = stage4.slice(stage4.indexOf("**4c.6 — Fact-check"), stage4.indexOf("**4c.6b —"));
    const lines = sec.split("\n");
    const bullet = lines.find((l) => l.startsWith("- `3`") && l.includes(marker));
    assert.ok(bullet, "bullet do exit 3 DEFASADO ausente em §4c.6");
    assert.match(bullet, /não é o "indisponível" comum/);
    assert.match(bullet, /re-despachar o subagente `fact-checker`/);
    assert.match(bullet, /NÃO montar o gate ainda/);
    // re-despacho limitado a 1 tentativa, sem loop; falha de dispatch cai no #8996
    assert.match(bullet, /uma única vez/);
    assert.match(bullet, /Fact-check defasado — verificar manualmente/);
    assert.match(bullet, /#8996/);
    // o exit 1 que sobra é o indisponível, e não carrega o marcador
    const exit1 = lines.find((l) => l.startsWith("- `1`"));
    assert.ok(exit1?.includes("Fact-check indisponível"), "exit 1 deixou de ser o indisponível");
    assert.ok(!exit1?.includes(marker), "exit 1 voltou a citar o DEFASADO");
    const exit2 = lines.find((l) => l.startsWith("- `2` →"));
    assert.ok(exit2?.includes("até o composto sair `0` ou `1`"), "exit 2 não exclui o DEFASADO (exit 3)");
    // em --no-gates não segue para a Etapa 5
    const noGates = sec.slice(sec.indexOf("**Comportamento em `auto_approve = true`"));
    assert.match(noGates, /exit 3 \(DEFASADO\) também vale aqui/, "parágrafo --no-gates não cita o DEFASADO");
    assert.match(noGates, /halt banner em vez de seguir para a Etapa 5/);
  });
});
