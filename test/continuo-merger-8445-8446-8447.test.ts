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

  it("stale (exit 10) rebaixa AUTH_RC pra 1 (cai no caminho de review real); qualquer outro rc mantém o atalho", () => {
    // 10, nunca 1: o Node sai 1 em qualquer exceção não tratada (review da PR #8451)
    assert.match(review, /if \[ "\$STALE_RC" -eq 10 \]; then[\s\S]{0,500}AUTH_RC=1/);
    assert.doesNotMatch(review, /"\$STALE_RC" -eq 1 \]/, "reagir a exit 1 confunde crash do checker com stale");
    // o atalho vive no `else` — fresh/unknown/infra não re-revisam (sem laço de custo)
    assert.match(review, /AUTH_RC=1\s*\n\s*else[\s\S]{0,700}try_merge_gate "\$PR"\s*\n\s*continue/);
  });

  it("o caminho de review real não tem filtro de label que anule o re-review de PR já escalada/rejeitada", () => {
    // A fatia termina no fim do laço `for PR` (marcador do bloco de entrega),
    // não no fim do arquivo: o que este guard proíbe é um filtro por label
    // DENTRO do caminho de review. O bloco de entrega que vem depois do laço
    // só monta a mensagem do Telegram, e cita os nomes dos labels pra o
    // editor achar a PR — citar não é filtrar, e sem este limite o guard
    // reprovaria a própria menção (achado ao vivo, 19/09/2026).
    const start = review.indexOf("# AUTH_RC 1 (self_review) ou 2 (no_review)");
    const end = review.indexOf("# Entrega SÓ QUANDO HÁ PROBLEMA");
    assert.ok(start > 0, "âncora de início do caminho de review real não encontrada");
    assert.ok(end > start, "âncora de fim (bloco de entrega) não encontrada depois do início");
    const realReview = review.slice(start, end);
    assert.doesNotMatch(realReview, /continuo-escalado|continuo-rejeitado/, "um filtro por label reintroduziria o deadlock");
  });
});

describe("#8446 — escalada reincidente vira sinal, não repetição muda", () => {
  it("'já sinalizada' incrementa o contador de reincidentes e guarda a PR", () => {
    assert.match(
      review,
      // `( >&2)?`: a linha de log virou stderr quando a entrega do cron passou
      // a só falar havendo problema (19/09/2026). O invariante deste guard é a
      // ADJACÊNCIA — log da reincidência e incremento do contador andam juntos
      // —, não o canal em que o log sai.
      /escalate \(já sinalizada\)"( >&2)?\s*\n\s*ESCALATED_RECURRING=\$\(\(ESCALATED_RECURRING \+ 1\)\)\s*\n\s*ESCALATED_RECURRING_PRS="\$ESCALATED_RECURRING_PRS #\$pr"/,
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

describe("#8445 — a verificação automática está LIGADA (não depende de alguém lembrar)", () => {
  it("watch-continuo-health.sh chama o detector e abre issue P1 no alarme", () => {
    assert.match(watch, /check-continuo-stale-review-health\.ts --json/);
    assert.match(watch, /file_issue "\[watch-continuo\] review obsoleto sem resolução"[\s\S]{0,400}"bug,P1"/);
  });

  it("a seção 14 roda ANTES do fim da varredura (senão nunca executa) e indeterminate não alarma", () => {
    const sec = watch.indexOf("# ── 14. review obsoleto");
    // #8454: a linha final virou `note` (log, não stdout) — rotina "ok"/
    // "indeterminado" nunca mais é `echo` puro, mesmo padrão das outras 13
    // seções (só `file_issue`/FAILS chegam ao stdout do tick limpo).
    const end = watch.indexOf('note "[watch] varredura concluída');
    assert.ok(sec > 0 && sec < end, "seção 14 tem de vir antes do 'varredura concluída'");
    assert.match(watch.slice(sec, end), /indeterminate" \]; then\s*\n\s*note "\[watch\] review obsoleto: indeterminado[^"]*não alarma/);
  });
});

describe("#8445 — dedup da seção 14 (guard #6771: marcador precisa ser substring do título)", () => {
  it("o marcador do file_issue da seção 14 está contido no título criado pela MESMA chamada", () => {
    const m = watch.match(/file_issue "(\[watch-continuo\] review obsoleto sem resolução)" \\s*\n\s*"([^"]+)"/);
    assert.ok(m, "chamada file_issue da seção 14 não encontrada");
    assert.ok(m![2].includes(m![1]), `marcador "${m![1]}" ausente do título "${m![2]}" — have_issue nunca acharia a issue criada e o watch duplicaria a cada corrida`);
  });
});
