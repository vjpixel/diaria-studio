/**
 * test/dedup-url-window-days-9955.test.ts (#9955)
 *
 * Regressão: o bloqueio de URL repetida olhava só as 3 últimas edições
 * (`DEFAULT_PAST_WINDOW`). Caso real: o D2 de 261001
 * (openai.com/index/introducing-gpt-6-1-sol/) voltou como D1 do rascunho de
 * 261009, oito edições depois, e o dedup deixou passar. Decisão do editor
 * (briefing overnight 261009): mesma URL nos últimos ~30 dias reprova.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEDUP_URL_WINDOW_DAYS,
  DEFAULT_PAST_WINDOW,
  extractPastUrls,
  extractPastUrlsWithinDays,
  extractPastUrlsWithOriginWithinDays,
  pastSectionsWithinDays,
  cutoffAammdd,
  recentEditionDirs,
  extractPastDestaqueUrls,
} from "../scripts/lib/past-editions-extract.ts";
import { dedup } from "../scripts/dedup.ts";
import { findDuplicateUrlsAgainstPastEditions } from "../scripts/lib/invariant-checks/stage-4.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";
import { refreshDedup, type RefreshConfig } from "../scripts/refresh-dedup.ts";

const SOL = "https://openai.com/index/introducing-gpt-6-1-sol/";
const OLD = "https://example.com/noticia-de-agosto";

/** past-editions.md com 1 edição por dia de 261008 a 260901 (ordem decrescente). */
function buildPastMd(): string {
  const sections: string[] = [];
  const start = Date.UTC(2026, 9, 8); // 2026-10-08
  for (let i = 0; i <= 37; i++) {
    const d = new Date(start - i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const links = [`https://example.com/link-${iso}`];
    if (iso === "2026-10-01") links.push(SOL);
    if (iso === "2026-09-01") links.push(OLD);
    sections.push(
      `## ${iso} — "Edição ${iso}"\n\nLinks usados:\n${links.map((l) => `- ${l}`).join("\n")}\n`,
    );
  }
  return `# Past editions\n\n${sections.join("\n")}`;
}

const PAST_MD = buildPastMd();

describe("#9955 — janela de URL repetida em dias", () => {
  it("DEDUP_URL_WINDOW_DAYS é ~30 dias (decisão do editor)", () => {
    assert.equal(DEDUP_URL_WINDOW_DAYS, 30);
  });

  it("documenta o bug: a janela antiga de 3 edições NÃO via a URL de 8 edições atrás", () => {
    const old = extractPastUrls(PAST_MD, DEFAULT_PAST_WINDOW);
    assert.equal(old.has(canonicalize(SOL)), false);
  });

  it("URL de 8 edições atrás (261001 vs edição 261009) está na janela de 30 dias", () => {
    const urls = extractPastUrlsWithinDays(PAST_MD, DEDUP_URL_WINDOW_DAYS, "261009");
    assert.equal(urls.has(canonicalize(SOL)), true);
  });

  it("URL de fora dos 30 dias (260901 vs 261009, 38 dias) passa", () => {
    const urls = extractPastUrlsWithinDays(PAST_MD, DEDUP_URL_WINDOW_DAYS, "261009");
    assert.equal(urls.has(canonicalize(OLD)), false);
  });

  it("fronteira: exatamente 30 dias antes entra, 31 não", () => {
    const dates = pastSectionsWithinDays(PAST_MD, 30, "261009").map((s) => s.date);
    assert.ok(dates.includes("2026-09-09"));
    assert.ok(!dates.includes("2026-09-08"));
  });

  it("a própria edição (e posteriores) fica de fora — sem self-match", () => {
    const dates = pastSectionsWithinDays(PAST_MD, 30, "261005").map((s) => s.date);
    assert.ok(!dates.includes("2026-10-05"));
    assert.ok(!dates.includes("2026-10-08"));
    assert.ok(dates.includes("2026-10-04"));
  });

  it("sem edição de referência, ancora no dia seguinte à seção mais recente", () => {
    const dates = pastSectionsWithinDays(PAST_MD, 30).map((s) => s.date);
    assert.ok(dates.includes("2026-10-08"));
    assert.ok(dates.includes("2026-09-09"));
    assert.ok(!dates.includes("2026-09-08"));
    assert.equal(extractPastUrlsWithinDays(PAST_MD).has(canonicalize(SOL)), true);
  });

  it("histórico vazio → Set vazio", () => {
    assert.equal(extractPastUrlsWithinDays("", 30, "261009").size, 0);
  });

  it("origem cita a edição mais recente que usou a URL", () => {
    const md = PAST_MD.replace(
      "- https://example.com/link-2026-10-05",
      `- https://example.com/link-2026-10-05\n- ${SOL}`,
    );
    const origins = extractPastUrlsWithOriginWithinDays(md, 30, "261009");
    assert.equal(origins.get(canonicalize(SOL)), "2026-10-05");
  });

  it("cutoffAammdd cruza mês/ano", () => {
    assert.equal(cutoffAammdd("261009", 30), "260909");
    assert.equal(cutoffAammdd("270115", 30), "261216");
    assert.equal(cutoffAammdd("269999", 30), undefined);
  });

  it("dedup() reprova o candidato com a URL de 8 edições atrás e aprova o de 38 dias", () => {
    const pastUrls = extractPastUrlsWithinDays(PAST_MD, DEDUP_URL_WINDOW_DAYS, "261009");
    const { kept, removed } = dedup(
      [
        { url: SOL, title: "GPT-6.1 Sol encosta no Astra por um quinto do preço" },
        { url: OLD, title: "Notícia de agosto que voltou" },
      ],
      pastUrls,
      0.85,
    );
    assert.deepEqual(kept.map((a) => a.url), [OLD]);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].url, SOL);
  });

  it("invariante Stage 4 acusa a URL de 8 edições atrás com a data de origem", () => {
    const origins = extractPastUrlsWithOriginWithinDays(PAST_MD, DEDUP_URL_WINDOW_DAYS, "261009");
    const reviewed = `**[GPT-6.1 Sol encosta no Astra](${SOL})**\n\n**[Agosto](${OLD})**\n`;
    const matches = findDuplicateUrlsAgainstPastEditions(reviewed, origins);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].originDate, "2026-10-01");
  });
});

describe("#9955 — destaques locais (02-reviewed/approved) na mesma janela em dias", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "dedup-9955-"));
    for (const [aammdd, url] of [
      ["261001", SOL],
      ["260901", OLD],
      ["261008", "https://example.com/ontem"],
    ] as const) {
      mkdirSync(join(dir, aammdd, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, aammdd, "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ article: { url, title: `t-${aammdd}` } }] }),
      );
    }
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("recentEditionDirs com withinDays filtra por data, não por contagem", () => {
    assert.deepEqual(recentEditionDirs(dir, 1, "261009", 30), ["261008", "261001"]);
    // sem withinDays: contagem legada
    assert.deepEqual(recentEditionDirs(dir, 1, "261009"), ["261008"]);
  });

  it("extractPastDestaqueUrls com withinDays pega o D2 de 261001 e não o de 260901", () => {
    const urls = extractPastDestaqueUrls(dir, DEFAULT_PAST_WINDOW, "261009", 30);
    assert.equal(urls.has(canonicalize(SOL)), true);
    assert.equal(urls.has(canonicalize(OLD)), false);
  });
});

describe("#9955 — past-editions.md precisa cobrir os 30 dias", () => {
  it("platform.config.json beehiiv.dedupEditionCount >= DEDUP_URL_WINDOW_DAYS + 1", () => {
    const cfg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "platform.config.json"), "utf8"));
    assert.ok(
      cfg.beehiiv.dedupEditionCount >= DEDUP_URL_WINDOW_DAYS + 1,
      `dedupEditionCount=${cfg.beehiiv.dedupEditionCount} não cobre ${DEDUP_URL_WINDOW_DAYS} dias de edições diárias`,
    );
  });

  describe("refresh-dedup completa o raw quando ele tem menos edições que dedupEditionCount", () => {
    let sandbox: string;
    let originalFetch: typeof globalThis.fetch;
    before(() => {
      originalFetch = globalThis.fetch;
      sandbox = mkdtempSync(join(tmpdir(), "refresh-9955-"));
    });
    after(() => {
      globalThis.fetch = originalFetch;
      rmSync(sandbox, { recursive: true, force: true });
    });

    it("backfill: baixa só as edições que o raw não tem e mantém os links das conhecidas", async () => {
      const rawPath = join(sandbox, "raw.json");
      const mdPath = join(sandbox, "past.md");
      writeFileSync(
        rawPath,
        JSON.stringify([
          {
            id: "post_new",
            title: "Nova",
            web_url: "https://diaria.beehiiv.com/p/nova",
            published_at: "2026-10-08T09:00:00Z",
            links: ["https://example.com/ja-resolvido"],
          },
        ]),
      );
      const posts = [
        { id: "post_new", title: "Nova", ts: "2026-10-08T09:00:00Z" },
        { id: "post_mid", title: "Meio", ts: "2026-10-01T09:00:00Z" },
        { id: "post_old", title: "Velha", ts: "2026-09-20T09:00:00Z" },
      ];
      const contentFetched: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = new URL(typeof input === "string" ? input : input.toString());
        if (/\/posts$/.test(u.pathname)) {
          return new Response(
            JSON.stringify({
              data: posts.map((p) => ({
                id: p.id,
                title: p.title,
                status: "confirmed",
                publish_date: Math.floor(new Date(p.ts).getTime() / 1000),
                web_url: `https://diaria.beehiiv.com/p/${p.id}`,
              })),
              page: 1,
              total_results: posts.length,
              total_pages: 1,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const m = /\/posts\/([^/]+)$/.exec(u.pathname);
        if (m) {
          const id = decodeURIComponent(m[1]);
          contentFetched.push(id);
          const p = posts.find((x) => x.id === id)!;
          return new Response(
            JSON.stringify({
              data: {
                id,
                title: p.title,
                status: "confirmed",
                publish_date: Math.floor(new Date(p.ts).getTime() / 1000),
                web_url: `https://diaria.beehiiv.com/p/${id}`,
                html: id === "post_mid" ? `<p>${SOL}</p>` : "<p>https://example.com/velha</p>",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }) as typeof globalThis.fetch;

      const cfg: RefreshConfig = {
        readConfig: { backend: "beehiiv", config: { apiKey: "k", publicationId: "pub_test" } },
        dedupEditionCount: 3,
      };
      const result = await refreshDedup({
        dryRun: false,
        resolveTracking: false,
        rawPath,
        mdPath,
        configOverride: cfg,
        editionsRoot: join(sandbox, "data", "editions"),
        noAutoStamp: true,
      });

      assert.equal(result.new_posts, 2);
      assert.deepEqual(contentFetched.sort(), ["post_mid", "post_old"]);
      const raw = JSON.parse(readFileSync(rawPath, "utf8")) as { id: string; links?: string[] }[];
      assert.deepEqual(raw.map((p) => p.id), ["post_new", "post_mid", "post_old"]);
      assert.deepEqual(raw[0].links, ["https://example.com/ja-resolvido"]);
      const md = readFileSync(mdPath, "utf8");
      assert.ok(extractPastUrlsWithinDays(md, 30, "261009").has(canonicalize(SOL)));
    });
  });
});
