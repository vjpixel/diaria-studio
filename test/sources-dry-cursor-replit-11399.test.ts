/**
 * #11399 (Cursor Changelog), #11400 (Cursor Blog), #11401 (Replit Changelog):
 * as 3 fontes primárias saíram como `source_dry` em 3 rodadas.
 *
 * - Replit Changelog não tinha feed e a busca `site:` não achou o changelog
 *   semanal de 23/10/2026: perda real. Passa a ser coletado pelo sitemap do
 *   docs.replit.com, restrito ao caminho `/updates` e datado pelo caminho.
 * - Cursor Changelog/Cursor Blog não publicaram nada desde o cadastro
 *   (24/10, último post 20/10): falso positivo do sinal pra fonte nova de
 *   cadência semanal. `source_dry` passa a exigir 14 dias de histórico.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dateFromPath,
  effectiveDate,
  filterByPathPrefix,
  filterByWindow,
  parseSitemap,
} from "../scripts/lib/fetch-sitemap.ts";
import { sitemapPathPrefix } from "../scripts/fetch-rss-batch.ts";
import {
  signalsFromSourceHealth,
  sourceOldEnoughForDry,
  SOURCE_DRY_MIN_AGE_DAYS,
} from "../scripts/collect-edition-signals.ts";
import { parseSourcesMd } from "../scripts/list-active-sources.ts";
import { RECENT_OUTCOMES_MAX } from "../scripts/lib/source-runs.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Recorte do sitemap real de https://docs.replit.com/sitemap.xml (27/10/2026):
// changelog em inglês, as traduções (lastmod recente por retradução), uma
// página de documentação editada na semana e um changelog de 2024 cujo
// lastmod subiu em 2026.
const REPLIT_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.replit.com/updates/2024/12/13/changelog</loc><lastmod>2026-10-25T23:25:42.340Z</lastmod></url>
  <url><loc>https://docs.replit.com/updates/2026/10/16/changelog</loc><lastmod>2026-10-17T03:22:00.846Z</lastmod></url>
  <url><loc>https://docs.replit.com/updates/2026/10/23/changelog</loc><lastmod>2026-10-23T18:15:55.893Z</lastmod></url>
  <url><loc>https://docs.replit.com/pt/updates/2026/10/16/changelog</loc><lastmod>2026-10-22T11:11:15.420Z</lastmod></url>
  <url><loc>https://docs.replit.com/fr/updates/2025/08/08/changelog</loc><lastmod>2026-10-24T10:45:54.130Z</lastmod></url>
  <url><loc>https://docs.replit.com/replitai/agent</loc><lastmod>2026-10-24T13:07:19.545Z</lastmod></url>
  <url><loc>https://docs.replit.com/updates</loc><lastmod>2026-10-24T13:07:19.545Z</lastmod></url>
</urlset>`;

describe("#11401 sitemap restrito à seção da fonte", () => {
  it("sitemapPathPrefix tira o caminho da URL cadastrada", () => {
    assert.equal(sitemapPathPrefix("https://docs.replit.com/updates"), "/updates");
    assert.equal(sitemapPathPrefix("https://docs.replit.com/updates/"), "/updates");
    assert.equal(sitemapPathPrefix("https://example.com/"), undefined);
    assert.equal(sitemapPathPrefix("https://example.com"), undefined);
    assert.equal(sitemapPathPrefix(undefined), undefined);
    assert.equal(sitemapPathPrefix("não é url"), undefined);
  });

  it("filterByPathPrefix mantém só /updates/* em inglês, sem docs nem traduções", () => {
    const kept = filterByPathPrefix(parseSitemap(REPLIT_SITEMAP), "/updates").map((e) => e.loc);
    assert.deepEqual(kept, [
      "https://docs.replit.com/updates/2024/12/13/changelog",
      "https://docs.replit.com/updates/2026/10/16/changelog",
      "https://docs.replit.com/updates/2026/10/23/changelog",
    ]);
  });

  it("prefixo vazio não filtra (sitemap de fonte na raiz, comportamento anterior)", () => {
    const all = parseSitemap(REPLIT_SITEMAP);
    assert.equal(filterByPathPrefix(all, undefined).length, all.length);
    assert.equal(filterByPathPrefix(all, "/").length, all.length);
  });

  it("dateFromPath lê /AAAA/MM/DD/ e rejeita data inválida", () => {
    assert.equal(dateFromPath("https://docs.replit.com/updates/2026/10/23/changelog"), "2026-10-23");
    assert.equal(dateFromPath("https://x.com/blog/2026/02/30/post"), null);
    assert.equal(dateFromPath("https://x.com/blog/post"), null);
  });

  it("effectiveDate: data do caminho vence lastmod de outro dia; lastmod do mesmo dia é mais preciso", () => {
    assert.equal(
      effectiveDate({ loc: "https://docs.replit.com/updates/2024/12/13/changelog", lastmod: "2026-10-25T23:25:42.340Z" }),
      "2024-12-13T00:00:00.000Z",
    );
    assert.equal(
      effectiveDate({ loc: "https://docs.replit.com/updates/2026/10/23/changelog", lastmod: "2026-10-23T18:15:55.893Z" }),
      "2026-10-23T18:15:55.893Z",
    );
    assert.equal(
      effectiveDate({ loc: "https://x.com/sem-data", lastmod: "2026-10-23T18:15:55.893Z" }),
      "2026-10-23T18:15:55.893Z",
    );
  });

  it("cenário da edição 261026 (coleta em 24/10 13:48Z, janela de 3 dias): pega o changelog de 23/10 e só ele", () => {
    const now = new Date("2026-10-24T13:48:40.391Z");
    const kept = filterByWindow(filterByPathPrefix(parseSitemap(REPLIT_SITEMAP), "/updates"), 3, now);
    assert.deepEqual(
      kept.map((e) => e.loc),
      ["https://docs.replit.com/updates/2026/10/23/changelog"],
      "o changelog de 2024 com lastmod recente não pode voltar como novidade",
    );
  });

  it("seed e context/sources.md: Replit Changelog coleta pelo sitemap, URL na seção /updates", () => {
    const csv = readFileSync(resolve(ROOT, "seed/sources.csv"), "utf8");
    const row = csv.split(/\r?\n/).find((l) => l.startsWith("Replit Changelog,"));
    assert.ok(row, "Replit Changelog continua cadastrada (fonte primária, não desativar)");
    assert.match(row!, /,https:\/\/docs\.replit\.com\/updates,https:\/\/docs\.replit\.com\/sitemap\.xml,/);
    const md = parseSourcesMd(readFileSync(resolve(ROOT, "context/sources.md"), "utf8"));
    const src = md.find((s) => s.name === "Replit Changelog");
    assert.equal(src?.rss, "https://docs.replit.com/sitemap.xml", "rodar npm run sync-sources após editar o seed");
    assert.equal(sitemapPathPrefix(src?.url), "/updates");
  });
});

describe("#11399/#11400 source_dry exige histórico mínimo", () => {
  // Formato real de data/source-health.json pra Cursor Changelog em 27/10/2026:
  // cadastrada em 24/10, 3 rodadas (feed + busca), nada publicado desde 20/10.
  const rounds = [
    ["261026", "2026-10-24T13:48:40.391Z"],
    ["261027", "2026-10-26T18:53:09.599Z"],
    ["261028", "2026-10-27T13:03:37.879Z"],
  ];
  const cursorChangelog = {
    attempts: 6,
    successes: 0,
    recent_outcomes: rounds.flatMap(([edition, timestamp]) => [
      { outcome: "empty", timestamp, edition, method: "rss" },
      { outcome: "empty", timestamp, edition, method: "websearch_brave" },
    ]),
  };

  it("fonte cadastrada há 3 dias, sem post desde o cadastro, não sai como source_dry", () => {
    const signals = signalsFromSourceHealth(
      { sources: { "Cursor Changelog": cursorChangelog } },
      3,
      3,
      undefined,
      new Date("2026-10-27T13:05:00Z"),
      14,
      new Set(["Cursor Changelog"]),
    );
    assert.deepEqual(signals, []);
  });

  it(`a mesma fonte, ${SOURCE_DRY_MIN_AGE_DAYS}+ dias depois do 1º outcome, volta a sinalizar`, () => {
    const signals = signalsFromSourceHealth(
      { sources: { "Cursor Changelog": cursorChangelog } },
      3,
      3,
      undefined,
      new Date("2026-11-08T00:00:00Z"),
      14,
      new Set(["Cursor Changelog"]),
    );
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "source_dry");
  });

  it("feed quebrado em fonte nova continua saindo como source_streak (não espera os 14 dias)", () => {
    const broken = {
      attempts: 3,
      successes: 0,
      recent_outcomes: rounds.map(([edition, timestamp]) => ({
        outcome: "fail",
        timestamp,
        edition,
        reason: "HTTP 404",
      })),
    };
    const signals = signalsFromSourceHealth(
      { sources: { X: broken } },
      3,
      3,
      undefined,
      new Date("2026-10-27T13:05:00Z"),
    );
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "source_streak");
  });

  it("sourceOldEnoughForDry: histórico truncado ou sem timestamp conta como velho", () => {
    const now = new Date("2026-10-27T13:05:00Z");
    const fresh = [{ timestamp: "2026-10-24T13:48:40.391Z" }];
    assert.equal(sourceOldEnoughForDry({ recent_outcomes: fresh }, now), false);
    assert.equal(sourceOldEnoughForDry({ attempts: 40, recent_outcomes: fresh }, now), true, "attempts > guardados");
    assert.equal(
      sourceOldEnoughForDry({ recent_outcomes: Array.from({ length: RECENT_OUTCOMES_MAX }, () => fresh[0]) }, now),
      true,
      "recent_outcomes cheio",
    );
    assert.equal(sourceOldEnoughForDry({ recent_outcomes: [{}] }, now), true, "sem timestamp");
    assert.equal(sourceOldEnoughForDry({ recent_outcomes: [{ timestamp: "t-261026" }] }, now), true, "timestamp inválido");
    assert.equal(sourceOldEnoughForDry({ recent_outcomes: [] }, now), true);
  });
});
