/**
 * test/merge-train-closes-removal-10878-10848.test.ts (regressão #633)
 *
 * #10878 — o commit squash do PR-trem #10846 (66a77a766) saiu com
 * `Closes #10695, #10775, #10799`. O GitHub só fecha a issue IMEDIATAMENTE
 * depois da palavra-chave: #10695 fechou pelo commit, #10775 e #10799
 * ficaram abertas. O corpo agora repete a keyword por issue.
 *
 * #10848 — o PR-trem #10847 (lote #10840/#10841/#10842, 3606 adições) saiu
 * vermelho 2× no gate #7115 porque o corpo gerado não tinha
 * `removal-declaration:`; o trem bissectou à toa. O corpo agora agrega as
 * declarações das PRs do lote numa linha própria.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrainMergeCommitBody,
  buildTrainPrBody,
  buildTrainRemovalDeclaration,
  parseClosesIssues,
  parseRefsIssues,
  type TrainPrInfo,
} from "../scripts/lib/merge-train.ts";
import { fetchTrainPrInfo, type ExecResult, type TrainRunner } from "../scripts/lib/merge-train-live.ts";
import { evaluateRemovalDeclaration, extractRemovalDeclaration } from "../scripts/lib/pr-removal-declaration.ts";

/** Semântica de auto-close do GitHub: só o `#N` colado na palavra-chave
 * conta. `parseClosesIssues` implementa exatamente isso, por isso serve de
 * oráculo — `Closes #1, #2` devolve só [1]. */
const githubAutoClosed = parseClosesIssues;

describe("#10878 — commit squash do trem fecha TODAS as issues do lote", () => {
  it("oráculo: a forma antiga `Closes #A, #B, #C` só fecha a 1ª (o bug ao vivo do 66a77a766)", () => {
    assert.deepEqual(githubAutoClosed("Closes #10695, #10775, #10799"), [10695]);
  });

  it("cenário real do PR-trem #10846: #10812 (Closes #10775, #10695) + #10801 (Closes #10799)", () => {
    const pr10812Body = "Lote `cac`.\n\nCloses #10775\nCloses #10695\n\n## #10775: ...";
    const pr10801Body = "A descrição do YouTube...\n\nCloses #10799\n\nValidação: ...";
    const prInfos: TrainPrInfo[] = [
      { pr: 10812, headRefName: "overnight/batch-cac", title: "fix(cac)", issueNumbers: parseClosesIssues(pr10812Body) },
      { pr: 10801, headRefName: "overnight/fix-10799-youtube", title: "fix(youtube)", issueNumbers: parseClosesIssues(pr10801Body) },
    ];
    const body = buildTrainMergeCommitBody({ prs: [10812, 10801] }, prInfos);
    assert.deepEqual(githubAutoClosed(body), [10695, 10775, 10799]);
  });

  it("issue só referenciada (`REFS #N, NÃO CLOSES`) vira linha Refs, nunca Closes", () => {
    const prInfos: TrainPrInfo[] = [
      { pr: 1, headRefName: "a", title: "a", issueNumbers: [10], refsIssueNumbers: [20] },
      { pr: 2, headRefName: "b", title: "b", issueNumbers: [30], refsIssueNumbers: [10] },
    ];
    const body = buildTrainMergeCommitBody({ prs: [1, 2] }, prInfos);
    assert.deepEqual(githubAutoClosed(body), [10, 30]);
    // #10 é fechada por outra PR do lote — não aparece duplicada como Refs.
    assert.match(body, /^Refs #20 — NÃO CLOSES/m);
  });
});

describe("parseRefsIssues", () => {
  it("lê a convenção `REFS #N, NÃO CLOSES (motivo)` e listas `Refs #A, #B`", () => {
    assert.deepEqual(parseRefsIssues("REFS #10878, NÃO CLOSES (parcial)"), [10878]);
    assert.deepEqual(parseRefsIssues("Refs #100, #101 — NÃO CLOSES"), [100, 101]);
    assert.deepEqual(parseRefsIssues("Ref: #7"), [7]);
  });

  it("não confunde palavras que só começam com 'ref'", () => {
    assert.deepEqual(parseRefsIssues("refactor #12 e references #13"), []);
  });
});

describe("#10848 — PR-trem grande passa no gate #7115", () => {
  const prInfos: TrainPrInfo[] = [
    { pr: 10840, headRefName: "develop/fix-1", title: "a", issueNumbers: [1], removalDeclaration: "feature nova, não substitui código existente" },
    { pr: 10841, headRefName: "develop/fix-2", title: "b", issueNumbers: [2], removalDeclaration: "remove o caminho antigo de X" },
    { pr: 10842, headRefName: "develop/fix-3", title: "c", issueNumbers: [3] },
  ];

  it("lote de 3606 adições somadas sai `ok` no gate (antes: `missing`)", () => {
    const body = buildTrainPrBody({ prs: [10840, 10841, 10842] }, prInfos);
    const ev = evaluateRemovalDeclaration({ files: 40, added: 3606, removed: 120 }, body);
    assert.equal(ev.status, "ok");
  });

  it("agrega a declaração de cada PR do lote e nomeia a que não declarou", () => {
    const line = buildTrainRemovalDeclaration({ prs: [10840, 10841, 10842] }, prInfos);
    assert.ok(!line.includes("\n"), "o gate lê só até o fim da linha");
    assert.match(line, /#10840: feature nova/);
    assert.match(line, /#10841: remove o caminho antigo de X/);
    assert.match(line, /#10842: sem declaração própria/);
  });

  it("o corpo do PR-trem continua sem fechar nenhuma issue", () => {
    const body = buildTrainPrBody({ prs: [10840, 10841, 10842] }, prInfos);
    assert.deepEqual(parseClosesIssues(body), []);
  });
});

describe("fetchTrainPrInfo lê Refs e removal-declaration do corpo da PR", () => {
  it("popula refsIssueNumbers e removalDeclaration", () => {
    const body = "Closes #10\nREFS #20, NÃO CLOSES (resíduo)\n\nremoval-declaration: remove o parser legado de Y\n";
    const runner: TrainRunner = {
      exec: (_cmd: string, _args: string[]): ExecResult => ({
        ok: true,
        stdout: JSON.stringify({ number: 5, headRefName: "x", title: "t", body }),
        stderr: "",
      }),
      sleep: async () => {},
      now: () => 0,
      mkTempDir: (p: string) => `/tmp/${p}`,
      warn: () => {},
    };
    const info = fetchTrainPrInfo(runner, 5);
    assert.deepEqual(info.issueNumbers, [10]);
    assert.deepEqual(info.refsIssueNumbers, [20]);
    assert.equal(info.removalDeclaration, "remove o parser legado de Y");
  });

  it("extractRemovalDeclaration devolve null sem marcador", () => {
    assert.equal(extractRemovalDeclaration("sem nada aqui"), null);
  });
});
