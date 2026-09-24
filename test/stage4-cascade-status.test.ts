/**
 * test/stage4-cascade-status.test.ts (#8123 Fatia 4; multi-highlight #8783)
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
 *
 * Teste de regressão do #8783: o desenho original guardava um único objeto
 * de cascata por arquivo — 2 `--start` sequenciais para highlights
 * DIFERENTES (D1↔D2 trocados na mesma rodada de "ajustar") faziam o 2º
 * sobrescrever o registro do 1º, perdendo o rastreio de D1 silenciosamente.
 * O grupo "múltiplos highlights concorrentes" abaixo reproduz esse cenário
 * exato e confirma que ambos permanecem rastreados.
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
      const state = startCascade(p, {
        highlight: "d1",
        reason: "título alterado",
        pieces: ["image", "carousel", "social"],
      });
      const elapsedMs = Date.now() - t0;
      assert.ok(elapsedMs < 500, `startCascade não deveria bloquear (levou ${elapsedMs}ms)`);
      assert.deepEqual(state.d1.pieces, { image: "pending", carousel: "pending", social: "pending" });
      assert.equal(isCascadePending(state), true);
    });
  });

  it("reiniciar o MESMO highlight sobrescreve só a entrada dele (só o ajuste mais recente DAQUELE destaque importa)", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "1º ajuste", pieces: ["image"] });
      const second = startCascade(p, { highlight: "d1", reason: "2º ajuste", pieces: ["social"] });
      const read = readCascadeStatus(p);
      assert.deepEqual(read?.d1.pieces, { social: "pending" });
      assert.equal(second.d1.reason, "2º ajuste");
    });
  });

  it("deduplica peças repetidas em --pieces", () => {
    withStatusPath((p) => {
      const state = startCascade(p, {
        highlight: "d3",
        reason: "x",
        pieces: ["image", "image", "carousel"],
      });
      assert.deepEqual(Object.keys(state.d3.pieces).sort(), ["carousel", "image"]);
    });
  });
});

describe("múltiplos highlights concorrentes (#8783 regressão)", () => {
  it("2 --start sequenciais em highlights DIFERENTES mantêm AMBOS rastreados (reprodução exata da issue)", () => {
    withStatusPath((p) => {
      // Reshuffle de 3 destaques na mesma rodada de "ajustar": D1, D2, D3
      // cada um abre a própria cascata em sequência.
      startCascade(p, { highlight: "d1", reason: "reordenação D1↔D2", pieces: ["image"] });
      startCascade(p, { highlight: "d2", reason: "reordenação D1↔D2", pieces: ["image"] });
      const afterD3 = startCascade(p, {
        highlight: "d3",
        reason: "promovido do RADAR",
        pieces: ["image", "carousel", "social"],
      });

      // Com o desenho pré-#8783 (objeto único), só d3 sobreviveria aqui.
      assert.deepEqual(Object.keys(afterD3).sort(), ["d1", "d2", "d3"]);

      const read = readCascadeStatus(p);
      assert.ok(read);
      assert.deepEqual(read!.d1.pieces, { image: "pending" });
      assert.deepEqual(read!.d2.pieces, { image: "pending" });
      assert.deepEqual(read!.d3.pieces, { image: "pending", carousel: "pending", social: "pending" });
      assert.equal(isCascadePending(read), true);
    });
  });

  it("--mark de um highlight não afeta o progresso de outro highlight em curso", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      startCascade(p, { highlight: "d2", reason: "y", pieces: ["image"] });

      const afterMark = markPiece(p, "d1", "image", "done");
      assert.equal(afterMark?.d1.pieces.image, "done");
      assert.equal(afterMark?.d2.pieces.image, "pending"); // intocado

      // d2 ainda pending → cascata inteira segue pending mesmo com d1 resolvido
      assert.equal(isCascadePending(afterMark), true);
    });
  });

  it("cascata inteira só fica não-pendente quando TODOS os highlights resolvem", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      startCascade(p, { highlight: "d2", reason: "y", pieces: ["social"] });

      let state = markPiece(p, "d1", "image", "done");
      assert.equal(isCascadePending(state), true); // d2 ainda pending

      state = markPiece(p, "d2", "social", "error"); // error também é terminal
      assert.equal(isCascadePending(state), false);
    });
  });

  it("--clear de UM highlight preserva os demais em curso", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      startCascade(p, { highlight: "d2", reason: "y", pieces: ["image"] });

      clearCascadeStatus(p, "d1");
      const read = readCascadeStatus(p);
      assert.ok(read);
      assert.deepEqual(Object.keys(read!), ["d2"]);
    });
  });

  it("--clear sem highlight remove TODAS as entradas", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      startCascade(p, { highlight: "d2", reason: "y", pieces: ["image"] });

      clearCascadeStatus(p);
      assert.equal(readCascadeStatus(p), null);
    });
  });

  it("--clear de um highlight que era a ÚLTIMA entrada remove o arquivo por completo", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      clearCascadeStatus(p, "d1");
      assert.equal(readCascadeStatus(p), null);
    });
  });

  it("badge agrega highlights distintos numa única linha, ordenados alfabeticamente", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d3", reason: "x", pieces: ["social"] });
      startCascade(p, { highlight: "d1", reason: "y", pieces: ["image", "carousel"] });
      const state = readCascadeStatus(p);
      const badge = buildRegeneratingBadgeHtml(state);
      assert.ok(badge);
      assert.match(badge!, /D1: imagem, carrossel · D3: texto social/);
    });
  });
});

describe("markPiece", () => {
  it("transiciona pending → done, cascata fica não-pendente quando todas resolvidas", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image", "social"] });
      let state = markPiece(p, "d1", "image", "done");
      assert.equal(state?.d1.pieces.image, "done");
      assert.equal(isCascadePending(state), true); // social ainda pending

      state = markPiece(p, "d1", "social", "done");
      assert.equal(isCascadePending(state), false);
    });
  });

  it("aceita 'error' como estado terminal (não fica pending pra sempre)", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d2", reason: "x", pieces: ["image"] });
      const state = markPiece(p, "d2", "image", "error");
      assert.equal(state?.d2.pieces.image, "error");
      assert.equal(isCascadePending(state), false);
    });
  });

  it("no-op fail-soft quando não há cascata alguma em curso", () => {
    withStatusPath((p) => {
      const result = markPiece(p, "d1", "image", "done");
      assert.equal(result, null);
    });
  });

  it("no-op fail-soft quando o highlight não tem cascata (mas outros têm) — devolve o estado atual intocado", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      const result = markPiece(p, "d2", "image", "done");
      // d2 nunca existiu — no-op, mas o estado de d1 é devolvido intocado
      assert.deepEqual(Object.keys(result ?? {}), ["d1"]);
      assert.equal(result?.d1.pieces.image, "pending");
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

  it("null quando todas as peças de todos os highlights já resolveram", () => {
    withStatusPath((p) => {
      startCascade(p, { highlight: "d1", reason: "x", pieces: ["image"] });
      const state = markPiece(p, "d1", "image", "done");
      assert.deepEqual(pendingPieceLabels(state?.d1), []);
      assert.equal(buildRegeneratingBadgeHtml(state), null);
    });
  });

  it("lista rótulos em PT-BR na ordem image→carousel→social, só das peças pending de uma entrada", () => {
    withStatusPath((p) => {
      const state = startCascade(p, {
        highlight: "d3",
        reason: "troca de destaque",
        pieces: ["social", "image"], // ordem de entrada não importa
      });
      assert.deepEqual(pendingPieceLabels(state.d3), ["imagem", "texto social"]);
      const badge = buildRegeneratingBadgeHtml(state);
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
      let state = startCascade(p, {
        highlight: "d1",
        reason: "título alterado",
        pieces: ["image", "carousel", "social"],
      });

      // 2. preview de TEXTO servido imediatamente, com badge — nada aqui
      //    depende de image-generate.ts/gen-carousel-cards.ts/social-writer
      //    terem rodado ainda (é o comportamento que a issue pede).
      let html = injectRegeneratingBadge(
        "<html><body><article>D1 texto novo</article></body></html>",
        buildRegeneratingBadgeHtml(state),
      );
      assert.match(html, /regenerando em segundo plano/);
      assert.match(html, /D1 texto novo/);

      // 3. peças terminam em background, uma de cada vez.
      state = markPiece(p, "d1", "image", "done")!;
      state = markPiece(p, "d1", "carousel", "done")!;
      html = injectRegeneratingBadge(html, buildRegeneratingBadgeHtml(state));
      assert.match(html, /texto social/); // só falta social
      assert.doesNotMatch(html, /imagem, /);

      state = markPiece(p, "d1", "social", "done")!;
      assert.equal(isCascadePending(state), false);
      html = injectRegeneratingBadge(html, buildRegeneratingBadgeHtml(state));
      assert.doesNotMatch(html, /regenerando em segundo plano/);

      clearCascadeStatus(p, "d1");
      assert.equal(readCascadeStatus(p), null);
    });
  });
});
