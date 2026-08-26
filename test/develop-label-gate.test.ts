/**
 * test/develop-label-gate.test.ts (#6271)
 *
 * Trava o gate de SAÍDA do track Develop.
 *
 * O que motiva, e o que o teste precisa distinguir: das 5 issues que ficaram
 * marcadas `develop` ao fim da `/diaria-develop` 260826b, **3 eram resíduo e 2
 * eram fila legítima** — e as 2 legítimas eram justamente as que a sessão
 * nunca tentou. Um gate que não separasse as duas coisas viraria ruído, e gate
 * ruidoso é desligado. Por isso a maior parte destes casos é sobre o que o
 * gate **NÃO** deve acusar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WORK_FINISHED_STATUSES,
  checkDevelopLabelCleared,
  developTriggeringLabels,
  isWorkFinished,
} from "../scripts/lib/develop-label-gate.ts";

const DEV_LABELS = ["bug", "P2", "develop-track"];
const CLEAN_LABELS = ["bug", "P2"];

describe("#6271 — isWorkFinished separa 'terminei' de 'não trabalhei'", () => {
  it("mergeada e entregue-fora-de-codigo contam como terminado", () => {
    for (const status of WORK_FINISHED_STATUSES) {
      assert.equal(isWorkFinished({ number: 1, status }), true, status);
    }
  });

  it("pulada/ja-resolvida-antes-da-sessao conta — a sessão VERIFICOU ao vivo (#5723)", () => {
    assert.equal(
      isWorkFinished({ number: 1, status: "pulada", motivo: "ja-resolvida-antes-da-sessao" }),
      true,
    );
  });

  it("deixado-para-o-helios NÃO conta — a sessão declarou que não é trabalho dela", () => {
    // Acusar aqui seria contraditório com o proprio status: ela nao trabalhou
    // a issue, entao nao consumiu a razao que a trouxe pro Develop.
    assert.equal(isWorkFinished({ number: 1, status: "pulada", motivo: "deixado-para-o-helios" }), false);
  });

  it("nao-tentada NÃO conta — é o caso das 2 issues legítimas da medição (#6048, #467)", () => {
    assert.equal(isWorkFinished({ number: 6048, status: "nao-tentada" }), false);
  });

  it("bloqueio NÃO conta — o bloqueio É a razão de estar em Develop", () => {
    assert.equal(
      isWorkFinished({ number: 1, status: "pulada", motivo: "nao-destravavel-na-sessao" }),
      false,
    );
    assert.equal(isWorkFinished({ number: 1, status: "pulada", motivo: "decisao-adiada" }), false);
  });

  it("pendente e draft-ci-vermelho NÃO contam — trabalho ainda aberto", () => {
    assert.equal(isWorkFinished({ number: 1, status: "pendente" }), false);
    assert.equal(isWorkFinished({ number: 1, status: "draft-ci-vermelho" }), false);
  });

  it("status ausente ou desconhecido NÃO conta (conservador por design)", () => {
    assert.equal(isWorkFinished({ number: 1 }), false);
    assert.equal(isWorkFinished({ number: 1, status: "status-que-nao-existe" }), false);
  });
});

describe("#6271 — developTriggeringLabels sai do classificador, não de literais", () => {
  it("identifica as 3 labels que roteiam pra develop", () => {
    // Derivadas por PROBE contra `classifyExecTrack`: se ele mudar o conjunto,
    // isto acompanha sozinho, em vez de virar uma 4ª cópia dos literais.
    const found = developTriggeringLabels(["bug", "P2", "windows", "develop-track", "trade-off-real"]);
    assert.deepEqual(found.sort(), ["develop-track", "trade-off-real", "windows"]);
  });

  it("label neutra não entra", () => {
    assert.deepEqual(developTriggeringLabels(CLEAN_LABELS), []);
  });
});

describe("#6271 — o gate acusa resíduo e só resíduo", () => {
  it("issue MERGEADA que ainda classifica develop → finding", () => {
    // É o caso #6181 da medição: a investigação de painel do Kit, único motivo
    // do `windows`, foi concluída pela sessão — e a label ficou.
    const r = checkDevelopLabelCleared(
      [{ number: 6181, status: "mergeada" }],
      [{ number: 6181, labels: ["bug", "windows"] }],
    );
    assert.equal(r.ok, false);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]!.number, 6181);
    assert.deepEqual(r.findings[0]!.developLabels, ["windows"]);
  });

  it("issue MERGEADA já roteada pra fora → limpa, sem finding", () => {
    const r = checkDevelopLabelCleared(
      [{ number: 6098, status: "mergeada" }],
      [{ number: 6098, labels: CLEAN_LABELS }],
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.cleared, [6098]);
  });

  it("issue NUNCA TENTADA continua em develop → NÃO acusa (é fila, não resíduo)", () => {
    // O teste que impede o gate de virar ruído: #6048 e #467 estavam
    // corretamente em Develop justamente porque a sessão não as tocou.
    const r = checkDevelopLabelCleared(
      [
        { number: 6048, status: "nao-tentada" },
        { number: 467, status: "pulada", motivo: "deixado-para-o-helios" },
      ],
      [
        { number: 6048, labels: DEV_LABELS },
        { number: 467, labels: DEV_LABELS },
      ],
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.cleared, [], "nem entram na checagem — não são 'limpas', são fora de escopo");
  });

  it("justificativa explícita passa, mas fica VISÍVEL", () => {
    // Escape hatch com a mesma disciplina de `unblock_evidence`: o motivo é
    // aceito, mas precisa estar escrito. O que o gate recusa é o silêncio.
    const r = checkDevelopLabelCleared(
      [
        {
          number: 6200,
          status: "mergeada",
          develop_track_justificado: "parte 1 mergeada; parte 2 segue exigindo Chrome logado",
        },
      ],
      [{ number: 6200, labels: DEV_LABELS }],
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.justified, [6200]);
    assert.deepEqual(r.findings, []);
  });

  it("justificativa VAZIA ou só espaço não vale — silêncio disfarçado", () => {
    for (const justificativa of ["", "   "]) {
      const r = checkDevelopLabelCleared(
        [{ number: 6200, status: "mergeada", develop_track_justificado: justificativa }],
        [{ number: 6200, labels: DEV_LABELS }],
      );
      assert.equal(r.ok, false, `justificativa ${JSON.stringify(justificativa)} não deveria passar`);
    }
  });

  it("issue sem dado buscado é IGNORADA — nunca acusa por ausência", () => {
    // Fail-soft (#738): o `gh` pode falhar por rede/rate limit, e um gate que
    // acusa por dado ausente vira ruído — e pior, ruído que parece veredito.
    const r = checkDevelopLabelCleared([{ number: 9999, status: "mergeada" }], []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.findings, []);
  });

  it("issue que virou BLOQUEADA depois do merge → limpa (é o caso #6114 → #6269)", () => {
    // `bloqueada` não é `develop`: a issue saiu do track, que é exatamente o
    // desfecho correto. O gate não opina sobre QUAL track é o verdadeiro.
    const r = checkDevelopLabelCleared(
      [{ number: 6114, status: "mergeada" }],
      [{ number: 6114, labels: ["bug", "external-blocker"] }],
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.cleared, [6114]);
  });

  it("plano vazio → ok trivial", () => {
    const r = checkDevelopLabelCleared([], []);
    assert.equal(r.ok, true);
  });

  it("mistura realista: 3 resíduos + 2 legítimas reproduz a medição da issue", () => {
    const r = checkDevelopLabelCleared(
      [
        { number: 6181, status: "mergeada" },
        { number: 6114, status: "mergeada" },
        { number: 6206, status: "entregue-fora-de-codigo" },
        { number: 6048, status: "nao-tentada" },
        { number: 467, status: "nao-tentada" },
      ],
      [
        { number: 6181, labels: ["bug", "windows", "develop-track"] },
        { number: 6114, labels: ["bug", "develop-track"] },
        { number: 6206, labels: ["bug", "windows"] },
        { number: 6048, labels: DEV_LABELS },
        { number: 467, labels: DEV_LABELS },
      ],
    );
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.findings.map((f) => f.number).sort((a, b) => a - b),
      [6114, 6181, 6206],
      "os 3 resíduos, e só eles",
    );
  });
});
