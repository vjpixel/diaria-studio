/**
 * #9381: destaque rebaixado ao pool leva o título da FONTE, não a manchete.
 * #9384: cluster_sources espelho (mesmo anúncio, outro domínio) não gera Aprofunde.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { swapInApprovedJson, toPoolItem, mirrorCappedSwapFallback } from "../scripts/swap-destaque.ts";
import { dropMirrorClusterSources } from "../scripts/lib/cluster-sources.ts";
import { applyStage2Caps, type ApprovedJson } from "../scripts/lib/apply-stage2-caps.ts";

test("#9381: toPoolItem troca manchete pelo título da fonte (caso 260929)", () => {
  const item = {
    title_options: ["Microsoft divide o Copilot em três frentes"],
    article: {
      url: "https://blogs.microsoft.com/x",
      title: "Introducing the new Copilot with Home, Code and Autopilot.",
      title_options: ["Microsoft divide o Copilot em três frentes"],
    },
  };
  const out = toPoolItem(item);
  assert.equal(out.title_options, undefined);
  const a = out.article as Record<string, unknown>;
  assert.equal(a.title_options, undefined);
  assert.equal(a.title, "Introducing the new Copilot with Home, Code and Autopilot");
  // não muta o original
  assert.ok(item.title_options);
});

test("#9381: swapInApprovedJson devolve o rebaixado ao bucket sem manchete", () => {
  const data: Record<string, unknown> = {
    highlights: [
      {
        title_options: ["Meta lança agente que trabalha pela sua empresa"],
        article: { url: "https://meta.com/a", title: "The Future Is for Everyone: Muse for Small Business" },
      },
    ],
    radar: [{ url: "https://x.com/b", title: "B" }],
  };
  const r = swapInApprovedJson(data, "radar" as never, 0, 0, false);
  assert.ok(r.ok);
  const radar = data.radar as Record<string, unknown>[];
  assert.equal(radar[0].title_options, undefined);
  // #9601: item de pool é FLAT (shape de `article`, sem wrapper de highlight).
  assert.equal(radar[0].article, undefined);
  assert.equal(radar[0].url, "https://meta.com/a");
  assert.equal(radar[0].title, "The Future Is for Everyone: Muse for Small Business");
});

test("#9381: fallback do capped também converte para item de pool", () => {
  const capped: Record<string, unknown> = {
    highlights: [{ title_options: ["Manchete"], title: "Título da fonte" }],
  };
  mirrorCappedSwapFallback(capped, "radar", 0, false, { url: "https://p" });
  const radar = capped.radar as Record<string, unknown>[];
  assert.equal(radar[0].title, "Título da fonte");
  assert.equal(radar[0].title_options, undefined);
});

test("#9384: espelho com mesmo título do canônico é removido (caso 260903)", () => {
  const article = {
    title: "Introducing Gemini 3.8 Flash and 3.8 Flash Cyber",
    cluster_sources: [
      { url: "https://deepmind.google/blog/x/", title: "Introducing Gemini 3.8 Flash and 3.8 Flash Cyber" },
    ],
  };
  const removed = dropMirrorClusterSources(article);
  assert.equal(removed.length, 1);
  assert.equal("cluster_sources" in article, false);
});

test("#9384: cobertura independente fica; espelho entre fontes sai", () => {
  const article = {
    title: "Canônico",
    cluster_sources: [
      { url: "https://a.com", title: "Outra cobertura" },
      { url: "https://b.com", title: "Outra Cobertura!" },
      { url: "https://c.com", title: "Terceira visão" },
    ],
  };
  dropMirrorClusterSources(article);
  assert.deepEqual(article.cluster_sources?.map((c) => c.url), ["https://a.com", "https://c.com"]);
});

test("#9384: applyStage2Caps tira o espelho do capped sem mutar o input", () => {
  const approved = {
    highlights: [
      {
        article: {
          url: "https://blog.google/x",
          title: "Gemini 4 Argon: our next era of frontier intelligence",
          cluster_sources: [
            { url: "https://deepmind.google/x", title: "Gemini 4 Argon: our next era of frontier intelligence" },
          ],
        },
      },
    ],
    lancamento: [],
    radar: [],
    use_melhor: [],
  } as unknown as ApprovedJson;
  const { approved: capped } = applyStage2Caps(approved);
  assert.equal(capped.highlights?.[0].article?.cluster_sources, undefined);
  assert.equal((approved.highlights?.[0].article?.cluster_sources as unknown[]).length, 1);
});
