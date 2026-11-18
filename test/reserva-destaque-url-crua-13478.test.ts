/**
 * Regressão #13478: a reserva de destaque (#13331) entra com a URL
 * canonicalizada; o pool da pesquisa traz a mesma matéria crua (utm_*, barra
 * final). O match exato do 1h falha, a reserva vira item separado e o
 * dedup Pass 2a junta os dois — o vencedor (item do researcher, título mais
 * longo) perdia `editor_destaque_request` e `reserved_from`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedup } from "../scripts/dedup.ts";
import { mergeInjectedIntoPool } from "../scripts/inject-inbox-urls.ts";
import { mergeReservationsIntoInjected, type ReservedDestaque } from "../scripts/lib/reserved-destaques.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

const RAW = "https://www.example.com/noticia/chips-eua/?utm_source=rss&utm_medium=feed";

const reserva: ReservedDestaque = {
  url: RAW,
  title: "Brasil vai precisar de licença dos EUA para chips",
  request: "d1",
  from_edition: "261117",
  from_destaque: "d2",
  package_dir: "_internal/reserved-destaques/d1",
  reserved_at: "2026-11-17T20:00:00Z",
};

describe("reserva de destaque com URL crua no pool (#13478)", () => {
  it("o vencedor do dedup herda editor_destaque_request e reserved_from", () => {
    const { injected } = mergeReservationsIntoInjected([], [reserva]);
    const pool = [
      {
        url: RAW,
        title: "Brasil vai precisar de licença dos Estados Unidos para importar chips de IA",
        summary: "Resumo do researcher.",
        source: "Fonte Cadastrada",
      },
    ];
    const { merged, newInjected } = mergeInjectedIntoPool(pool, injected as never);
    // pré-condição do cenário: URL crua ≠ canonicalizada, a reserva vira item separado
    assert.equal(newInjected.length, 1);
    assert.notEqual(newInjected[0].url, RAW);

    const r = dedup(merged as never, new Set(), 0.85);
    assert.equal(r.kept.length, 1);
    const kept = r.kept[0] as Record<string, unknown>;
    assert.equal(kept.title, pool[0].title); // vencedor segue sendo o do researcher
    assert.equal(kept.editor_destaque_request, "d1");
    assert.equal(kept.reserved_from, "261117/d2");
    assert.equal(kept.flag, "editor_submitted");
  });

  it("pedido já presente no vencedor não é sobrescrito", () => {
    const a = { url: RAW, title: "Título bem mais longo do item vencedor do grupo", editor_destaque_request: "d2" };
    const b = { url: canonicalize(RAW), title: "Curto", editor_destaque_request: "d1", reserved_from: "261117/d2" };
    const r = dedup([a, b] as never, new Set(), 0.85);
    assert.equal(r.kept.length, 1);
    const kept = r.kept[0] as Record<string, unknown>;
    assert.equal(kept.editor_destaque_request, "d2");
    assert.equal(kept.reserved_from, "261117/d2");
  });

  it("match exato no 1h copia reserved_from junto com o pedido", () => {
    const { injected } = mergeReservationsIntoInjected([], [reserva]);
    const canon = injected[0].url;
    const pool = [{ url: canon, title: "Item do researcher" }];
    const { merged, newInjected } = mergeInjectedIntoPool(pool, injected as never);
    assert.equal(newInjected.length, 0);
    const item = merged[0] as Record<string, unknown>;
    assert.equal(item.editor_destaque_request, "d1");
    assert.equal(item.reserved_from, "261117/d2");
  });
});
