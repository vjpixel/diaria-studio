/**
 * #9936 — trocar a URL de um destaque pela fonte (oficial) da MESMA história
 * não é `destaque-swap`. Fixtures no formato real do `01-approved.json`
 * (`highlights[]` com `rank/score/bucket/reason/url/article`) e do
 * `02-reviewed.md` (`**DESTAQUE N | ...**` + `**[título](url)**`), com as URLs
 * e a pontuação dos três casos reais: 261006 d1, 261007 d2, 261008 d1.
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
}

const approved = (items: Item[]) =>
  JSON.stringify({
    highlights: items.map((it, i) => ({
      rank: i + 1,
      score: it.score,
      bucket: "noticias",
      reason: "motivo",
      url: it.url,
      article: {
        url: it.url,
        title: it.title,
        ...(it.source ? { source: it.source } : {}),
        category: "noticias",
        score: it.score,
        ...(it.score_base !== undefined ? { score_base: it.score_base, bonuses_applied: it.bonuses_applied } : {}),
      },
    })),
  });

const newsletter = (items: Array<{ title: string; url: string; body?: string }>) =>
  items
    .map((it, i) =>
      [
        `**DESTAQUE ${i + 1} | 🚀 LANÇAMENTO**`,
        "",
        `**[${it.title}](${it.url})**`,
        "",
        it.body ?? `Corpo do destaque ${it.title}.`,
        "",
        "Por que isso importa:",
        "",
        "Texto estável.",
        "",
        "---",
        "",
      ].join("\n"),
    )
    .join("\n");

const summary = (out: Array<{ request_type: string; target: string }>) => out.map((r) => `${r.target}:${r.request_type}`);

/** Diff completo como o derive faz: aliases do approved → newsletter, + approved, + dedupe. */
function derive(oldItems: Item[], newItems: Item[], oldNl = oldItems, newNl = newItems) {
  const oa = approved(oldItems);
  const na = approved(newItems);
  const nl = classifyNewsletterDiff(newsletter(oldNl), newsletter(newNl), sourceUpgradeAliases(oa, na));
  return dedupeDestaqueSwaps([...nl, ...classifyApprovedDiff(oa, na)]);
}

// --- 261006: GPTs personalizados, Canaltech → help.openai.com (mesmo source/score), movido de D3 para D1.
const EXAME: Item = { url: "https://exame.com/inteligencia-artificial/40-das-empresas-podem-desativar-agentes-de-ia-ate-2027-por-falhas-de-governanca-aponta-pesquisa/", title: "40% das empresas", source: "Exame", score: 85, score_base: 67, bonuses_applied: ["impact_routine:+10", "hands_on:+8"] };
const GUARDIAN: Item = { url: "https://www.theguardian.com/technology/2026/oct/03/openai-review-hacks-australian-government-sites-costing-500000-a-day", title: "OpenAI says its review", source: "The Guardian (AI)", score: 77, score_base: 59, bonuses_applied: ["impact_routine:+10"] };
const GPTS_CANALTECH: Item = { url: "https://canaltech.com.br/inteligencia-artificial/por-que-a-openai-desistiu-dos-gpts-personalizados/", title: "Por que a OpenAI desistiu dos GPTs personalizados", source: "Canaltech (IA)", score: 80, score_base: 62, bonuses_applied: ["impact_routine:+10", "hands_on:+8"] };
const GPTS_OFICIAL: Item = { ...GPTS_CANALTECH, url: "https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq" };

// --- 261007: ChatGPT carimba textos, Canaltech → openai.com (source "official: OpenAI"), movido de D1 para D2.
const CHATGPT_CANALTECH: Item = { url: "https://canaltech.com.br/inteligencia-artificial/chatgpt-copia-o-claude-e-tambem-comeca-a-carimbar-textos-feitos-por-sua-ia/", title: "ChatGPT copia o Claude e também começa a \"carimbar\" textos", source: "Canaltech (IA)", score: 91, score_base: 68, bonuses_applied: ["impact_routine:+10", "impact_routine_br:+5", "hands_on:+8"] };
const CHATGPT_OFICIAL: Item = { ...CHATGPT_CANALTECH, url: "https://openai.com/index/eu-text-provenance/", title: "Our approach to EU text provenance rules", source: "official: OpenAI" };
const MISTRAL: Item = { url: "https://mistral.ai/news/mistral-large-4/", title: "Introducing Mistral Large 4", source: "Mistral AI News", score: 88, score_base: 70, bonuses_applied: ["impact_routine:+10"] };
const META: Item = { url: "https://canaltech.com.br/inteligencia-artificial/nova-ia-da-meta-esta-mapeando-e-fichando-todos-os-seus-amigos-e-familiares/", title: "Nova IA da Meta está mapeando", source: "Canaltech (IA)", score: 75, score_base: 65 };

// --- 261008: Haiku 5.5, VentureBeat → anthropic.com (mesmo source/score) + Nano Banana 2.1 de fora dos finalistas (score null).
const GPT6: Item = { url: "https://openai.com/index/gpt-6-for-everyone", title: "GPT-6 and Intelligent UI for everyone", source: "OpenAI", score: 98, score_base: 80, bonuses_applied: ["impact_routine:+10"] };
const CLAUDE_DOCS: Item = { url: "https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides", title: "Claude now works with Google Docs", source: "inbox_newsletter:TLDR AI", score: 87, score_base: 69, bonuses_applied: ["impact_routine:+10"] };
const HAIKU_VB: Item = { url: "https://venturebeat.com/technology/anthropic-launches-claude-haiku-5-5-with-90-api-price-reduction-matching-gpt-6-luna", title: "Anthropic launches Claude Haiku 5.5", source: "VentureBeat (IA)", score: 90, score_base: 80, bonuses_applied: ["impact_routine:+10"] };
const HAIKU_OFICIAL: Item = { ...HAIKU_VB, url: "https://www.anthropic.com/claude-haiku-5-5", title: "Haiku 5.5 supera o Sonnet 5 e custa até 95% menos" };
const NANO_BANANA: Item = { url: "https://deepmind.google/models/model-cards/nano-banana-2-1/", title: "Nano Banana 2.1 bate o Pro, mas tropeça no texto", score: null };

describe("#9936 troca de fonte da mesma história não conta como destaque-swap (casos reais)", () => {
  it("261006: GPTs Canaltech → help.openai.com, com reordenação → 1 link-swap em d1, zero destaque-swap", () => {
    const out = derive([EXAME, GUARDIAN, GPTS_CANALTECH], [GPTS_OFICIAL, EXAME, GUARDIAN]);
    const types = summary(out);
    assert.equal(types.filter((t) => t.endsWith(":destaque-swap")).length, 0, types.join(", "));
    assert.deepEqual(types.filter((t) => t.endsWith(":link-swap")), ["d1:link-swap"]);
    const swap = out.find((r) => r.request_type === "link-swap")!;
    assert.equal((swap.context as any).old_url, GPTS_CANALTECH.url);
    assert.equal((swap.context as any).new_url, GPTS_OFICIAL.url);
    assert.equal((swap.context as any).change_kind, "fonte-trocada");
    // a reordenação continua registrada
    assert.ok(types.includes("newsletter:section-order"), types.join(", "));
  });

  it("261007: ChatGPT Canaltech → openai.com (source official:), com reordenação → 1 link-swap em d2, zero destaque-swap", () => {
    const out = derive([CHATGPT_CANALTECH, MISTRAL, META], [META, CHATGPT_OFICIAL, MISTRAL]);
    const types = summary(out);
    assert.equal(types.filter((t) => t.endsWith(":destaque-swap")).length, 0, types.join(", "));
    assert.deepEqual(types.filter((t) => t.endsWith(":link-swap")), ["d2:link-swap"]);
    assert.match(out.find((r) => r.request_type === "link-swap")!.description, /fonte oficial/);
  });

  it("261008: Haiku VentureBeat → anthropic.com + Nano Banana de fora dos finalistas → link-swap em d1 e só 1 destaque-swap (d2)", () => {
    const out = derive([GPT6, CLAUDE_DOCS, HAIKU_VB], [HAIKU_OFICIAL, NANO_BANANA, GPT6]);
    const types = summary(out);
    assert.deepEqual(types.filter((t) => t.endsWith(":destaque-swap")), ["d2:destaque-swap"]);
    assert.deepEqual(types.filter((t) => t.endsWith(":link-swap")), ["d1:link-swap"]);
  });

  it("troca de fonte no MESMO slot conta 1x (newsletter + approved deduplicados)", () => {
    const out = derive([EXAME, GPTS_CANALTECH, GUARDIAN], [EXAME, GPTS_OFICIAL, GUARDIAN]);
    assert.deepEqual(summary(out), ["d2:link-swap"]);
    // a entrada mantida é a da newsletter (traz section/change_kind)
    assert.equal((out[0].context as any).section, "destaque-2");
    assert.equal((out[0].context as any).change_kind, "fonte-trocada");
  });
});

describe("#9936 o que continua sendo destaque-swap", () => {
  it("item novo com score diferente (outra história) → destaque-swap", () => {
    const out = derive([EXAME, GUARDIAN, GPTS_CANALTECH], [EXAME, GUARDIAN, MISTRAL]);
    assert.deepEqual(summary(out), ["d3:destaque-swap"]);
  });

  it("score igual por coincidência, sem score_base/bonuses iguais nem source official → destaque-swap", () => {
    const outro: Item = { url: "https://example.com/outra-historia", title: "Outra", source: "Canaltech (IA)", score: 80, score_base: 70, bonuses_applied: ["hands_on:+8"] };
    const out = classifyApprovedDiff(approved([EXAME, GPTS_CANALTECH]), approved([EXAME, outro]));
    assert.deepEqual(summary(out), ["d2:destaque-swap"]);
  });

  it("item de fora dos finalistas (score null) → destaque-swap", () => {
    const out = classifyApprovedDiff(approved([GPT6, CLAUDE_DOCS]), approved([GPT6, NANO_BANANA]));
    assert.deepEqual(summary(out), ["d2:destaque-swap"]);
  });

  it("sem aliases (approved ausente), a newsletter mantém o comportamento anterior", () => {
    const out = classifyNewsletterDiff(newsletter([EXAME, GPTS_CANALTECH]), newsletter([EXAME, GPTS_OFICIAL]));
    assert.deepEqual(summary(out), ["d2:destaque-swap"]);
  });

  it("sourceUpgradeAliases: JSON inválido ou ausente → mapa vazio", () => {
    assert.equal(sourceUpgradeAliases(undefined, approved([EXAME])).size, 0);
    assert.equal(sourceUpgradeAliases("{nope", approved([EXAME])).size, 0);
  });
});

describe("#9936 dedupe não engole link-swap de pool", () => {
  it("link-swap do approved com target de pool não é descartado por link-swap da newsletter no mesmo bucket", () => {
    const entries = [
      { request_type: "link-swap" as const, target: "radar" as const, context: { section: "radar" } },
      { request_type: "link-swap" as const, target: "radar" as const, context: { old_url: "a", new_url: "b" } },
    ];
    assert.equal(dedupeDestaqueSwaps(entries).length, 2);
  });
});
