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
    assert.match(
      section,
      /QUEUE_RAW_JSON=\$\(gh pr list --state open --json number,headRefName,createdAt,isDraft,labels \\\s*\n\s*--jq '\[\.\[\] \| select\(\.headRefName \| startswith\("bot\/"\) \| not\) \| select/,
    );
  });

  it("não sobrou nenhuma outra consulta de fila sem o filtro (a lista de números e a idade derivam do MESMO QUEUE_JSON)", () => {
    const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
    const unfiltered = section.match(/gh pr list --state open --json[^\n]*\n(?!\s*--jq)/g) ?? [];
    assert.deepEqual(unfiltered, [], "há `gh pr list --state open` sem filtro de bot/* na §9");
  });
});

describe("#8862 — PR de resgate (draft + bloqueio-execucao) não conta no alarme de fila parada", () => {
  it("sintaxe bash válida", () => bashSyntaxOk(WATCH_SH));

  it("a consulta da fila (§9) exclui PR draft com label bloqueio-execucao via --jq", () => {
    const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
    assert.match(
      section,
      /select\(\(\.isDraft and \(any\(\.labels\[\]; \.name == "bloqueio-execucao"\)\)\) \| not\)/,
    );
  });

  it("o jq real filtra uma PR draft+bloqueio-execucao (caso #8858), mantendo uma PR normal e removendo bot/*", () => {
    const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
    const match = section.match(/--jq '(\[\.\[\][^\n]*\])'/);
    assert.ok(match, "expressão --jq não encontrada na §9");
    const jqExpr = match![1];

    const input = JSON.stringify([
      {
        number: 8858,
        headRefName: "continuo/rescue-master-x",
        createdAt: "2026-09-26T15:00:00Z",
        isDraft: true,
        labels: [{ name: "bloqueio-execucao" }],
      },
      {
        number: 9000,
        headRefName: "continuo/fix-x",
        createdAt: "2026-09-26T15:00:00Z",
        isDraft: false,
        labels: [],
      },
      {
        number: 9001,
        headRefName: "bot/heatmap",
        createdAt: "2026-09-01T15:00:00Z",
        isDraft: false,
        labels: [],
      },
    ]);
    const res = spawnSync("jq", [jqExpr], { input, encoding: "utf8" });
    assert.equal(res.status, 0, `jq falhou: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(
      out.map((pr: { number: number }) => pr.number),
      [9000],
      "só a PR normal (#9000) deveria sobrar — rescue draft (#8858) e bot/* (#9001) saem",
    );
  });
});

describe("#9031 — PR já escalada (continuo-escalado) não conta no alarme de fila parada", () => {
  it("sintaxe bash válida", () => bashSyntaxOk(WATCH_SH));

  it("o jq real filtra PR escalada draft (#8961) e não-draft (#9004) cuja escalada é posterior ao último commit, mantendo uma PR normal", () => {
    const input = [
      {
        number: 8961,
        headRefName: "overnight/fix-8941-model-mix-opus",
        createdAt: "2026-09-28T15:25:00Z",
        isDraft: true,
        labels: [{ name: "continuo-escalado" }],
        escalatedAt: "2026-09-28T18:00:00Z",
        lastCommitAt: "2026-09-28T15:20:00Z",
      },
      {
        number: 9004,
        headRefName: "fix/template-mensal-imersao-1710",
        createdAt: "2026-09-29T01:50:00Z",
        isDraft: false,
        labels: [{ name: "no-regression-test" }, { name: "continuo-escalado" }],
        escalatedAt: "2026-09-29T03:00:00Z",
        lastCommitAt: "2026-09-29T01:45:00Z",
      },
      {
        number: 9000,
        headRefName: "continuo/fix-x",
        createdAt: "2026-09-26T15:00:00Z",
        isDraft: false,
        labels: [],
      },
    ];
    assert.deepEqual(
      runQueueFilters(input),
      [9000],
      "só a PR normal (#9000) deveria sobrar — as duas escaladas (#8961, #9004) já têm dono e saem",
    );
  });
});

// Extrai as DUAS expressões jq reais da §9 (a da consulta `gh pr list` e o
// filtro de escalada) e roda a sequência completa contra o jq de verdade.
function runQueueFilters(input: object[]): number[] {
  const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
  const listMatch = section.match(/--jq '(\[\.\[\][^\n]*\])'/);
  assert.ok(listMatch, "expressão --jq da consulta gh pr list não encontrada na §9");
  const filterMatch = section.match(/QUEUE_ESCALATION_FILTER='([^'\n]+)'/);
  assert.ok(filterMatch, "QUEUE_ESCALATION_FILTER não encontrado na §9");
  const first = spawnSync("jq", ["-c", listMatch![1]], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(first.status, 0, `jq (lista) falhou: ${first.stderr}`);
  const second = spawnSync("jq", ["-c", filterMatch![1]], { input: first.stdout, encoding: "utf8" });
  assert.equal(second.status, 0, `jq (escalada) falhou: ${second.stderr}`);
  return JSON.parse(second.stdout).map((pr: { number: number }) => pr.number);
}

describe("#9156 — exclusão de continuo-escalado é limitada no tempo (push depois da escalada volta ao alarme)", () => {
  it("sintaxe bash válida", () => bashSyntaxOk(WATCH_SH));

  it("PR escalada + push POSTERIOR à escalada + idade > limiar entra na fila do alarme", () => {
    const out = runQueueFilters([
      {
        number: 9100,
        headRefName: "continuo/fix-ci",
        createdAt: "2026-09-20T10:00:00Z", // muito acima do limiar de 12h
        isDraft: false,
        labels: [{ name: "continuo-escalado" }],
        escalatedAt: "2026-09-20T12:00:00Z", // escalada por CI vermelho
        lastCommitAt: "2026-09-21T09:00:00Z", // consertada por push depois
      },
    ]);
    assert.deepEqual(out, [9100], "PR consertada depois da escalada tem de voltar a contar no alarme");
  });

  it("dado de escalada/commit indisponível = fail-open NA DIREÇÃO DO ALARME (a PR conta)", () => {
    const out = runQueueFilters([
      { number: 9101, headRefName: "a", createdAt: "2026-09-20T10:00:00Z", isDraft: false, labels: [{ name: "continuo-escalado" }] },
      { number: 9102, headRefName: "b", createdAt: "2026-09-20T10:00:00Z", isDraft: false, labels: [{ name: "continuo-escalado" }], escalatedAt: null, lastCommitAt: "2026-09-20T09:00:00Z" },
      { number: 9103, headRefName: "c", createdAt: "2026-09-20T10:00:00Z", isDraft: false, labels: [{ name: "continuo-escalado" }], escalatedAt: "2026-09-20T12:00:00Z", lastCommitAt: null },
    ]);
    assert.deepEqual(out, [9101, 9102, 9103]);
  });

  it("escalada no MESMO instante do último commit continua excluída (>=)", () => {
    const out = runQueueFilters([
      { number: 9104, headRefName: "d", createdAt: "2026-09-20T10:00:00Z", isDraft: false, labels: [{ name: "continuo-escalado" }], escalatedAt: "2026-09-20T12:00:00Z", lastCommitAt: "2026-09-20T12:00:00Z" },
    ]);
    assert.deepEqual(out, []);
  });

  it("o script enriquece só as PRs escaladas com o último evento labeled continuo-escalado e o último commit", () => {
    const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
    assert.match(section, /gh api "repos\/\{owner\}\/\{repo\}\/issues\/\$EN\/events" --paginate/);
    assert.match(section, /select\(\.event == "labeled" and \.label\.name == "continuo-escalado"\) \| \.created_at' 2>\/dev\/null \| tail -n 1\)/);
    // data do commit HEAD, nunca `.commits[-1]` (gh pr view traz só os 100 primeiros)
    assert.match(section, /gh pr view "\$EN" --json headRefOid/);
    assert.match(section, /gh api "repos\/\{owner\}\/\{repo\}\/commits\/\$HEAD_SHA_Q" --jq '\.commit\.committer\.date \/\/ empty'/);
    assert.doesNotMatch(section, /\.commits\[-1\]/);
    // merge + filtro aplicados ao QUEUE_JSON que alimenta contagem, idade e listas
    assert.match(section, /QUEUE_JSON=\$\(printf '%s' "\$QUEUE_RAW_JSON" \| jq -c --argjson enrich "\$QUEUE_ENRICH" "\$QUEUE_ENRICH_MERGE"[\s\S]{0,120}jq -c "\$QUEUE_ESCALATION_FILTER"/);
  });

  it("o merge real do mapa de enriquecimento (chave string × .number numérico) alimenta o filtro", () => {
    const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
    const mergeMatch = section.match(/QUEUE_ENRICH_MERGE='([^'\n]+)'/);
    const filterMatch = section.match(/QUEUE_ESCALATION_FILTER='([^'\n]+)'/);
    assert.ok(mergeMatch && filterMatch, "QUEUE_ENRICH_MERGE/QUEUE_ESCALATION_FILTER não encontrados");
    const raw = [
      { number: 1, headRefName: "a", createdAt: "2026-09-20T00:00:00Z", isDraft: false, labels: [{ name: "continuo-escalado" }] },
      { number: 2, headRefName: "b", createdAt: "2026-09-20T00:00:00Z", isDraft: false, labels: [{ name: "continuo-escalado" }] },
      { number: 3, headRefName: "c", createdAt: "2026-09-20T00:00:00Z", isDraft: false, labels: [] },
    ];
    const enrich = {
      "1": { escalatedAt: "2026-09-20T05:00:00Z", lastCommitAt: "2026-09-21T00:00:00Z" }, // push depois → conta
      "2": { escalatedAt: "2026-09-20T05:00:00Z", lastCommitAt: "2026-09-20T01:00:00Z" }, // escalada vigente → sai
    };
    const merged = spawnSync("jq", ["-c", "--argjson", "enrich", JSON.stringify(enrich), mergeMatch![1]], { input: JSON.stringify(raw), encoding: "utf8" });
    assert.equal(merged.status, 0, `jq (merge) falhou: ${merged.stderr}`);
    const filtered = spawnSync("jq", ["-c", filterMatch![1]], { input: merged.stdout, encoding: "utf8" });
    assert.equal(filtered.status, 0, `jq (filtro) falhou: ${filtered.stderr}`);
    assert.deepEqual(JSON.parse(filtered.stdout).map((p: { number: number }) => p.number), [1, 3]);
  });

  it("falha do filtro de escalada tem mensagem própria (não se passa por falha do gh pr list)", () => {
    const section = watch.slice(watch.indexOf("QUEUE_COUNT_THRESHOLD=5"));
    assert.match(section, /INDETERMINADO \(filtro de escalada #9156 falhou\)/);
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
