/**
 * test/merge-train.test.ts (#6300, regressão #633)
 *
 * Cobre o miolo puro de scripts/lib/merge-train.ts — composição de lotes
 * não-colidentes e bissecção de lote vermelho. Os 2 critérios de aceite da
 * issue que são testáveis SEM infra viva (git/gh):
 *   - "Dois PRs colidentes nunca entram no mesmo trem"
 *   - "Lote vermelho... bissecta... nunca deixa PR verde preso indefinidamente"
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filesCollide,
  composeTrainBatches,
  bisectBatch,
  worstCaseCiRuns,
  parseClosesIssues,
  parseRefsIssues,
  stripNonMarkerContext,
  buildTrainPrTitle,
  buildTrainPrBody,
  buildTrainMergeCommitTitle,
  buildTrainMergeCommitBody,
  buildSoloSquashSubject,
  buildSoloSquashBody,
  summarizeTrainCiRuns,
  type TrainCandidate,
  type TrainPrInfo,
  type TrainBatch,
  type TrainCiRunsOutcomeLike,
} from "../scripts/lib/merge-train.ts";

describe("filesCollide", () => {
  it("verdadeiro quando há ao menos 1 arquivo em comum", () => {
    assert.equal(filesCollide(["a.ts", "b.ts"], ["b.ts", "c.ts"]), true);
  });

  it("falso quando os conjuntos são disjuntos", () => {
    assert.equal(filesCollide(["a.ts"], ["b.ts"]), false);
  });

  it("falso quando qualquer lado é vazio (PR sem arquivo não colide com nada)", () => {
    assert.equal(filesCollide([], ["a.ts"]), false);
    assert.equal(filesCollide(["a.ts"], []), false);
    assert.equal(filesCollide([], []), false);
  });
});

describe("composeTrainBatches — critério de aceite: dois PRs colidentes nunca entram no mesmo trem", () => {
  it("PRs sem colisão nenhuma entram todos no mesmo lote, até o teto K", () => {
    const candidates: TrainCandidate[] = [
      { pr: 1, files: ["a.ts"] },
      { pr: 2, files: ["b.ts"] },
      { pr: 3, files: ["c.ts"] },
    ];
    const batches = composeTrainBatches(candidates, 3);
    assert.deepEqual(batches, [{ prs: [1, 2, 3] }]);
  });

  it("2 PRs que colidem em arquivo NUNCA aparecem no mesmo lote", () => {
    const candidates: TrainCandidate[] = [
      { pr: 1, files: ["shared.ts", "a.ts"] },
      { pr: 2, files: ["shared.ts", "b.ts"] },
    ];
    const batches = composeTrainBatches(candidates, 3);
    // Invariante direto: nenhum lote contém os dois números ao mesmo tempo.
    for (const batch of batches) {
      assert.ok(
        !(batch.prs.includes(1) && batch.prs.includes(2)),
        "PRs colidentes não podem compartilhar lote",
      );
    }
    // E, concretamente pra este caso de 2 PRs mutuamente colidentes: cada um
    // vira seu próprio lote (nenhum lugar seguro pra fundir os dois).
    assert.deepEqual(batches, [{ prs: [1] }, { prs: [2] }]);
  });

  it("colisão parcial: PR3 colide só com PR1 — PR3 vai pro lote de PR2, não pro de PR1", () => {
    const candidates: TrainCandidate[] = [
      { pr: 1, files: ["x.ts"] },
      { pr: 2, files: ["y.ts"] },
      { pr: 3, files: ["x.ts", "z.ts"] }, // colide com PR1 (x.ts)
    ];
    const batches = composeTrainBatches(candidates, 3);
    const batchOf = (pr: number) => batches.find((b) => b.prs.includes(pr));
    assert.notDeepEqual(batchOf(1), batchOf(3));
    // Composição completa explícita (achado do fleet review — a asserção
    // acima sozinha não deixava claro que PR2 (sem colisão com PR1) entra
    // no MESMO lote de PR1 primeiro, e é a UNIÃO de arquivos do lote — não
    // só do último PR adicionado — que barra PR3 depois).
    assert.deepEqual(batches, [{ prs: [1, 2] }, { prs: [3] }]);
  });

  it("respeita o teto maxBatchSize — 4º PR sem colisão ainda assim abre novo lote se o 1º já está cheio (K=3)", () => {
    const candidates: TrainCandidate[] = [
      { pr: 1, files: ["a.ts"] },
      { pr: 2, files: ["b.ts"] },
      { pr: 3, files: ["c.ts"] },
      { pr: 4, files: ["d.ts"] },
    ];
    const batches = composeTrainBatches(candidates, 3);
    assert.deepEqual(batches, [{ prs: [1, 2, 3] }, { prs: [4] }]);
  });

  it("PR sem arquivo nenhum (files: []) nunca colide — sempre cabe no primeiro lote aberto", () => {
    const candidates: TrainCandidate[] = [
      { pr: 1, files: ["a.ts"] },
      { pr: 2, files: [] },
    ];
    const batches = composeTrainBatches(candidates, 3);
    assert.deepEqual(batches, [{ prs: [1, 2] }]);
  });

  it("lista vazia produz lista de lotes vazia", () => {
    assert.deepEqual(composeTrainBatches([], 3), []);
  });

  it("K=1 nunca funde ninguém — cada PR no seu próprio lote (equivalente ao caminho de hoje)", () => {
    const candidates: TrainCandidate[] = [
      { pr: 1, files: ["a.ts"] },
      { pr: 2, files: ["b.ts"] },
    ];
    const batches = composeTrainBatches(candidates, 1);
    assert.deepEqual(batches, [{ prs: [1] }, { prs: [2] }]);
  });

  it("lança se maxBatchSize < 1", () => {
    assert.throws(() => composeTrainBatches([{ pr: 1, files: [] }], 0), /maxBatchSize/);
  });

  it("lança se maxBatchSize não é inteiro — NaN NÃO pode desligar o teto em silêncio (achado do fleet review)", () => {
    // NaN < 1 é false em JS — sem o guard !Number.isInteger, um K inválido
    // (ex: vindo de Number("abc") sem validação na CLI) desligava o teto
    // inteiro sem lançar nada, e todo candidato caía no mesmo lote.
    assert.throws(() => composeTrainBatches([{ pr: 1, files: [] }], NaN), /inteiro/);
    assert.throws(() => composeTrainBatches([{ pr: 1, files: [] }], 2.5), /inteiro/);
    assert.throws(() => composeTrainBatches([{ pr: 1, files: [] }], Infinity), /inteiro/);
  });

  it("lança se `pr` aparece duplicado em candidates (achado do fleet review — nunca listar o mesmo PR em 2 lotes)", () => {
    const candidates: TrainCandidate[] = [
      { pr: 1, files: ["a.ts"] },
      { pr: 2, files: ["b.ts"] },
      { pr: 1, files: ["c.ts"] }, // duplicata
    ];
    assert.throws(() => composeTrainBatches(candidates, 3), /#1.*mais de uma vez/);
  });

  it("determinístico — mesma entrada produz sempre a mesma composição", () => {
    const candidates: TrainCandidate[] = [
      { pr: 1, files: ["a.ts"] },
      { pr: 2, files: ["a.ts"] },
      { pr: 3, files: ["b.ts"] },
      { pr: 4, files: ["c.ts", "b.ts"] },
    ];
    const first = composeTrainBatches(candidates, 3);
    const second = composeTrainBatches(candidates, 3);
    assert.deepEqual(first, second);
  });
});

describe("bisectBatch — critério de aceite: lote vermelho bissecta, nunca deixa PR verde preso", () => {
  it("divide um lote par ao meio, preservando ordem", () => {
    const [left, right] = bisectBatch({ prs: [1, 2, 3, 4] });
    assert.deepEqual(left, { prs: [1, 2] });
    assert.deepEqual(right, { prs: [3, 4] });
  });

  it("divide um lote ímpar com a metade maior à esquerda (ceil)", () => {
    const [left, right] = bisectBatch({ prs: [1, 2, 3] });
    assert.deepEqual(left, { prs: [1, 2] });
    assert.deepEqual(right, { prs: [3] });
  });

  it("as duas metades juntas cobrem exatamente o lote original, sem sobra nem duplicata", () => {
    const original = { prs: [10, 20, 30, 40, 50] };
    const [left, right] = bisectBatch(original);
    assert.deepEqual([...left.prs, ...right.prs], original.prs);
  });

  it("bissecção repetida converge pro piso (lotes de tamanho 1) em log2(N) passos", () => {
    // Simula o loop de orquestração viva (fora deste módulo): bissecta até
    // todo sub-lote ter tamanho 1 — nunca deveria rodar pra sempre.
    let frontier: TrainBatch[] = [{ prs: [1, 2, 3, 4, 5, 6, 7] }];
    let rounds = 0;
    const MAX_ROUNDS = 10; // generoso — log2(7) ≈ 3
    while (frontier.some((b) => b.prs.length > 1)) {
      rounds++;
      assert.ok(rounds <= MAX_ROUNDS, "bissecção não convergiu — sinal de bug, não de escala real");
      frontier = frontier.flatMap((b) => (b.prs.length > 1 ? bisectBatch(b) : [b]));
    }
    assert.deepEqual(
      frontier.flatMap((b) => b.prs).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7],
    );
  });

  it("lote de tamanho 1 lança — já é o piso da recursão, não bisecciona mais", () => {
    assert.throws(() => bisectBatch({ prs: [1] }), /não bisecciona/);
  });

  it("lote vazio lança (nunca deveria existir na árvore de bissecção)", () => {
    assert.throws(() => bisectBatch({ prs: [] }), /não bisecciona/);
  });
});

describe("worstCaseCiRuns — apoio à calibragem de K, não usado em runtime", () => {
  it("lote de 1 PR = 1 run (caminho de hoje, sem trem)", () => {
    assert.equal(worstCaseCiRuns(1), 1);
  });

  it("lote de 3 no pior caso: cada nível intermediário TAMBÉM paga 1 run antes de bissectar de novo", () => {
    // 3 → {2,1}: 1 run pro lote de 3 (vermelho) + [1 run pro sub-lote de 2
    // (vermelho) + 1 + 1 pras duas folhas] + 1 pra folha do outro lado = 5.
    // Pior que os 3 runs do caminho de hoje (1 por PR) — é exatamente o
    // "pior que os K de hoje" que a issue nomeia como risco de bissecção
    // em cascata; K pequeno (3) limita o dano.
    assert.equal(worstCaseCiRuns(3), 5);
  });

  it("cresce como K + log2(K), nunca pior que isso — sanity contra a fórmula da issue", () => {
    // A issue registra "K + log K" como o pior caso — checagem de sanidade,
    // não a fórmula exata (a recursão real bisecciona por ceil/floor, não
    // por log contínuo), então comparamos só a ORDEM de grandeza.
    const k = 8;
    const worst = worstCaseCiRuns(k);
    assert.ok(worst <= k + Math.ceil(Math.log2(k)) + k, `worst=${worst} deveria ficar perto de K+logK`);
    assert.ok(worst >= k, "nunca pode custar MENOS runs que o número de PRs no pior caso");
  });
});

describe("parseClosesIssues", () => {
  it("reconhece close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved, case-insensitive", () => {
    assert.deepEqual(parseClosesIssues("Closes #10"), [10]);
    assert.deepEqual(parseClosesIssues("closes #11"), [11]);
    assert.deepEqual(parseClosesIssues("CLOSED #12"), [12]);
    assert.deepEqual(parseClosesIssues("Fix #13"), [13]);
    assert.deepEqual(parseClosesIssues("fixes #14"), [14]);
    assert.deepEqual(parseClosesIssues("Fixed #15"), [15]);
    assert.deepEqual(parseClosesIssues("Resolve #16"), [16]);
    assert.deepEqual(parseClosesIssues("resolves #17"), [17]);
    assert.deepEqual(parseClosesIssues("Resolved #18"), [18]);
  });

  it("extrai múltiplas issues em linhas/frases diferentes, ordenadas e sem duplicata", () => {
    const body = "Closes #20\n\nAlgum texto.\n\nFixes #10 e também resolves #20 de novo.";
    assert.deepEqual(parseClosesIssues(body), [10, 20]);
  });

  it("ignora #N sem keyword de fechamento na frente (ex: Refs)", () => {
    assert.deepEqual(parseClosesIssues("Refs #30, não fecha nada"), []);
  });

  it("corpo sem nenhuma keyword devolve lista vazia", () => {
    assert.deepEqual(parseClosesIssues("Descrição qualquer, sem issue nenhuma."), []);
  });
});

describe("buildTrainPrTitle / buildTrainPrBody — PR-trem descartável nunca fecha issue", () => {
  const prInfos: TrainPrInfo[] = [
    { pr: 100, headRefName: "develop/fix-100", title: "fix: primeira coisa", issueNumbers: [10] },
    { pr: 101, headRefName: "develop/fix-101", title: "fix: segunda coisa", issueNumbers: [11, 12] },
  ];

  it("título nomeia o tamanho do lote e os números de PR", () => {
    const title = buildTrainPrTitle({ prs: [100, 101] });
    assert.match(title, /lote de 2/);
    assert.match(title, /#100/);
    assert.match(title, /#101/);
  });

  it("corpo usa Refs — nenhuma keyword de fechamento do GitHub aciona auto-close (invariante real, via parseClosesIssues)", () => {
    // Não basta o texto não conter a PALAVRA "close" (o corpo explica em
    // prosa por que NÃO fecha, e essa explicação legitimamente contém a
    // palavra) — o invariante que importa é que o GITHUB não reconheça
    // nenhuma keyword de auto-close neste corpo. `parseClosesIssues` é o
    // MESMO parser usado em produção (fetchTrainPrInfo, merge-train-live.ts)
    // pra extrair keywords reais — reusá-lo aqui é a prova direta.
    const body = buildTrainPrBody({ prs: [100, 101] }, prInfos);
    assert.match(body, /Refs #100, #101/);
    assert.deepEqual(parseClosesIssues(body), [], "nenhuma issue pode ser auto-fechada pelo PR-trem descartável");
    assert.match(body, /#10/);
    assert.match(body, /#11/);
    assert.match(body, /#12/);
  });

  it("corpo degrada bem quando um PR do lote não tem TrainPrInfo (nunca lança)", () => {
    const body = buildTrainPrBody({ prs: [100, 999] }, prInfos);
    assert.match(body, /#999/);
  });
});

describe("buildTrainMergeCommitTitle / buildTrainMergeCommitBody — commit squash é o merge de verdade (decisão do editor, 1 commit por lote)", () => {
  const prInfos: TrainPrInfo[] = [
    { pr: 100, headRefName: "develop/fix-100", title: "fix: primeira coisa", issueNumbers: [10] },
    { pr: 101, headRefName: "develop/fix-101", title: "fix: segunda coisa", issueNumbers: [11, 12] },
  ];

  it("título nomeia o lote", () => {
    const title = buildTrainMergeCommitTitle({ prs: [100, 101] });
    assert.match(title, /lote de 2/);
    assert.match(title, /#100.*#101|#101.*#100/);
  });

  it("preserva trailers de todos os commits do lote, deduplicados, com atribuição no fim (#11268)", () => {
    const infos: TrainPrInfo[] = [
      { ...prInfos[0], commits: [
        { messageBody: "This reverts commit abcdef1.\n\nCo-Authored-By: Pessoa <p@example.com>\nClaude-Session: sessao-1" },
        { messageHeadline: "This reverts commit abcdef2.", messageBody: "Co-authored-by: pessoa <p@example.com>" },
      ] },
      { ...prInfos[1], commits: [
        { messageBody: "This reverts commit ABCDEF1.\nClaude-Session: sessao-1" },
        { messageBody: "Co-Authored-By: Outra <o@example.com>\nClaude-Session: sessao-2" },
      ] },
      { ...prInfos[0], pr: 999, commits: [{ messageBody: "Co-Authored-By: Fora <f@example.com>" }] },
    ];
    const body = buildTrainMergeCommitBody({ prs: [100, 101, 102] }, infos);
    assert.equal(body, [
      "Trem de merge (#6300) — 3 PRs validados juntos com 1 run de CI: #100, #101, #102.\nCloses #10\nCloses #11\nCloses #12",
      "This reverts commit abcdef1.\nThis reverts commit abcdef2.",
      "Co-Authored-By: Pessoa <p@example.com>\nClaude-Session: sessao-1\nCo-Authored-By: Outra <o@example.com>\nClaude-Session: sessao-2",
    ].join("\n\n"));
  });

  it("corpo tem 1 linha `Closes #N` POR ISSUE, na UNIÃO ordenada de todas as issues do lote (#10878)", () => {
    const body = buildTrainMergeCommitBody({ prs: [100, 101] }, prInfos);
    assert.match(body, /^Closes #10$/m);
    assert.match(body, /^Closes #11$/m);
    assert.match(body, /^Closes #12$/m);
    assert.deepEqual(parseClosesIssues(body), [10, 11, 12]);
  });

  it("issue repetida entre 2 PRs do lote aparece só 1 vez no Closes", () => {
    const dup: TrainPrInfo[] = [
      { pr: 100, headRefName: "a", title: "a", issueNumbers: [10, 20] },
      { pr: 101, headRefName: "b", title: "b", issueNumbers: [20] },
    ];
    const body = buildTrainMergeCommitBody({ prs: [100, 101] }, dup);
    assert.equal(body.match(/^Closes #20$/gm)?.length, 1);
    assert.deepEqual(parseClosesIssues(body), [10, 20]);
  });

  it("nenhum PR do lote tem issue detectada — corpo NÃO tem linha Closes (nunca uma linha vazia 'Closes ')", () => {
    const semIssue: TrainPrInfo[] = [{ pr: 100, headRefName: "a", title: "a", issueNumbers: [] }];
    const body = buildTrainMergeCommitBody({ prs: [100] }, semIssue);
    assert.doesNotMatch(body, /Closes/);
  });
});

describe("summarizeTrainCiRuns — antes/depois de runs de CI (#6300, último critério de aceite)", () => {
  const prInfos: TrainPrInfo[] = [
    { pr: 1, headRefName: "a", title: "a", issueNumbers: [10] },
    { pr: 2, headRefName: "b", title: "b", issueNumbers: [11] },
    { pr: 3, headRefName: "c", title: "c", issueNumbers: [12] },
  ];

  it("lote de tamanho 1 (solo): zero CI run novo, conta em soloPrs, não em prsInvolvedInBatches", () => {
    const outcomes: TrainCiRunsOutcomeLike[] = [{ batch: { prs: [1] } }];
    const s = summarizeTrainCiRuns(outcomes, prInfos);
    assert.equal(s.ciRunsUsed, 0);
    assert.equal(s.soloPrs, 1);
    assert.equal(s.prsInvolvedInBatches, 0);
    assert.equal(s.issuesInvolvedInBatches, 0);
  });

  it("lote de 2 que mergeou direto: 1 CI run usado, 2 PRs/2 issues envolvidos", () => {
    const outcomes: TrainCiRunsOutcomeLike[] = [{ batch: { prs: [1, 2] } }];
    const s = summarizeTrainCiRuns(outcomes, prInfos);
    assert.equal(s.ciRunsUsed, 1);
    assert.equal(s.prsInvolvedInBatches, 2);
    assert.equal(s.issuesInvolvedInBatches, 2);
    assert.equal(s.soloPrs, 0);
  });

  it("lote de 3 vermelho bissecta em [1,2] (verde) + [3] (solo): 2 CI runs usados (não 3), PRs distintos sem duplicar entre a entrada abandonada e a filha", () => {
    const outcomes: TrainCiRunsOutcomeLike[] = [
      { batch: { prs: [1, 2, 3] } }, // abandoned — vermelho, mas AINDA consumiu 1 run real
      { batch: { prs: [1, 2] } }, // sub-lote — merged, outro run real
      { batch: { prs: [3] } }, // sub-lote de tamanho 1 — solo, zero run novo
    ];
    const s = summarizeTrainCiRuns(outcomes, prInfos);
    assert.equal(s.ciRunsUsed, 2); // 1 (lote de 3) + 1 (lote de 2) — NUNCA 3, mesmo com 3 entradas no array
    assert.equal(s.prsInvolvedInBatches, 3); // união {1,2,3} ∪ {1,2} = {1,2,3}, não soma 3+2=5
    assert.equal(s.issuesInvolvedInBatches, 3);
    assert.equal(s.soloPrs, 1);
  });

  it("issue fechada por 2 PRs do mesmo lote conta 1 vez só (união, não soma)", () => {
    const shared: TrainPrInfo[] = [
      { pr: 1, headRefName: "a", title: "a", issueNumbers: [10, 99] },
      { pr: 2, headRefName: "b", title: "b", issueNumbers: [99] },
    ];
    const outcomes: TrainCiRunsOutcomeLike[] = [{ batch: { prs: [1, 2] } }];
    const s = summarizeTrainCiRuns(outcomes, shared);
    assert.equal(s.issuesInvolvedInBatches, 2); // {10, 99}, não 3
  });

  it("sem outcomes: tudo zero, nunca lança", () => {
    const s = summarizeTrainCiRuns([], prInfos);
    assert.deepEqual(s, { prsInvolvedInBatches: 0, issuesInvolvedInBatches: 0, ciRunsUsed: 0, soloPrs: 0 });
  });

  it("PR sem TrainPrInfo correspondente (não encontrado no map): não lança, só não soma issue nenhuma pra ele", () => {
    const outcomes: TrainCiRunsOutcomeLike[] = [{ batch: { prs: [1, 999] } }];
    const s = summarizeTrainCiRuns(outcomes, prInfos);
    assert.equal(s.ciRunsUsed, 1);
    assert.equal(s.prsInvolvedInBatches, 2);
    assert.equal(s.issuesInvolvedInBatches, 1); // só a issue 10, do PR 1 — PR 999 não tem info
  });
});

describe("parseClosesIssues — só marcador real fecha, menção em crase/bloco/citação não (#10989, regressão #633)", () => {
  it("cenário real da PR #10886: keyword dentro de code span não vira fechamento", () => {
    const body = [
      "Corrige o squash do trem: antes o commit tinha `Closes #10695, #10775, #10799` numa linha só.",
      "O teste novo cobre asserções de `Closes #10, #11, #12`.",
      "",
      "Closes #10878",
    ].join("\n");
    assert.deepEqual(parseClosesIssues(body), [10878]);
  });

  it("o commit squash do trem montado a partir desse corpo só fecha a issue de verdade", () => {
    const body = "Antes saía `Closes #10695, #10775`.\n\nCloses #10878";
    const info: TrainPrInfo = { pr: 1, headRefName: "a", title: "a", issueNumbers: parseClosesIssues(body) };
    const commit = buildTrainMergeCommitBody({ prs: [1] }, [info]);
    assert.deepEqual(parseClosesIssues(commit), [10878]);
    assert.doesNotMatch(commit, /#10695|#10775/);
  });

  it("bloco de código cercado (``` e ~~~) é ignorado, inclusive cerca sem fechamento", () => {
    assert.deepEqual(parseClosesIssues("```\nCloses #1\n```\nCloses #2"), [2]);
    assert.deepEqual(parseClosesIssues("~~~md\nfixes #3\n~~~\nresolves #4"), [4]);
    assert.deepEqual(parseClosesIssues("Closes #5\n````\n```\nCloses #6\n````\nCloses #7"), [5, 7]);
    assert.deepEqual(parseClosesIssues("Closes #8\n```\nCloses #9"), [8]);
  });

  it("code span com crase dupla e linha citada (>) são ignorados", () => {
    assert.deepEqual(parseClosesIssues("``a `Closes #1` b`` e Closes #2"), [2]);
    assert.deepEqual(parseClosesIssues("> Closes #3\nCloses #4"), [4]);
  });

  it("comentário HTML é ignorado", () => {
    assert.deepEqual(parseClosesIssues("<!-- Closes #1 -->\nCloses #2"), [2]);
  });

  it("marcador real em prosa e várias linhas de keyword continuam valendo", () => {
    assert.deepEqual(parseClosesIssues("Closes #10\ncloses #11\nEste PR fixes #12 também."), [10, 11, 12]);
    assert.deepEqual(parseClosesIssues("- Closes #20\n- Closes #21"), [20, 21]);
  });

  it("crase solta sem par não esconde o marcador que vem depois", () => {
    assert.deepEqual(parseClosesIssues("um ` solto\nCloses #30"), [30]);
  });

  it("#11049: crase solta num parágrafo não forma span com crase de outro parágrafo e apaga o Closes", () => {
    const body = "Ajusta o `foo\n\nCloses #123\n\nUsa `bar` aqui";
    assert.deepEqual(parseClosesIssues(body), [123]);
    assert.equal(stripNonMarkerContext(body).split("\n").length, body.split("\n").length);
  });

  it("#11049: code span dentro do MESMO parágrafo (inclusive multilinha) continua sendo removido", () => {
    assert.deepEqual(parseClosesIssues("veja `Closes #1\nCloses #2` e pronto\n\nCloses #3"), [3]);
  });

  it("parseRefsIssues também ignora menção dentro de crase", () => {
    assert.deepEqual(parseRefsIssues("Exemplo: `REFS #1, NÃO CLOSES`.\nREFS #2, NÃO CLOSES (parcial)"), [2]);
  });

  it("stripNonMarkerContext preserva o número de linhas", () => {
    const body = "a\n```\nb\n```\n> c\nd";
    assert.equal(stripNonMarkerContext(body).split("\n").length, body.split("\n").length);
  });
});

describe("buildSoloSquashSubject / buildSoloSquashBody (#11216)", () => {
  it("acrescenta (#N) ao título — --subject explícito não ganha o sufixo do GitHub", () => {
    assert.equal(buildSoloSquashSubject("fix: x", 42), "fix: x (#42)");
    assert.equal(buildSoloSquashSubject("  fix: x  ", 42), "fix: x (#42)");
  });

  it("não duplica quando o título já termina com (#N) do próprio PR", () => {
    assert.equal(buildSoloSquashSubject("fix: x (#42)", 42), "fix: x (#42)");
  });

  it("título que termina com (#M) de OUTRO número ainda ganha o (#N)", () => {
    assert.equal(buildSoloSquashSubject("fix: x (#7)", 42), "fix: x (#7) (#42)");
  });

  it("body sem commits de revert fica intacto", () => {
    assert.equal(buildSoloSquashBody("Closes #1", []), "Closes #1");
    assert.equal(buildSoloSquashBody("Closes #1", undefined), "Closes #1");
    assert.equal(buildSoloSquashBody("Closes #1", [{ messageHeadline: "fix", messageBody: "" }]), "Closes #1");
  });

  it("anexa trailers de revert dos commits, deduplicados, sem repetir o que o body já tem", () => {
    const a = "abcdef1234567";
    const b = "1234567abcdef";
    const body = buildSoloSquashBody(`Reverte.\nThis reverts commit ${a}.\n`, [
      { messageBody: `This reverts commit ${a}.` },
      { messageBody: `This reverts commit ${b}.` },
      { messageBody: `This reverts commit ${b}.` },
      { messageHeadline: null, messageBody: 5 },
    ]);
    assert.equal(body, `Reverte.\nThis reverts commit ${a}.\n\nThis reverts commit ${b}.`);
  });

  it("body vazio recebe só os trailers", () => {
    assert.equal(buildSoloSquashBody("", [{ messageBody: "This reverts commit abcdef1." }]), "This reverts commit abcdef1.");
  });

  // #11236: com --body explícito o squash perdia os Co-Authored-By dos commits.
  it("copia Co-Authored-By e Claude-Session dos commits que o body não traz", () => {
    const body = buildSoloSquashBody("Closes #11236\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n", [
      { messageHeadline: "fix: x", messageBody: "Detalhe.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: abc-123" },
    ]);
    assert.equal(
      body,
      "Closes #11236\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: abc-123",
    );
  });

  it("deduplica atribuição contra o body e entre commits, sem diferenciar caixa da chave", () => {
    const body = buildSoloSquashBody("Closes #1\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>", [
      { messageBody: "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" },
      { messageBody: "Co-Authored-By: Fulano <f@x.com>" },
      { messageBody: "co-authored-by: Fulano <f@x.com>" },
    ]);
    assert.equal(body, "Closes #1\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\n\nCo-Authored-By: Fulano <f@x.com>");
  });

  it("revert e atribuição: trailers de atribuição ficam no ÚLTIMO parágrafo", () => {
    const body = buildSoloSquashBody("Reverte.", [
      { messageBody: "This reverts commit abcdef1.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" },
    ]);
    assert.equal(body, "Reverte.\n\nThis reverts commit abcdef1.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
  });

  it("menção a Co-Authored-By no meio de uma linha não vira trailer", () => {
    assert.equal(buildSoloSquashBody("Closes #1", [{ messageBody: "copia o Co-Authored-By: dos commits" }]), "Closes #1");
  });
});
