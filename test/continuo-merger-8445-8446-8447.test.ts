import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_SH = join(ROOT, "hermes", "scripts", "continuo-pr-review.sh");
const WATCH_SH = join(ROOT, "hermes", "scripts", "watch-continuo-health.sh");
const review = readFileSync(REVIEW_SH, "utf8");
const watch = readFileSync(WATCH_SH, "utf8");

function bashSyntaxOk(path: string): void {
  const res = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  assert.equal(res.status, 0, `bash -n falhou em ${path}: ${res.stderr}`);
}

describe("#8445 — PR com review de SHA antigo é re-revisada, não empurrada pro gate", () => {
  it("sintaxe bash válida", () => bashSyntaxOk(REVIEW_SH));

  it("o atalho 'já com review' consulta a obsolescência ANTES de ir ao portão de merge", () => {
    const authBlock = review.slice(review.indexOf('AUTH_OUT=$(npx tsx scripts/check-pr-review-authenticity.ts'));
    const staleCall = authBlock.indexOf("npx tsx scripts/check-continuo-review-stale.ts");
    // ancorado no `echo` real — o mesmo texto também aparece em comentários do cabeçalho
    const shortcut = authBlock.indexOf('echo "[continuo-pr-review] PR #$PR: já com review — direto ao merge"');
    assert.ok(staleCall > 0, "o atalho não chama check-continuo-review-stale.ts");
    assert.ok(shortcut > 0, "echo do atalho direto-ao-merge não encontrado");
    assert.ok(staleCall < shortcut, "a checagem de obsolescência tem de vir antes do atalho direto-ao-merge");
  });

  it("stale (exit 1) rebaixa AUTH_RC pra 1 (cai no caminho de review real); qualquer outro rc mantém o atalho", () => {
    // 10, nunca 1: o Node sai 1 em qualquer exceção não tratada (review da PR #8451)
    assert.match(review, /if \[ "\$STALE_RC" -eq 10 \]; then[\s\S]{0,500}AUTH_RC=1/);
    assert.doesNotMatch(review, /"\$STALE_RC" -eq 1 \]/, "reagir a exit 1 confunde crash do checker com stale");
    // o atalho vive no `else` — fresh/unknown/infra não re-revisam (sem laço de custo)
    assert.match(review, /AUTH_RC=1\s*\n\s*else[\s\S]{0,700}try_merge_gate "\$PR"\s*\n\s*continue/);
  });

  it("o caminho de review real não tem filtro de label que anule o re-review de PR já escalada/rejeitada", () => {
    const realReview = review.slice(review.indexOf("# AUTH_RC 1 (self_review) ou 2 (no_review)"));
    assert.doesNotMatch(realReview, /continuo-escalado|continuo-rejeitado/, "um filtro por label reintroduziria o deadlock");
  });
});

describe("#8446 — escalada reincidente vira sinal, não repetição muda", () => {
  it("'já sinalizada' incrementa o contador de reincidentes e guarda a PR", () => {
    assert.match(
      review,
      /escalate \(já sinalizada\)"\s*\n\s*ESCALATED_RECURRING=\$\(\(ESCALATED_RECURRING \+ 1\)\)\s*\n\s*ESCALATED_RECURRING_PRS="\$ESCALATED_RECURRING_PRS #\$pr"/,
    );
  });

  it("os contadores são inicializados (set -u não pode quebrar o tick)", () => {
    assert.match(review, /^ESCALATED_RECURRING=0$/m);
    assert.match(review, /^ESCALATED_RECURRING_PRS=""$/m);
  });

  it("o resumo do tick emite linha ATENÇÃO própria só quando há reincidentes, listando as PRs", () => {
    assert.match(review, /if \[ "\$ESCALATED_RECURRING" -gt 0 \]; then\s*\n\s*echo "\[continuo-pr-review\] ATENÇÃO:[^"]*\$ESCALATED_RECURRING_PRS/);
  });

  it("a linha 'fim —' original é preservada (consumidores existentes não quebram)", () => {
    assert.match(review, /fim — revisadas=\$REVIEWED mergeadas=\$MERGED escaladas=\$ESCALATED rejeitadas=\$REJECTED/);
  });
});

describe("#8447 — PR bot/* não conta no alarme de fila parada", () => {
  it("sintaxe bash válida", () => bashSyntaxOk(WATCH_SH));

  it("a consulta da fila (§9) exclui bot/* via --jq do próprio gh", () => {
    const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
    assert.match(section, /QUEUE_JSON=\$\(gh pr list --state open --json number,headRefName,createdAt \\\s*\n\s*--jq '\[\.\[\] \| select\(\.headRefName \| startswith\("bot\/"\) \| not\)\]'/);
  });

  it("não sobrou nenhuma outra consulta de fila sem o filtro (a lista de números e a idade derivam do MESMO QUEUE_JSON)", () => {
    const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
    const unfiltered = section.match(/gh pr list --state open --json[^\n]*\n(?!\s*--jq)/g) ?? [];
    assert.deepEqual(unfiltered, [], "há `gh pr list --state open` sem filtro de bot/* na §9");
  });
});
