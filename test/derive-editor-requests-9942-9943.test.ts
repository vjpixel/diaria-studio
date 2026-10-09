/**
 * #9942 — score igual sem bônus não prova que é a mesma história: troca real
 * de destaque (75/75 → 75/75, histórias distintas) não pode virar `link-swap`
 * `fonte-trocada`, nem pelo ramo `official:` (radar 78 de 261007).
 *
 * #9943 — item que só muda de seção (RADAR → LANÇAMENTOS) ou é promovido a
 * destaque não vira `pool-cut` + `pool-add` no diff da newsletter; a mudança
 * de seção sai como `bucket-move` e não conta 2x com o `bucket-move` do
 * `01-approved.json` (dedupe).
 *
 * Fixtures no formato real do `01-approved.json` e do `02-reviewed.md`
 * (data/ não vai pro CI).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyApprovedDiff,
  classifyNewsletterDiff,
  dedupeDestaqueSwaps,
  sourceUpgradeAliases,
} from "../scripts/derive-editor-requests.ts";

interface Item {
  url: string;
  title: string;
  source?: string;
  score: number | null;
  score_base?: number;
  bonuses_applied?: string[];
  cluster_sources?: Array<{ url: string }>;
}

const approved = (items: Item[], pool: Record<string, Array<{ url: string; title: string }>> = {}) =>
  JSON.stringify({
    highlights: items.map((it, i) => ({
      rank: i + 1,
      score: it.score,
      bucket: "noticias",
      url: it.url,
      article: {
        url: it.url,
        title: it.title,
        ...(it.source ? { source: it.source } : {}),
        score: it.score,
        ...(it.score_base !== undefined ? { score_base: it.score_base } : {}),
        ...(it.bonuses_applied !== undefined ? { bonuses_applied: it.bonuses_applied } : {}),
        ...(it.cluster_sources ? { cluster_sources: it.cluster_sources } : {}),
      },
    })),
    ...pool,
  });

const destaque = (n: number, it: { title: string; url: string }) =>
  [`**DESTAQUE ${n} | 🚀 LANÇAMENTO**`, "", `**[${it.title}](${it.url})**`, "", `Corpo de ${it.title}.`, "", "Por que isso importa:", "", "Texto estável.", "", "---", ""].join("\n");

const newsletter = (items: Array<{ title: string; url: string }>) => items.map((it, i) => destaque(i + 1, it)).join("\n");

const summary = (out: Array<{ request_type: string; target: string }>) => out.map((r) => `${r.target}:${r.request_type}`);

function derive(oldItems: Item[], newItems: Item[]) {
  const oa = approved(oldItems);
  const na = approved(newItems);
  const nl = classifyNewsletterDiff(newsletter(oldItems), newsletter(newItems), sourceUpgradeAliases(oa, na));
  return dedupeDestaqueSwaps([...nl, ...classifyApprovedDiff(oa, na)]);
}

const MISTRAL: Item = { url: "https://mistral.ai/news/mistral-large-4/", title: "Introducing Mistral Large 4", source: "Mistral AI News", score: 88, score_base: 70, bonuses_applied: ["impact_routine:+10"] };
const CANALTECH_75: Item = { url: "https://canaltech.com.br/inteligencia-artificial/nova-ia-da-meta-esta-mapeando/", title: "Nova IA da Meta está mapeando", source: "Canaltech (IA)", score: 75, score_base: 75 };
const EXAME_75: Item = { url: "https://exame.com/inteligencia-artificial/bancos-brasileiros-adotam-agentes/", title: "Bancos brasileiros adotam agentes", source: "Exame", score: 75, score_base: 75 };

describe("#9942 score igual sem bônus não é a mesma história", () => {
  it("75/75 → 75/75 de histórias distintas (approved) → destaque-swap, não link-swap", () => {
    const out = classifyApprovedDiff(approved([MISTRAL, CANALTECH_75]), approved([MISTRAL, EXAME_75]));
    assert.deepEqual(summary(out), ["d2:destaque-swap"]);
  });

  it("75/75 → 75/75 sem bônus: sourceUpgradeAliases não cria alias", () => {
    assert.equal(sourceUpgradeAliases(approved([CANALTECH_75]), approved([EXAME_75])).size, 0);
  });

  it("75/75 → 75/75 no diff completo (newsletter + approved) → 1 destaque-swap, zero link-swap", () => {
    const out = derive([MISTRAL, CANALTECH_75], [MISTRAL, EXAME_75]);
    assert.deepEqual(summary(out), ["d2:destaque-swap"]);
  });

  it("ramo official: score 78 = score_base 78 sem bônus, outra história → destaque-swap", () => {
    const radar: Item = { url: "https://canaltech.com.br/inteligencia-artificial/outra-historia/", title: "Outra história", source: "Canaltech (IA)", score: 78, score_base: 78 };
    const oficial: Item = { url: "https://openai.com/index/decisions-api/", title: "Decisions API", source: "official: OpenAI", score: 78, score_base: 78 };
    const out = derive([MISTRAL, radar], [MISTRAL, oficial]);
    assert.deepEqual(summary(out), ["d2:destaque-swap"]);
  });

  it("ramo official: score igual mas bônus diferentes → destaque-swap", () => {
    const a: Item = { url: "https://canaltech.com.br/a/", title: "A", score: 80, score_base: 70, bonuses_applied: ["impact_routine:+10"] };
    const b: Item = { url: "https://openai.com/index/b/", title: "B", source: "official: OpenAI", score: 80, score_base: 72, bonuses_applied: ["hands_on:+8"] };
    assert.deepEqual(summary(classifyApprovedDiff(approved([MISTRAL, a]), approved([MISTRAL, b]))), ["d2:destaque-swap"]);
  });

  it("sem bônus, mas URL nova está em cluster_sources do item antigo → link-swap (mesma história)", () => {
    const novo = "https://openai.com/index/meta-mapping/";
    const antigo: Item = { ...CANALTECH_75, cluster_sources: [{ url: novo }] };
    const oficial: Item = { ...CANALTECH_75, url: novo, source: "official: Meta" };
    assert.deepEqual(summary(classifyApprovedDiff(approved([MISTRAL, antigo]), approved([MISTRAL, oficial]))), ["d2:link-swap"]);
  });

  it("sem bônus, mesmo título e mesmo score → link-swap (o editor só trocou a URL)", () => {
    const oficial: Item = { ...CANALTECH_75, url: "https://about.fb.com/news/2026/10/meta-ai-mapping/" };
    assert.deepEqual(summary(classifyApprovedDiff(approved([MISTRAL, CANALTECH_75]), approved([MISTRAL, oficial]))), ["d2:link-swap"]);
  });
});

// --- #9943 ---------------------------------------------------------------

function poolItem(title: string, url: string, desc: string): string {
  return [`**[${title}](${url})**  `, desc, ""].join("\n");
}
function poolSection(header: string, items: string[]): string {
  return ["---", "", header, "", ...items, "---", ""].join("\n");
}

const A = { title: "Como usar IA para produtividade", url: "https://querobolsa.com.br/revista/como-usar-ia" };
const B = { title: "Ideias de mochila maluca infantil", url: "https://www.techtudo.com.br/guia/2026/10/mochila.ghtml" };
const E = { title: "Decisions API is now available", url: "https://community.openai.com/t/decisions-api/1403877" };
const X = { title: "Introducing Mistral Large 4", url: "https://mistral.ai/news/mistral-large-4/" };
const Z = { title: "GPT-6 and Intelligent UI for everyone", url: "https://openai.com/index/gpt-6-for-everyone" };
const pi = (it: { title: string; url: string }) => poolItem(it.title, it.url, `Descrição de ${it.title}.`);

const md = (opts: { d1: { title: string; url: string }; lanc: Array<{ title: string; url: string }>; radar: Array<{ title: string; url: string }> }) =>
  [
    destaque(1, opts.d1),
    poolSection("**🚀 LANÇAMENTOS**", opts.lanc.map(pi)),
    poolSection("**📡 RADAR**", opts.radar.map(pi)),
  ].join("\n");

const full = (out: Array<{ request_type: string; target: string; context?: Record<string, unknown> }>) =>
  out.map((r) => `${r.target}:${r.request_type}${r.context?.change_kind ? `:${r.context.change_kind}` : ""}`);

describe("#9943 item que só muda de seção não vira pool-cut + pool-add", () => {
  it("RADAR → LANÇAMENTOS (newsletter) → 1 bucket-move, zero pool-cut/pool-add", () => {
    const out = classifyNewsletterDiff(md({ d1: Z, lanc: [X], radar: [A, E, B] }), md({ d1: Z, lanc: [X, E], radar: [A, B] }));
    const types = full(out);
    assert.deepEqual(types, ["lancamentos:bucket-move:item-movido"]);
    assert.equal((out[0].context as any).from_section, "radar");
    assert.equal((out[0].context as any).url, E.url);
  });

  it("RADAR → LANÇAMENTOS com 01-approved.json também atualizado → 1 bucket-move só (dedupe)", () => {
    const nl = classifyNewsletterDiff(md({ d1: Z, lanc: [X], radar: [A, E, B] }), md({ d1: Z, lanc: [X, E], radar: [A, B] }));
    const oa = approved([], { lancamento: [X], radar: [A, E, B] });
    const na = approved([], { lancamento: [X, E], radar: [A, B] });
    const ap = classifyApprovedDiff(oa, na);
    assert.deepEqual(summary(ap), ["lancamentos:bucket-move"], "pré-condição: o approved emite bucket-move");
    const out = dedupeDestaqueSwaps([...nl, ...ap]);
    assert.deepEqual(summary(out), ["lancamentos:bucket-move"]);
  });

  it("item do RADAR promovido a destaque → só o destaque-swap, nada no RADAR", () => {
    const out = classifyNewsletterDiff(md({ d1: Z, lanc: [X], radar: [A, E] }), md({ d1: E, lanc: [X], radar: [A] }));
    assert.deepEqual(summary(out), ["d1:destaque-swap"]);
  });

  it("destaque demovido pro RADAR → nada no RADAR (destaque-* já reporta)", () => {
    const out = classifyNewsletterDiff(md({ d1: E, lanc: [X], radar: [A] }), md({ d1: Z, lanc: [X], radar: [A, E] }));
    assert.deepEqual(summary(out), ["d1:destaque-swap"]);
  });

  it("move + corte real no mesmo RADAR → pool-cut só do cortado + bucket-move do movido", () => {
    const out = classifyNewsletterDiff(md({ d1: Z, lanc: [X], radar: [A, E, B] }), md({ d1: Z, lanc: [X, E], radar: [A] }));
    const types = full(out);
    assert.deepEqual(types.sort(), ["lancamentos:bucket-move:item-movido", "radar:pool-cut:itens-cortados"]);
    const cut = out.find((r) => r.request_type === "pool-cut")!;
    assert.equal((cut.context as any).items_removed, 1);
  });

  it("corte real sem movimentação continua pool-cut (#9879)", () => {
    const out = classifyNewsletterDiff(md({ d1: Z, lanc: [X], radar: [A, E, B] }), md({ d1: Z, lanc: [X], radar: [A, B] }));
    assert.deepEqual(full(out), ["radar:pool-cut:itens-cortados"]);
  });
});

// --- #9949 ---------------------------------------------------------------

describe("#9949 seção só com item movido não descarta edição de outro item", () => {
  const C = { title: "Gemini 4 chega ao Workspace", url: "https://blog.google/products/workspace/gemini-4/" };
  const longo = "Descrição longa do lançamento, com detalhe de preço, disponibilidade e limites de uso. ".repeat(6).trim();
  const curto = "Descrição curta.";
  type It = { title: string; url: string };
  const mdDesc = (opts: { d1: It; lanc: Array<[It, string]>; radar: Array<[It, string]> }) =>
    [
      destaque(1, opts.d1),
      poolSection("**🚀 LANÇAMENTOS**", opts.lanc.map(([it, d]) => poolItem(it.title, it.url, d))),
      poolSection("**📡 RADAR**", opts.radar.map(([it, d]) => poolItem(it.title, it.url, d))),
    ].join("\n");
  const dA = `Descrição de ${A.title}.`;
  const dB = `Descrição de ${B.title}.`;

  it("cenário da issue: A LANÇAMENTOS → RADAR + C encurtado → bucket-move + length-cut em lancamentos", () => {
    const out = classifyNewsletterDiff(
      mdDesc({ d1: Z, lanc: [[A, dA], [C, longo]], radar: [[B, dB]] }),
      mdDesc({ d1: Z, lanc: [[C, curto]], radar: [[B, dB], [A, dA]] }),
    );
    assert.deepEqual(full(out).sort(), ["lancamentos:length-cut", "radar:bucket-move:item-movido"]);
    const cut = out.find((r) => r.request_type === "length-cut")!;
    assert.equal((cut.context as any).items_removed, undefined, "não é corte de item");
  });

  it("só movimentação, sem edição de outro item → nada além do bucket-move", () => {
    const out = classifyNewsletterDiff(
      mdDesc({ d1: Z, lanc: [[A, dA], [C, longo]], radar: [[B, dB]] }),
      mdDesc({ d1: Z, lanc: [[C, longo]], radar: [[B, dB], [A, dA]] }),
    );
    assert.deepEqual(full(out), ["radar:bucket-move:item-movido"]);
  });

  it("item do RADAR promovido a destaque + outro item do RADAR encurtado → destaque-swap + length-cut", () => {
    const out = classifyNewsletterDiff(
      mdDesc({ d1: Z, lanc: [[X, "x"]], radar: [[E, dA], [C, longo]] }),
      mdDesc({ d1: E, lanc: [[X, "x"]], radar: [[C, curto]] }),
    );
    assert.deepEqual(summary(out).sort(), ["d1:destaque-swap", "radar:length-cut"]);
  });

  it("item movido + outro item reescrito mais longo → lead-rewrite", () => {
    const out = classifyNewsletterDiff(
      mdDesc({ d1: Z, lanc: [[A, dA], [C, curto]], radar: [[B, dB]] }),
      mdDesc({ d1: Z, lanc: [[C, longo]], radar: [[B, dB], [A, dA]] }),
    );
    assert.deepEqual(full(out).sort(), ["lancamentos:lead-rewrite", "radar:bucket-move:item-movido"]);
  });
});
