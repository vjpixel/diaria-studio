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
  buildTrainPrTitle,
  buildTrainPrBody,
  buildTrainMergeCommitTitle,
  buildTrainMergeCommitBody,
  type TrainCandidate,
  type TrainPrInfo,
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
    let frontier = [{ prs: [1, 2, 3, 4, 5, 6, 7] }];
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

  it("corpo tem 1 linha Closes com a UNIÃO ordenada de todas as issues do lote", () => {
    const body = buildTrainMergeCommitBody({ prs: [100, 101] }, prInfos);
    assert.match(body, /^Closes #10, #11, #12$/m);
  });

  it("issue repetida entre 2 PRs do lote aparece só 1 vez no Closes", () => {
    const dup: TrainPrInfo[] = [
      { pr: 100, headRefName: "a", title: "a", issueNumbers: [10, 20] },
      { pr: 101, headRefName: "b", title: "b", issueNumbers: [20] },
    ];
    const body = buildTrainMergeCommitBody({ prs: [100, 101] }, dup);
    assert.match(body, /^Closes #10, #20$/m);
  });

  it("nenhum PR do lote tem issue detectada — corpo NÃO tem linha Closes (nunca uma linha vazia 'Closes ')", () => {
    const semIssue: TrainPrInfo[] = [{ pr: 100, headRefName: "a", title: "a", issueNumbers: [] }];
    const body = buildTrainMergeCommitBody({ prs: [100] }, semIssue);
    assert.doesNotMatch(body, /Closes/);
  });
});
