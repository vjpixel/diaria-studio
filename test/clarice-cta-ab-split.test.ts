/**
 * test/clarice-cta-ab-split.test.ts — regressão do achado [low] do #3890:
 * o re-run de `--apply` re-derivava o split A/B da ordem de paginação da Brevo
 * NAQUELE momento; se a ordem mudasse entre runs, um contato podia cair nas
 * duas listas (recebe A e B) porque `importEmails` só ADICIONA. O fix persiste
 * o split e reusa em re-runs (`loadOrCreateSplit`), além de validar disjunção
 * (`assertDisjointSplit`). Aqui: sem rede, só as funções puras.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  splitAlternate,
  assertDisjointSplit,
  loadOrCreateSplit,
  splitFilePath,
} from "../scripts/clarice-cta-ab-setup.ts";
import { assertExperimentArmsInstrumented } from "../scripts/clarice-schedule-ramp.ts";

const QA = "editor@example.com";

describe("splitAlternate (#3890)", () => {
  it("coloca o QA nas duas listas e alterna o resto, disjunto fora do QA", () => {
    const { a, b } = splitAlternate(["e1@x", "e2@x", "e3@x", "e4@x", QA], QA);
    assert.deepEqual(a, ["e1@x", "e3@x", QA]);
    assert.deepEqual(b, ["e2@x", "e4@x", QA]);
    assert.ok(a.includes(QA) && b.includes(QA));
    // A∩B = {QA}
    const overlap = a.filter((e) => b.includes(e));
    assert.deepEqual(overlap, [QA]);
  });
});

describe("assertDisjointSplit (#3890)", () => {
  it("passa quando A∩B = {QA}", () => {
    assert.doesNotThrow(() => assertDisjointSplit(["a@x", QA], ["b@x", QA], QA));
  });
  it("lança quando um contato NÃO-QA está nas duas listas", () => {
    assert.throws(
      () => assertDisjointSplit(["a@x", "dup@x", QA], ["b@x", "dup@x", QA], QA),
      /não-disjunto/,
    );
  });
});

describe("loadOrCreateSplit — idempotência entre re-runs (#3890)", () => {
  let dir: string;
  const setup = () => (dir = mkdtempSync(join(tmpdir(), "cta-split-")));
  const teardown = () => rmSync(dir, { recursive: true, force: true });

  it("persiste na 1ª chamada e REUSA na 2ª — mesmo com a ordem dos emails embaralhada", () => {
    setup();
    try {
      const emails = ["e1@x", "e2@x", "e3@x", "e4@x", "e5@x", "e6@x", QA];
      const first = loadOrCreateSplit(dir, 8, emails, QA);
      assert.equal(first.reused, false);
      assert.ok(existsSync(splitFilePath(dir, 8)), "split devia ter sido persistido");

      // Simula a Brevo devolvendo OUTRA ordem de paginação no re-run.
      const shuffled = ["e6@x", "e1@x", QA, "e4@x", "e2@x", "e5@x", "e3@x"];
      const second = loadOrCreateSplit(dir, 8, shuffled, QA);
      assert.equal(second.reused, true);

      // A propriedade que fecha o footgun: split IDÊNTICO apesar da ordem nova.
      assert.deepEqual(second.a, first.a);
      assert.deepEqual(second.b, first.b);
    } finally {
      teardown();
    }
  });

  it("o split persistido é disjunto (A∩B = {QA})", () => {
    setup();
    try {
      const { a, b } = loadOrCreateSplit(dir, 9, ["x1@x", "x2@x", "x3@x", QA], QA);
      const overlap = a.filter((e) => b.includes(e));
      assert.deepEqual(overlap, [QA]);
    } finally {
      teardown();
    }
  });
});

describe("assertExperimentArmsInstrumented (#4431 — guard preventivo pré-agendamento)", () => {
  // #assertHtmlHasUnsubscribeLink também exige ≥200 chars — padding pra não
  // disparar esse guard mais cedo do que o cenário que cada teste quer cobrir.
  const PADDING = "<!-- ".padEnd(200, "x") + " -->";
  const okHtml = (topo: string) =>
    `<html><body>${PADDING}<p>${topo}</p><img src="a.png"><img src="b.png">` +
    `<p><a href="{{ unsubscribe }}">descadastrar</a></p></body></html>`;

  it("passa quando os dois braços têm unsub + mesma contagem de <img> + </body>", () => {
    assert.doesNotThrow(() =>
      assertExperimentArmsInstrumented({ a: okHtml("copy A"), b: okHtml("copy B, bem mais longa") }),
    );
  });

  it("rejeita quando um braço não tem o link/merge tag de descadastro (caso central do #4431)", () => {
    const semUnsub = `<html><body>${PADDING}<p>copy B</p><img src="a.png"><img src="b.png"></body></html>`;
    assert.throws(
      () => assertExperimentArmsInstrumented({ a: okHtml("copy A"), b: semUnsub }),
      /Braço "b".*descadastro|unsubscribe/i,
    );
  });

  it("rejeita quando os braços têm contagem de <img> divergente (perda assimétrica de conteúdo)", () => {
    const menosImg =
      `<html><body>${PADDING}<p>copy B</p><img src="a.png">` +
      `<p><a href="{{ unsubscribe }}">descadastrar</a></p></body></html>`;
    assert.throws(
      () => assertExperimentArmsInstrumented({ a: okHtml("copy A"), b: menosImg }),
      /contagem de <img> divergente/,
    );
  });

  it("rejeita quando um braço não fecha </body> (estrutura incompleta)", () => {
    const semBody =
      `<html><body>${PADDING}<p>copy B</p><img src="a.png"><img src="b.png">` +
      `<p><a href="{{ unsubscribe }}">descadastrar</a></p>`;
    assert.throws(
      () => assertExperimentArmsInstrumented({ a: okHtml("copy A"), b: semBody }),
      /sem tag de fechamento <\/body>/,
    );
  });

  it("exige pelo menos 2 braços", () => {
    assert.throws(() => assertExperimentArmsInstrumented({ a: okHtml("copy A") }), /esperava ≥2 braços/);
  });
});
