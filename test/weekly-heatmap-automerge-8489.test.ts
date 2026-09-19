/**
 * test/weekly-heatmap-automerge-8489.test.ts (#8489)
 *
 * Guard do achado do #8489: a PR semanal do `weekly-bug-heatmap.yml` (regen
 * de `docs/bug-heatmap.md`, #1014) era aberta e nunca fechada por ninguém —
 * PR de bot é exceção da regra "1 PR aberto por vez" do CLAUDE.md, e
 * overnight/develop trabalham fila de ISSUES, não PRs de bot. A #8332 ficou
 * aberta dias com `MERGEABLE`/`CLEAN` e 14 checks verdes, sem nada que a
 * drenasse. O conserto é o próprio workflow mergear após os checks.
 *
 * O que este guard protege, além da presença do passo — os 3 modos de falha
 * SILENCIOSA desse desenho:
 *
 * 1. `id: cpr` sumir do passo `create-pull-request`: o `if:` do passo de
 *    merge passa a avaliar `steps.cpr.outputs.*` como string vazia, o passo
 *    é PULADO e o workflow segue VERDE — a fila volta a encher sem nenhum
 *    sinal vermelho. Por isso o teste casa o id declarado no passo com o id
 *    usado na expressão, em vez de checar cada um isolado.
 * 2. Trocar o par (espera + merge) por `gh pr merge --auto`: a ruleset
 *    `Protect main branch` NÃO exige status check nenhum (exige só PR,
 *    medido em 19/09/2026), então o auto-merge do GitHub mergearia na hora,
 *    antes de "PR Checks" rodar — perdendo exatamente a verificação que
 *    justifica não commitar direto em master.
 * 3. Inverter a ordem dentro do script: mergear antes de observar os checks
 *    tem o mesmo efeito do item 2, e continua "tendo um --watch" pra quem
 *    só procura a substring.
 *
 * Parsing por regex sobre o texto bruto do YAML, mesmo padrão de
 * `ci-workflow-concurrency-group.test.ts` e `pr-checks-guards-wired.test.ts`
 * (o repo não tem dependência de parser YAML).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = resolve(ROOT, ".github", "workflows", "weekly-bug-heatmap.yml");

/** Fatia o YAML nos itens da lista `steps:` (indentação de 6 espaços, o
 *  nível usado por este workflow) pra poder afirmar coisas sobre UM passo
 *  sem que texto de outro passo satisfaça o assert por acidente. */
function extractSteps(yamlText: string): string[] {
  // Comentários fora: a prosa que explica ESTE guard cita `gh pr merge
  // --auto` e `gh pr checks`, e um comentário acima de um passo pertence
  // textualmente ao passo ANTERIOR — sem tirar, o assert casaria com a
  // explicação em vez do comando real (foi o 1º modo de falha deste
  // próprio teste, ao ser escrito).
  const lines = yamlText.split("\n").filter((l) => !/^\s*#/.test(l));
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^ {6}- /.test(line)) starts.push(i);
  });
  assert.ok(starts.length > 0, "nenhum passo encontrado em weekly-bug-heatmap.yml");
  return starts.map((start, idx) => lines.slice(start, starts[idx + 1] ?? lines.length).join("\n"));
}

const yamlText = readFileSync(WORKFLOW_PATH, "utf8");
const steps = extractSteps(yamlText);
const prStep = steps.find((s) => /uses:\s*peter-evans\/create-pull-request/.test(s));
const mergeStep = steps.find((s) => /gh pr merge/.test(s));

describe("weekly-bug-heatmap.yml: a PR semanal se fecha sozinha (#8489)", () => {
  it("existe um passo que mergeia a PR criada", () => {
    assert.ok(prStep, "passo create-pull-request não encontrado");
    assert.ok(
      mergeStep,
      "nenhum passo roda 'gh pr merge' — a PR semanal volta a ficar aberta pra sempre (#8489)",
    );
  });

  it("o id do passo create-pull-request casa com o id usado na expressão do merge (desalinhar PULA o merge em silêncio, workflow verde)", () => {
    const id = prStep!.match(/^\s*id:\s*(\S+)\s*$/m)?.[1];
    assert.ok(
      id,
      "passo create-pull-request perdeu o 'id:' — steps.<id>.outputs vira vazio e o merge é pulado sem falhar",
    );
    assert.match(
      mergeStep!,
      new RegExp(`steps\.${id}\.outputs\.pull-request-number`),
      `o passo de merge deve referenciar steps.${id}.outputs.pull-request-number`,
    );
  });

  it("o merge é condicionado à PR ter sido criada de fato (semana sem mudança não deve tentar mergear nada)", () => {
    assert.match(
      mergeStep!,
      /^\s*if:\s*steps\.\S+\.outputs\.pull-request-number\s*!=\s*''\s*$/m,
      "sem o if:, a semana em que o heatmap não muda roda 'gh pr merge' com PR vazia e falha o workflow",
    );
  });

  it("não usa 'gh pr merge --auto' (a ruleset de master não exige check nenhum — o auto-merge mergearia antes do CI rodar)", () => {
    assert.doesNotMatch(
      mergeStep!,
      /gh pr merge[^\n]*--auto/,
      "--auto mergeia na hora porque nenhum status check é obrigatório na ruleset; use a espera explícita (#8489)",
    );
  });

  it("observa os checks ANTES de mergear — ordem invertida mergearia sem verificação", () => {
    const watchIdx = mergeStep!.search(/gh pr checks[^\n]*--watch/);
    const mergeIdx = mergeStep!.search(/gh pr merge/);
    assert.notEqual(watchIdx, -1, "o passo deve esperar os checks com 'gh pr checks --watch'");
    assert.ok(
      watchIdx < mergeIdx,
      "'gh pr checks --watch' deve vir ANTES do 'gh pr merge' — invertido, a PR mergeia sem verificação",
    );
  });

  it("o workflow tem concurrency group (2 runs sobrepostos disputariam a MESMA PR agora que o merge é automático)", () => {
    // Antes do merge automático, sobreposição entre o cron e um
    // workflow_dispatch manual só duplicava push no branch fixo
    // `bot/heatmap-weekly-regen` — chato e inofensivo. Com o merge no
    // próprio workflow, os dois runs passam a disputar a mesma PR.
    assert.match(
      yamlText,
      new RegExp("^concurrency:\\s+group:\\s*\\S+", "m"),
      "workflow perdeu o bloco concurrency: (review do PR #8491, finding 3)",
    );
  });

  it("o passo de merge não sobrescreve o shell (o bash -e default é o que aborta o merge quando o check falha)", () => {
    assert.doesNotMatch(
      mergeStep!,
      /^\s*shell:\s*/m,
      "shell customizado pode perder o -e e deixar o 'gh pr merge' rodar mesmo com check vermelho",
    );
  });
});
