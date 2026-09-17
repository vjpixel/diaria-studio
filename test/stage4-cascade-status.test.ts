/**
 * test/stage4-cascade-status.test.ts (#8123 Fatia 4)
 *
 * Cobre o mecanismo que permite o preview de TEXTO do Stage 4 ser servido
 * sem esperar imagem/carrossel/social regenerarem em background: o estado
 * de cascata (`startCascade`/`markPiece`) e o badge "regenerando"
 * (`buildRegeneratingBadgeHtml`/`injectRegeneratingBadge`) que o gate
 * injeta no preview enquanto peças ainda estão pendentes.
 *
 * Teste de regressão central (#633): `startCascade` retorna imediatamente
 * com todas as peças em `pending` — nada aqui espera as peças "terminarem"
 * pra devolver controle ao caller, demonstrando que o preview de texto
 * pode ser servido no mesmo instante, sem bloquear nas peças em background.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startCascade,
  markPiece,
  readCascadeStatus,
  clearCascadeStatus,
  isCascadePending,
  pendingPieceLabels,
  buildRegeneratingBadgeHtml,
  injectRegeneratingBadge,
} from "../scripts/lib/stage4-cascade-status.ts";

function withStatusPath(fn: (statusPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "stage4-cascade-"));
  const statusPath = join(dir, "_internal", "stage4-cascade-status.json");
  try {
    fn(statusPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readCascadeStatus", () => {
  it("null quando não há cascata (arquivo ausente)", () => {
    withStatusPath((p) => {
      assert.equal(readCascadeStatus(p), null);
    });
  });

  it("fail-soft: arquivo corrompido volta null em vez de lançar", () => {
    withStatusPath((p) => {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "{ não é json", "utf8");
      assert.equal(readCascadeStatus(p), null);
    });
  });
});

describe("startCascade", () => {
  it("retorna IMEDIATAMENTE com todas as peças pending — não espera nada em background (#633 regressão)", () => {
    withStatusPath((p) => {
      const t0 = Date.now();
      const status = startCascade(p, {
        highlight: "d1",
        reason: "título alterado",
        pieces: ["image", "carousel", "social"],
      });
      const elapsedMs = Date.now() - t0;
      assert.ok(elapsedMs < 500, `startCascade não deveria bloquear (levou ${elapsedMs}ms)`);
      assert.equal(status.highlight, "d1");
      assert.deepEqual(status.pieces, { image: "pending", carousel: "pending", social: "pending" });
      assert.equal(isCascadePending(status), true);
    });
  });

  it("sobrescreve cascata anterior (só o ajuste mais recente importa)", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "1º ajuste", pieces: ["image"] });
      const second = startCascade(p, { highlight: "d2", reason: "2º ajuste", pieces: ["social"] });
      const read = readCascadeStatus(p);
      assert.equal(read?.highlight, "d2");
      assert.deepEqual(read?.pieces, { social: "pending" });
      assert.equal(second.reason, "2º ajuste");
    });
  });

  it("deduplica peças repetidas em --pieces", () => {
    withStatusPath((p) => {
      const status = startCascade(p, {
        highlight: "d3",
        reason: "x",
        pieces: ["image", "image", "carousel"],
      });
      assert.deepEqual(Object.keys(status.pieces).sort(), ["carousel", "image"]);
    });
  });
});

describe("markPiece", () => {
  it("transiciona pending → done, cascata fica não-pendente quando todas resolvidas", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image", "social"] });
      let status = markPiece(p, "d1", "image", "done");
      assert.equal(status?.pieces.image, "done");
      assert.equal(isCascadePending(status), true); // social ainda pending

      status = markPiece(p, "d1", "social", "done");
      assert.equal(isCascadePending(status), false);
    });
  });

  it("aceita 'error' como estado terminal (não fica pending pra sempre)", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d2", reason: "x", pieces: ["image"] });
      const status = markPiece(p, "d2", "image", "error");
      assert.equal(status?.pieces.image, "error");
      assert.equal(isCascadePending(status), false);
    });
  });

  it("no-op fail-soft quando não há cascata em curso", () => {
    withStatusPath((p) => {
      const result = markPiece(p, "d1", "image", "done");
      assert.equal(result, null);
    });
  });

  it("no-op fail-soft quando highlight não bate com a cascata atual (corrida com --start concorrente)", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      const result = markPiece(p, "d2", "image", "done");
      // devolve o estado atual (d1) sem tocar nada — nunca lança
      assert.equal(result?.highlight, "d1");
      assert.equal(result?.pieces.image, "pending");
    });
  });
});

describe("clearCascadeStatus", () => {
  it("remove o arquivo — cascata deixa de existir", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      clearCascadeStatus(p);
      assert.equal(readCascadeStatus(p), null);
    });
  });

  it("idempotente — arquivo já ausente não lança", () => {
    withStatusPath((p) => {
      assert.doesNotThrow(() => clearCascadeStatus(p));
    });
  });
});

describe("pendingPieceLabels / buildRegeneratingBadgeHtml", () => {
  it("null quando não há cascata", () => {
    assert.equal(buildRegeneratingBadgeHtml(null), null);
  });

  it("null quando todas as peças já resolveram", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      const status = markPiece(p, "d1", "image", "done");
      assert.deepEqual(pendingPieceLabels(status), []);
      assert.equal(buildRegeneratingBadgeHtml(status), null);
    });
  });

  it("lista rótulos em PT-BR na ordem image→carousel→social, só das peças pending", () => {
    withStatusPath((p) => {
      const status = startCascade(p, {
        highlight: "d3",
        reason: "troca de destaque",
        pieces: ["social", "image"], // ordem de entrada não importa
      });
      assert.deepEqual(pendingPieceLabels(status), ["imagem", "texto social"]);
      const badge = buildRegeneratingBadgeHtml(status);
      assert.ok(badge);
      assert.match(badge!, /D3/);
      assert.match(badge!, /imagem, texto social/);
      assert.match(badge!, /regenerando em segundo plano/);
    });
  });
});

describe("injectRegeneratingBadge", () => {
  const baseHtml = "<html><head></head><body><h1>Newsletter</h1></body></html>";

  it("insere logo após <body...> quando há badge", () => {
    const badge = "<div>⏳ regenerando</div>";
    const out = injectRegeneratingBadge(baseHtml, badge);
    assert.match(out, /^<html><head><\/head><body>.*<div>⏳ regenerando<\/div>.*<h1>/s);
    assert.ok(out.indexOf("<div>⏳ regenerando</div>") < out.indexOf("<h1>"));
  });

  it("badgeHtml null retorna o HTML original (sem inserção)", () => {
    const out = injectRegeneratingBadge(baseHtml, null);
    assert.equal(out, baseHtml);
  });

  it("idempotente — reinjetar substitui o badge anterior, nunca acumula", () => {
    const first = injectRegeneratingBadge(baseHtml, "<div>versão 1</div>");
    const second = injectRegeneratingBadge(first, "<div>versão 2</div>");
    assert.equal((second.match(/versão/g) || []).length, 1);
    assert.match(second, /versão 2/);
    assert.doesNotMatch(second, /versão 1/);
  });

  it("remove o badge quando a cascata resolve (badgeHtml null após já ter injetado)", () => {
    const withBadge = injectRegeneratingBadge(baseHtml, "<div>⏳ regenerando</div>");
    const withoutBadge = injectRegeneratingBadge(withBadge, null);
    assert.equal(withoutBadge, baseHtml);
  });

  it("fallback: HTML sem <body> recebe o badge prefixado, sem lançar", () => {
    const noBody = "<div>sem body</div>";
    const out = injectRegeneratingBadge(noBody, "<div>⏳ regenerando</div>");
    assert.ok(out.indexOf("<div>⏳ regenerando</div>") < out.indexOf("<div>sem body</div>"));
    assert.match(out, /sem body/);
  });
});

describe("integração — ciclo completo de uma cascata (#8123 Fatia 4)", () => {
  it("texto servível desde o início (badge presente); badge some sozinho quando tudo resolve", () => {
    withStatusPath((p) => {
      // 1. título mudou — orchestrator declara a cascata.
      let status = startCascade(p, {
        highlight: "d1",
        reason: "título alterado",
        pieces: ["image", "carousel", "social"],
      });

      // 2. preview de TEXTO servido imediatamente, com badge — nada aqui
      //    depende de image-generate.ts/gen-carousel-cards.ts/social-writer
      //    terem rodado ainda (é o comportamento que a issue pede).
      let html = injectRegeneratingBadge(
        "<html><body><article>D1 texto novo</article></body></html>",
        buildRegeneratingBadgeHtml(status),
      );
      assert.match(html, /regenerando em segundo plano/);
      assert.match(html, /D1 texto novo/);

      // 3. peças terminam em background, uma de cada vez.
      status = markPiece(p, "d1", "image", "done")!;
      status = markPiece(p, "d1", "carousel", "done")!;
      html = injectRegeneratingBadge(html, buildRegeneratingBadgeHtml(status));
      assert.match(html, /texto social/); // só falta social
      assert.doesNotMatch(html, /imagem, /);

      status = markPiece(p, "d1", "social", "done")!;
      assert.equal(isCascadePending(status), false);
      html = injectRegeneratingBadge(html, buildRegeneratingBadgeHtml(status));
      assert.doesNotMatch(html, /regenerando em segundo plano/);

      clearCascadeStatus(p);
      assert.equal(readCascadeStatus(p), null);
    });
  });
});
