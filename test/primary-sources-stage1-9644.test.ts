/**
 * primary-sources-stage1-9644.test.ts (#9644)
 *
 * 1. Toda fonte oficial lida pelo refresh tardio do Stage 4
 *    (`LATE_REFRESH_FEEDS`) também é lida pelo Stage 1 (`seed/sources.csv`,
 *    mesma URL na coluna RSS) — ou está numa allowlist explícita com motivo.
 *    Regressão do caso OpenAI: removida do seed em 28/08 (c35e64983) e lida só
 *    no late-refresh por 5 semanas.
 * 2. Falha de fonte PRIMÁRIA nunca vira sugestão de desativar no sinal do
 *    auto-reporter (`signalsFromSourceHealth`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

import { LATE_REFRESH_FEEDS } from "../scripts/lib/late-refresh.ts";
import {
  PRIMARY_SOURCE_ACTION,
  collectSignals,
  loadPrimarySourceNames,
  signalsFromSourceHealth,
} from "../scripts/collect-edition-signals.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Row = { Nome?: string; Tipo?: string; URL?: string; RSS?: string };

function seedRows(): Row[] {
  const csv = readFileSync(resolve(ROOT, "seed/sources.csv"), "utf8");
  return Papa.parse<Row>(csv, { header: true, skipEmptyLines: true }).data;
}

/**
 * Feeds do late-refresh que o Stage 1 NÃO lê pela mesma URL, com o motivo.
 * Entrar aqui exige justificar por que o Stage 1 cobre o lab de outro jeito
 * (ou por que não dá pra cobrir) — nunca "esqueci".
 */
const LATE_REFRESH_ONLY_ALLOWLIST: Record<string, string> = {
  "https://www.anthropic.com/sitemap.xml":
    "Sitemap do site inteiro filtrado por pathPrefix=/news/; o fetch-sitemap do Stage 1 não filtra por prefixo. Stage 1 cobre via fonte `Anthropic` (site:anthropic.com/news).",
  "https://claude.com/sitemap.xml":
    "Sitemap com ~3k URLs filtrado por pathPrefix=/blog/; o fetch-sitemap do Stage 1 não filtra por prefixo. Lacuna conhecida, listada na PR da #9644.",
  "https://blog.google/technology/ai/rss/":
    "Subconjunto do feed geral https://blog.google/rss/ já lido pela fonte `Google` do Stage 1 (janela de dias da pesquisa coberta pelo geral, conferido em 05/10/2026).",
  "https://microsoft.ai/feed/":
    "Feed responde 200 mas sem nenhum <item> (05/10/2026). Stage 1 cobre via fonte `Microsoft` (site:microsoft.ai).",
};

describe("#9644 — fontes do late-refresh também no Stage 1", () => {
  const rows = seedRows();
  const seedRss = new Set(rows.map((r) => r.RSS?.trim()).filter(Boolean) as string[]);

  it("todo feed do LATE_REFRESH_FEEDS está no seed (coluna RSS) ou na allowlist com motivo", () => {
    const missing = LATE_REFRESH_FEEDS.filter(
      (f) => !seedRss.has(f.url) && !LATE_REFRESH_ONLY_ALLOWLIST[f.url],
    ).map((f) => `${f.name} (${f.url})`);
    assert.deepEqual(missing, [], `feeds lidos só no late-refresh, fora do Stage 1: ${missing.join(", ")}`);
  });

  it("allowlist não tem entrada órfã nem redundante, e todo motivo é não-vazio", () => {
    const lateUrls = new Set(LATE_REFRESH_FEEDS.map((f) => f.url));
    for (const [url, reason] of Object.entries(LATE_REFRESH_ONLY_ALLOWLIST)) {
      assert.ok(lateUrls.has(url), `allowlist órfã: ${url} não está mais em LATE_REFRESH_FEEDS`);
      assert.ok(!seedRss.has(url), `allowlist redundante: ${url} já está no seed — remover da allowlist`);
      assert.ok(reason.trim().length > 20, `motivo vazio/curto pra ${url}`);
    }
  });

  it("OpenAI está no seed como fonte Primária com o RSS oficial", () => {
    const openai = rows.find((r) => r.Nome === "OpenAI");
    assert.ok(openai, "fonte OpenAI ausente de seed/sources.csv");
    assert.equal(openai.Tipo, "Primária");
    assert.equal(openai.RSS, "https://openai.com/news/rss.xml");
  });

  it("context/sources.md está em dia com o seed (OpenAI presente)", () => {
    const md = readFileSync(resolve(ROOT, "context/sources.md"), "utf8");
    assert.match(md, /^### OpenAI$/m);
    assert.match(md, /- RSS: https:\/\/openai\.com\/news\/rss\.xml/);
  });
});

describe("#9644 — sinal de falha de fonte primária não sugere desativar", () => {
  const failing = {
    sources: {
      OpenAI: {
        successes: 130,
        // #9652: 3 RODADAS com falha (timestamps distintos, sem ok). O caso real
        // de 27/08 (1 ok + 3 fail no MESMO timestamp) deixou de ser streak —
        // coberto em test/source-streak-rounds-9652.test.ts.
        recent_outcomes: [
          { outcome: "fail", timestamp: "2026-08-25T15:27:35.373Z" },
          { outcome: "fail", timestamp: "2026-08-26T15:52:20.189Z" },
          { outcome: "fail", timestamp: "2026-08-27T23:14:49.327Z" },
        ],
      },
      "Ben's Bites": {
        successes: 10,
        recent_outcomes: [{ outcome: "fail" }, { outcome: "fail" }, { outcome: "fail" }],
      },
    },
  };

  it("fonte primária: título marca PRIMÁRIA e a ação manda investigar, não desativar", () => {
    const signals = signalsFromSourceHealth(failing, 3, 6, undefined, new Date(), 14, new Set(["OpenAI"]));
    const s = signals.find((x) => x.details.source === "OpenAI");
    assert.ok(s);
    assert.equal(s.kind, "source_streak");
    assert.match(s.title, /PRIMÁRIA/);
    assert.equal(s.details.source_type, "Primária");
    assert.equal(s.suggested_action, PRIMARY_SOURCE_ACTION);
    assert.match(s.suggested_action, /NÃO desativar/);
    assert.doesNotMatch(s.suggested_action, /Considere desativar/);
  });

  it("fonte não-primária mantém a sugestão antiga", () => {
    const signals = signalsFromSourceHealth(failing, 3, 6, undefined, new Date(), 14, new Set(["OpenAI"]));
    const s = signals.find((x) => x.details.source === "Ben's Bites");
    assert.ok(s);
    assert.match(s.suggested_action, /Considere desativar/);
    assert.doesNotMatch(s.title, /PRIMÁRIA/);
  });

  it("fonte primária seca (nunca produziu) também não sugere desativar", () => {
    const dry = {
      sources: {
        "Meta Newsroom (IA)": {
          successes: 0,
          recent_outcomes: Array.from({ length: 6 }, () => ({ outcome: "empty" })),
        },
      },
    };
    const signals = signalsFromSourceHealth(dry, 3, 6, undefined, new Date(), 14, new Set(["Meta Newsroom (IA)"]));
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "source_dry");
    assert.equal(signals[0].suggested_action, PRIMARY_SOURCE_ACTION);
  });

  it("loadPrimarySourceNames lê o Tipo do seed real e inclui OpenAI/Anthropic, não fontes secundárias", () => {
    const primary = loadPrimarySourceNames(ROOT);
    assert.ok(primary);
    assert.ok(primary.has("OpenAI"));
    assert.ok(primary.has("Anthropic"));
    assert.ok(!primary.has("TLDR AI"));
  });

  it("loadPrimarySourceNames sem seed → undefined (back-compat)", () => {
    const root = mkdtempSync(join(tmpdir(), "primary-9644-"));
    try {
      assert.equal(loadPrimarySourceNames(root), undefined);
      mkdirSync(join(root, "seed"));
      writeFileSync(join(root, "seed/sources.csv"), "Nome,Tipo,URL,RSS\nX,Primária,https://x.test/,\nY,Secundária,https://y.test/,\n");
      assert.deepEqual([...(loadPrimarySourceNames(root) ?? [])], ["X"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collectSignals liga o seed real do rootDir ao sinal (fiação ponta a ponta)", () => {
    const root = mkdtempSync(join(tmpdir(), "primary-9644-e2e-"));
    try {
      const editionDir = join(root, "data/editions/260828");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      mkdirSync(join(root, "seed"));
      writeFileSync(join(root, "seed/sources.csv"), "Nome,Tipo,URL,RSS\nOpenAI,Primária,https://openai.com/news/,https://openai.com/news/rss.xml\n");
      writeFileSync(join(root, "data/source-health.json"), JSON.stringify(failing));
      const draft = collectSignals({ rootDir: root, editionDir });
      const s = draft.signals.find((x) => x.details.source === "OpenAI");
      assert.ok(s, "sinal da OpenAI ausente");
      assert.equal(s.suggested_action, PRIMARY_SOURCE_ACTION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
