/**
 * test/annual-collect.test.ts (#7569)
 *
 * Dois riscos que estes testes cobrem:
 *
 * 1. **Datar por `publish_date`** — as edições importadas de agosto/2025
 *    carregam a data da importação (04/09/2025) nesse campo. Um recorte por
 *    mês que caia nessa armadilha some com agosto inteiro da retrospectiva
 *    de aniversário, que é justamente o mês do aniversário.
 * 2. **Cortar o top-K globalmente** em vez de por mês — os meses gordos
 *    (24 edições) abafariam os magros (3 edições no mês de estreia).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UnifiedCachedPost } from "../scripts/lib/shared/edition-cache-reader.ts";
import {
  groupPostsByMonth,
  postEdition,
  topKPerMonth,
  unscoredCount,
  unixToEdition,
  type AnnualDestaque,
} from "../scripts/lib/anual/annual-collect.ts";

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function post(p: Partial<UnifiedCachedPost>): UnifiedCachedPost {
  return { origin: "beehiiv", status: "confirmed", ...p };
}

describe("data editorial das edições importadas", () => {
  it("edição importada é datada por displayed_date, não pela importação", () => {
    // Caso real: publish_date = 04/09/2025 (dia da importação em bloco),
    // displayed_date = 27/08/2025 (a primeira edição de verdade).
    const importada = post({
      publish_date: unix("2025-09-04T00:00:00Z"),
      displayed_date: unix("2025-08-27T00:00:00Z"),
    });
    assert.equal(postEdition(importada), "250827");
  });

  it("edição normal (sem displayed_date) usa publish_date", () => {
    assert.equal(postEdition(post({ publish_date: unix("2026-07-15T00:00:00Z") })), "260715");
  });

  it("edição sem data nenhuma não vira uma data inventada", () => {
    assert.equal(postEdition(post({})), undefined);
  });

  it("unixToEdition não escorrega de dia", () => {
    assert.equal(unixToEdition(unix("2026-01-01T00:00:00Z")), "260101");
    assert.equal(unixToEdition(unix("2026-12-31T23:59:00Z")), "261231");
  });
});

describe("agrupamento por mês da janela", () => {
  const months = ["2508", "2509", "2510"];

  it("as importadas caem em agosto, não em setembro", () => {
    const posts = [
      post({ slug: "a", publish_date: unix("2025-09-04T00:00:00Z"), displayed_date: unix("2025-08-27T00:00:00Z") }),
      post({ slug: "b", publish_date: unix("2025-09-04T00:00:00Z"), displayed_date: unix("2025-08-28T00:00:00Z") }),
      post({ slug: "c", publish_date: unix("2025-09-10T00:00:00Z") }),
    ];
    const g = groupPostsByMonth(posts, months);
    assert.equal(g.get("2508")!.length, 2, "agosto/2025 tem as 2 importadas");
    assert.equal(g.get("2509")!.length, 1);
  });

  it("todo mês da janela aparece, inclusive o vazio", () => {
    const g = groupPostsByMonth([], months);
    assert.deepEqual([...g.keys()], months);
    assert.deepEqual([...g.values()].map((v) => v.length), [0, 0, 0]);
  });

  it("rascunho não entra (só status confirmed)", () => {
    const posts = [post({ status: "draft", publish_date: unix("2025-09-10T00:00:00Z") })];
    assert.equal(groupPostsByMonth(posts, months).get("2509")!.length, 0);
  });

  it("edição fora da janela é ignorada", () => {
    const posts = [post({ publish_date: unix("2026-05-10T00:00:00Z") })];
    const g = groupPostsByMonth(posts, months);
    assert.equal([...g.values()].flat().length, 0);
  });

  it("a mesma edição nos dois caches entra uma vez só", () => {
    // Cenário da rodada de janeiro/2027: a leitura vem de Beehiiv E de Kit, e
    // uma edição publicada nos dois lados tem URLs diferentes — deduplicar por
    // URL não pegaria. O que não muda é o dia e o título.
    const dia = unix("2025-09-10T00:00:00Z");
    const posts = [
      post({ origin: "beehiiv", title: "OpenAI lança Sora 2", web_url: "https://diaria.beehiiv.com/p/sora", publish_date: dia }),
      post({ origin: "kit", title: "OpenAI lança Sora 2", web_url: "https://news.diar.ia.br/posts/sora", publish_date: dia }),
    ];
    assert.equal(groupPostsByMonth(posts, months).get("2509")!.length, 1);
  });

  it("dois posts distintos no mesmo dia continuam sendo dois", () => {
    // Acontece de verdade: 14 dias da janela do 1º ano têm 2 edições.
    const dia = unix("2025-09-10T00:00:00Z");
    const posts = [
      post({ title: "AWS sofre queda", publish_date: dia }),
      post({ title: "Restrições do Sora 2 em Hollywood", publish_date: dia }),
    ];
    assert.equal(groupPostsByMonth(posts, months).get("2509")!.length, 2);
  });

  it("dedup ignora acento, caixa e pontuação do título", () => {
    const dia = unix("2025-09-10T00:00:00Z");
    const posts = [
      post({ title: "IA na educação: o que muda", publish_date: dia }),
      post({ origin: "kit", title: "IA NA EDUCACAO — O QUE MUDA", publish_date: dia }),
    ];
    assert.equal(groupPostsByMonth(posts, months).get("2509")!.length, 1);
  });

  it("post sem título entra em vez de ser descartado como duplicata", () => {
    const dia = unix("2025-09-10T00:00:00Z");
    const posts = [post({ publish_date: dia }), post({ publish_date: dia })];
    assert.equal(
      groupPostsByMonth(posts, months).get("2509")!.length,
      2,
      "sem título não dá pra afirmar que são a mesma edição — descartar seria pior",
    );
  });

  it("dentro do mês, as edições saem em ordem cronológica", () => {
    const posts = [
      post({ slug: "tarde", publish_date: unix("2025-09-20T00:00:00Z") }),
      post({ slug: "cedo", publish_date: unix("2025-09-02T00:00:00Z") }),
    ];
    assert.deepEqual(groupPostsByMonth(posts, months).get("2509")!.map((p) => p.slug), ["cedo", "tarde"]);
  });
});

describe("top-K por mês", () => {
  const d = (month: string, edition: string, position: number, score: number | null): AnnualDestaque => ({
    edition,
    month,
    position,
    category: "IA",
    title: `${edition}-${position}`,
    url: `https://exemplo.com/${edition}-${position}`,
    body: "",
    why: "",
    is_brazil: false,
    score,
  });

  it("o mês magro entra inteiro; o gordo é cortado no teto", () => {
    // Espelha a assimetria real: agosto/2025 tem 3 edições, julho/2026 tem 24.
    const magro = [d("2508", "250827", 1, 50), d("2508", "250828", 1, 40), d("2508", "250829", 1, 30)];
    const gordo = Array.from({ length: 30 }, (_, i) => d("2607", `2607${String(i + 1).padStart(2, "0")}`, 1, 90 - i));
    const out = topKPerMonth([...magro, ...gordo], 10);
    assert.equal(out.filter((x) => x.month === "2508").length, 3, "mês magro não é preenchido nem descartado");
    assert.equal(out.filter((x) => x.month === "2607").length, 10);
  });

  it("um corte GLOBAL apagaria o mês magro — é isto que o corte por mês evita", () => {
    const magro = [d("2508", "250827", 1, 10)];
    const gordo = Array.from({ length: 20 }, (_, i) => d("2607", `2607${String(i + 1).padStart(2, "0")}`, 1, 90));
    const out = topKPerMonth([...magro, ...gordo], 5);
    assert.ok(out.some((x) => x.month === "2508"), "o mês de estreia sobrevive apesar do score baixo");
  });

  it("ordena por score desc com desempate determinístico", () => {
    const same = [d("2601", "260115", 2, 70), d("2601", "260110", 1, 70), d("2601", "260110", 2, 70)];
    const out = topKPerMonth(same, 3).map((x) => `${x.edition}-${x.position}`);
    assert.deepEqual(out, ["260110-1", "260110-2", "260115-2"]);
  });

  it("destaque sem score fica atrás, mas não some quando há espaço", () => {
    const list = [d("2601", "260110", 1, null), d("2601", "260111", 1, 80)];
    const out = topKPerMonth(list, 2);
    assert.deepEqual(out.map((x) => x.edition), ["260111", "260110"]);
    assert.equal(unscoredCount(list), 1);
  });

  it("K inválido falha alto", () => {
    assert.throws(() => topKPerMonth([], 0), /top-K inválido/);
  });
});
