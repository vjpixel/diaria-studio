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
  dedupDestaquesByUrl,
  unscoredCount,
  unixToEdition,
  isRealEditionTitle,
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
  // `score` é `number | undefined` (não `| null`): as duas formas
  // significariam "ainda não pontuado" e o tipo passou a ter só uma.
  const d = (month: string, edition: string, position: number, score?: number): AnnualDestaque => ({
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
    const list = [d("2601", "260110", 1), d("2601", "260111", 1, 80)];
    const out = topKPerMonth(list, 2);
    assert.deepEqual(out.map((x) => x.edition), ["260111", "260110"]);
    assert.equal(unscoredCount(list), 1);
  });

  it("K inválido falha alto", () => {
    assert.throws(() => topKPerMonth([], 0), /top-K inválido/);
  });
});

describe("dedup de destaques por URL (#7587 item 5)", () => {
  // `score` é `number | undefined`, mesma disciplina do bloco acima.
  const d = (edition: string, position: number, url: string, score?: number): AnnualDestaque => ({
    edition,
    month: edition.slice(0, 4),
    position,
    category: "IA",
    title: `${edition}-${position}`,
    url,
    body: "",
    why: "",
    is_brazil: false,
    score,
  });

  it("5 cópias da mesma matéria (caso real: agosto/2026) viram 1 — 1ª ocorrência vence", () => {
    // Réplica do achado ao vivo: "Brasil investe R$ 2,3 bi em infraestrutura"
    // repetido 5x no pool de agosto/2026, sobrando só 6 itens únicos pro
    // top-K de 10 do mês.
    const url = "https://exemplo.com/brasil-investe-2-3-bi";
    const copias = Array.from({ length: 5 }, (_, i) => d("260825", i + 1, url));
    const unico = d("260826", 1, "https://exemplo.com/outra-materia");
    const out = dedupDestaquesByUrl([...copias, unico]);
    assert.equal(out.length, 2);
    assert.equal(out[0].edition, "260825");
    assert.equal(out[0].position, 1, "mantém a 1ª ocorrência, não uma arbitrária");
  });

  it("mesma matéria republicada em edições diferentes também deduplica", () => {
    const url = "https://exemplo.com/materia-desdobrada";
    const out = dedupDestaquesByUrl([d("260810", 1, url), d("260901", 2, url)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].edition, "260810");
  });

  it("URLs diferentes (mesmo domínio/path parecido) não são fundidas por engano", () => {
    const out = dedupDestaquesByUrl([
      d("260810", 1, "https://exemplo.com/artigo-a"),
      d("260810", 2, "https://exemplo.com/artigo-b"),
    ]);
    assert.equal(out.length, 2);
  });

  it("querystring de tracking não impede o dedup (mesma matéria, UTM diferente)", () => {
    const out = dedupDestaquesByUrl([
      d("260810", 1, "https://exemplo.com/artigo?utm_source=a"),
      d("260811", 1, "https://exemplo.com/artigo?utm_source=b"),
    ]);
    assert.equal(out.length, 1);
  });

  it("destaque sem URL nunca é descartado — não tem identidade pra comparar", () => {
    const semUrl1 = d("260810", 1, "");
    const semUrl2 = d("260811", 1, "");
    const out = dedupDestaquesByUrl([semUrl1, semUrl2]);
    assert.equal(out.length, 2);
  });

  it("roda ANTES do top-K: sem dedup, 5 cópias sozinhas encheriam o corte de um mês pequeno", () => {
    const url = "https://exemplo.com/repetido";
    const copias = Array.from({ length: 5 }, (_, i) => d("260825", i + 1, url, 90 - i));
    const outros = [d("260826", 1, "https://exemplo.com/a", 10), d("260827", 1, "https://exemplo.com/b", 5)];
    const semDedup = topKPerMonth([...copias, ...outros], 3);
    assert.equal(semDedup.filter((x) => x.url === url).length, 3, "sem dedup, as cópias dominam o top-K");

    const comDedup = topKPerMonth(dedupDestaquesByUrl([...copias, ...outros]), 3);
    assert.equal(comDedup.filter((x) => x.url === url).length, 1);
    assert.equal(comDedup.length, 3, "com dedup, os outros 2 itens únicos entram no corte");
  });
});

describe("isRealEditionTitle — exclusão de não-edições (#8035, 266→253)", () => {
  it("probe/teste do Kit (título começando com '[') é excluído", () => {
    assert.equal(isRealEditionTitle("[teste-464] bare style fragment probe"), false);
    assert.equal(isRealEditionTitle("[probe-rodape] centralizar footer do Kit"), false);
    assert.equal(isRealEditionTitle("[probe-6047] ajuste de layout"), false);
    assert.equal(isRealEditionTitle("[teste] Nvidia diz que a AGI chegou"), false);
  });

  it("cópia segmentada da mesma edição ('- patronos'/'- apoiadores') é excluída", () => {
    assert.equal(isRealEditionTitle("Empresas recontratam quem demitiu por IA - patronos"), false);
    assert.equal(isRealEditionTitle("Empresas recontratam quem demitiu por IA - Patronos"), false);
    assert.equal(isRealEditionTitle("Retrospectiva de agosto - apoiadores"), false);
  });

  it("e-mail institucional (pedido de ajuda/agradecimento) é excluído", () => {
    assert.equal(isRealEditionTitle("Quero pedir sua ajuda, leva só 1 minuto =)"), false);
    assert.equal(isRealEditionTitle("Nos ajude a manter a Diar.ia gratuita"), false);
    assert.equal(isRealEditionTitle("Agradecimento: sorteio de livro"), false);
  });

  it("título de edição normal é contado", () => {
    assert.equal(isRealEditionTitle("OpenAI lança Sora 2"), true);
    assert.equal(isRealEditionTitle("Empresas recontratam quem demitiu por IA"), true);
    // hífen legítimo no fim de um título real não deve casar com o sufixo de segmento
    assert.equal(isRealEditionTitle("O futuro do trabalho -"), true);
  });

  it("título ausente/vazio não é excluído (sem texto pra casar contra os padrões)", () => {
    assert.equal(isRealEditionTitle(undefined), true);
    assert.equal(isRealEditionTitle(null), true);
    assert.equal(isRealEditionTitle(""), true);
    assert.equal(isRealEditionTitle("   "), true);
  });

  it("groupPostsByMonth aplica o filtro — probes/segmentos/institucionais não contam como edição", () => {
    const months = ["2608"];
    const dia = unix("2026-08-25T00:00:00Z");
    const posts = [
      post({ slug: "real", title: "OpenAI lança Sora 2", publish_date: dia }),
      post({ slug: "probe1", title: "[teste-464] bare style fragment probe", publish_date: dia }),
      post({ slug: "probe2", title: "[probe-rodape] centralizar footer do Kit", publish_date: unix("2026-08-24T00:00:00Z") }),
      post({ slug: "segmentada", title: "OpenAI lança Sora 2 - patronos", publish_date: unix("2026-08-24T00:00:00Z") }),
      post({ slug: "ajuda", title: "Quero pedir sua ajuda, leva só 1 minuto =)", publish_date: unix("2026-08-24T00:00:00Z") }),
      post({ slug: "agradecimento", title: "Agradecimento: sorteio de livro", publish_date: unix("2026-08-24T00:00:00Z") }),
    ];
    const g = groupPostsByMonth(posts, months);
    assert.equal(g.get("2608")!.length, 1, "só a edição real entra na contagem do mês");
    assert.equal(g.get("2608")![0].slug, "real");
  });
});
