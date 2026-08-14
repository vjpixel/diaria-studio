/**
 * publish-weekly-social.test.ts (#4101, restrito ao Instagram + seleção por
 * clique pelo #4483)
 *
 * Cobre:
 *   - computeWeeklyScheduledAt (pura, baseada em `saturday` — nunca Date.now()).
 *   - resolveDestaqueImageUrl / resolveWeeklyImageUrls (leitura de disco,
 *     paramétrica em `n` — a seleção por clique pode escolher D1, D2 ou D3;
 *     #4513: itens de RADAR/USE MELHOR sem `destaqueNumber` acionam a
 *     geração sob demanda via `sectionCardGenerator` injetado — NUNCA o
 *     gerador real, que chamaria API de imagem paga).
 *   - `--manifest-only`: emite o manifest de posts sem clicks, sem escrever
 *     nada em disco e sem calcular seleção.
 *   - Integração: semana sem candidatos válidos → o script encerra ANTES de
 *     qualquer chamada de rede (nunca lança por falta de credenciais Worker,
 *     porque nunca chega a precisar delas).
 *   - main() de ponta a ponta com rede MOCKADA (undici MockAgent,
 *     disableNetConnect()) cobrindo: seleção por clique cruzando o cache
 *     Beehiiv, carrossel de N imagens (1 por item selecionado, cada uma
 *     resolvida pelo destaque/edição de origem do item), semana
 *     materialmente incompleta (`--force-incomplete-week`), horário
 *     inválido, retry do Worker queue.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import {
  computeWeeklyScheduledAt,
  resolveDestaqueImageUrl,
  resolveWeeklyImageUrls,
  DEFAULT_WEEKLY_TIME,
  WEEKLY_MIN_ITEMS,
  main,
} from "../scripts/publish-weekly-social.ts";
import type { InstagramRankedCandidate } from "../scripts/lib/weekly-instagram-select.ts";
import { sectionCardCacheKey, type SectionCardGenerator } from "../scripts/lib/weekly-instagram-ondemand-card.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function candidateFixture(
  overrides: Partial<InstagramRankedCandidate> & Pick<InstagramRankedCandidate, "title" | "url" | "editionDate" | "destaqueNumber">,
): InstagramRankedCandidate {
  return {
    body: "",
    why: "",
    category: "NOTÍCIAS",
    kind: "destaque",
    uniqueVerifiedClicks: 0,
    webUniqueClicks: 0,
    opens: 100,
    ratePct: 0,
    excluded: false,
    hasClickData: true,
    ...overrides,
  };
}

describe("computeWeeklyScheduledAt", () => {
  it("usa a data do sábado passada, nunca Date.now()", () => {
    const iso = computeWeeklyScheduledAt({ saturday: "260801", timezone: "America/Sao_Paulo" });
    assert.match(iso, /^2026-08-01T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
    assert.ok(iso.startsWith(`2026-08-01T${DEFAULT_WEEKLY_TIME}`));
  });

  it("aceita --time override", () => {
    const iso = computeWeeklyScheduledAt({ saturday: "260801", time: "09:15", timezone: "America/Sao_Paulo" });
    assert.ok(iso.startsWith("2026-08-01T09:15"));
  });

  it("rejeita time em formato inválido", () => {
    assert.throws(() => computeWeeklyScheduledAt({ saturday: "260801", time: "9h", timezone: "America/Sao_Paulo" }));
  });

  it("rejeita saturday em formato inválido", () => {
    assert.throws(() => computeWeeklyScheduledAt({ saturday: "2026-08-01", timezone: "America/Sao_Paulo" }));
  });
});

describe("resolveDestaqueImageUrl (#4483 — paramétrico em n, D1/D2/D3)", () => {
  it("retorna null quando 06-public-images.json não existe", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-img-"));
    try {
      assert.equal(resolveDestaqueImageUrl(root, 1), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lê a URL pública 4x5 do destaque N, com fallback pra 1x1 do mesmo N", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-img-"));
    try {
      writeFileSync(
        resolve(root, "06-public-images.json"),
        JSON.stringify({ images: { d2: { url: "https://cdn.example.com/d2-1x1.jpg" } } }),
        "utf8",
      );
      assert.equal(resolveDestaqueImageUrl(root, 2), "https://cdn.example.com/d2-1x1.jpg");
      assert.equal(resolveDestaqueImageUrl(root, 1), null, "não deveria cair pro d1 quando pedido d1 sem imagem");

      writeFileSync(
        resolve(root, "06-public-images.json"),
        JSON.stringify({
          images: {
            d2: { url: "https://cdn.example.com/d2-1x1.jpg" },
            d2_4x5: { url: "https://cdn.example.com/d2-4x5.jpg" },
          },
        }),
        "utf8",
      );
      assert.equal(resolveDestaqueImageUrl(root, 2), "https://cdn.example.com/d2-4x5.jpg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveWeeklyImageUrls (#4146/#4483 — 1 imagem por item, pelo destaque/edição de origem)", () => {
  function makeEditionsWithImages(root: string, items: { date: string; n: 1 | 2 | 3 }[], missingIndex?: number): void {
    items.forEach(({ date, n }, i) => {
      const dir = resolve(root, date);
      mkdirSync(dir, { recursive: true });
      if (i === missingIndex) return;
      const publicImagesPath = resolve(dir, "06-public-images.json");
      // Merge em vez de overwrite — 2 itens da MESMA edição (destaques
      // diferentes) escrevem no MESMO arquivo em invocações separadas.
      const existing = existsSync(publicImagesPath) ? JSON.parse(readFileSync(publicImagesPath, "utf8")) : { images: {} };
      existing.images[`d${n}`] = { url: `https://cdn.example.com/${date}-d${n}.jpg` };
      writeFileSync(publicImagesPath, JSON.stringify(existing), "utf8");
    });
  }

  it("retorna 1 URL por item, na ordem de `items`, cada uma resolvida pelo destaque/edição PRÓPRIOS do item", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-"));
    try {
      const spec: { date: string; n: 1 | 2 | 3 }[] = [
        { date: "260727", n: 1 },
        { date: "260727", n: 2 }, // 2 itens da MESMA edição, destaques diferentes
        { date: "260729", n: 3 },
      ];
      makeEditionsWithImages(root, spec);
      const items = spec.map((s) => candidateFixture({ title: `T ${s.date}-d${s.n}`, url: `https://x/${s.date}-${s.n}`, editionDate: s.date, destaqueNumber: s.n }));
      const result = await resolveWeeklyImageUrls(items, root);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(result.urls, spec.map((s) => `https://cdn.example.com/${s.date}-d${s.n}.jpg`));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna ok:false apontando edição+destaque que falhou, quando um item não resolve imagem", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-"));
    try {
      const spec: { date: string; n: 1 | 2 | 3 }[] = [
        { date: "260727", n: 1 },
        { date: "260728", n: 2 },
      ];
      makeEditionsWithImages(root, spec, 1); // 260728/d2 sem imagem
      const items = spec.map((s) => candidateFixture({ title: `T`, url: `https://x/${s.date}`, editionDate: s.date, destaqueNumber: s.n }));
      const result = await resolveWeeklyImageUrls(items, root);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.missingEditionDate, "260728");
        assert.equal(result.missingDestaqueNumber, 2);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolve a imagem mesmo com a edição em layout NESTED (data/editions/{AAMM}/{AAMMDD}, #5xxx)", async () => {
    // Regressão: `resolveWeeklyImageUrls` montava `resolve(editionsRoot, date)`
    // direto, ignorando o layout nested pós-migração (#3024) — mesma classe
    // de bug do #3030/#3031 corrigida em `resolveWeeklyEditionDirs`.
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-nested-"));
    try {
      const nestedDir = resolve(root, "2607", "260727");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(
        resolve(nestedDir, "06-public-images.json"),
        JSON.stringify({ images: { d1: { url: "https://cdn.example.com/260727-d1.jpg" } } }),
        "utf8",
      );
      const items = [candidateFixture({ title: "T", url: "https://x/260727", editionDate: "260727", destaqueNumber: 1 })];
      const result = await resolveWeeklyImageUrls(items, root);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(result.urls, ["https://cdn.example.com/260727-d1.jpg"]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveWeeklyImageUrls — item de RADAR/USE MELHOR sem destaqueNumber (#4513, card sob demanda)", () => {
  function sectionCandidateFixture(
    overrides: Partial<InstagramRankedCandidate> & Pick<InstagramRankedCandidate, "title" | "url" | "editionDate">,
  ): InstagramRankedCandidate {
    return {
      body: "",
      why: "",
      category: "RADAR",
      kind: "section",
      section: "radar",
      uniqueVerifiedClicks: 0,
      webUniqueClicks: 0,
      opens: 100,
      ratePct: 0,
      excluded: false,
      hasClickData: true,
      ...overrides,
    };
  }

  it("aciona o gerador injetado (nunca o real) e usa a URL retornada no carrossel", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-ondemand-"));
    try {
      mkdirSync(resolve(root, "260727"), { recursive: true });
      let calls = 0;
      const fakeGenerator: SectionCardGenerator = async ({ item, destaqueId }) => {
        calls++;
        assert.equal(item.section, "radar");
        assert.match(destaqueId, /^d9\d+$/);
        return { url: "https://cdn.example.com/radar-card-sob-demanda.jpg" };
      };
      const items = [sectionCandidateFixture({ title: "Item de Radar vencedor", url: "https://exemplo.com/radar-item", editionDate: "260727" })];
      const result = await resolveWeeklyImageUrls(items, root, { sectionCardGenerator: fakeGenerator });
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.urls, ["https://cdn.example.com/radar-card-sob-demanda.jpg"]);
      assert.equal(calls, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("item de destaque (D1/D2/D3) NUNCA aciona o gerador sob demanda — só resolve o card pré-gerado", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-mixed-"));
    try {
      const dir = resolve(root, "260727");
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "06-public-images.json"), JSON.stringify({ images: { d1: { url: "https://cdn.example.com/260727-d1.jpg" } } }), "utf8");

      let calls = 0;
      const fakeGenerator: SectionCardGenerator = async () => {
        calls++;
        return { url: "https://should-not-be-used.example.com" };
      };
      const items = [
        candidateFixture({ title: "D1 pré-gerado", url: "https://exemplo.com/d1", editionDate: "260727", destaqueNumber: 1 }),
      ];
      const result = await resolveWeeklyImageUrls(items, root, { sectionCardGenerator: fakeGenerator });
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.urls, ["https://cdn.example.com/260727-d1.jpg"]);
      assert.equal(calls, 0, "destaque D1/D2/D3 nunca deveria acionar a geração sob demanda");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mistura destaque + item de seção no mesmo carrossel — cada um resolve pelo caminho certo", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-mixed2-"));
    try {
      const dir = resolve(root, "260727");
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "06-public-images.json"), JSON.stringify({ images: { d1: { url: "https://cdn.example.com/260727-d1.jpg" } } }), "utf8");

      let calls = 0;
      const fakeGenerator: SectionCardGenerator = async () => {
        calls++;
        return { url: "https://cdn.example.com/use-melhor-card-gerado.jpg" };
      };
      const items = [
        candidateFixture({ title: "D1 pré-gerado", url: "https://exemplo.com/d1", editionDate: "260727", destaqueNumber: 1 }),
        sectionCandidateFixture({ title: "Tutorial vencedor", url: "https://exemplo.com/use-melhor-item", editionDate: "260727", section: "use_melhor", category: "USE MELHOR" }),
      ];
      const result = await resolveWeeklyImageUrls(items, root, { sectionCardGenerator: fakeGenerator });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(result.urls, ["https://cdn.example.com/260727-d1.jpg", "https://cdn.example.com/use-melhor-card-gerado.jpg"]);
      }
      assert.equal(calls, 1, "só o item de seção deveria acionar o gerador — 1 chamada, não 2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gerador falha → ok:false com onDemandError, cancela o carrossel inteiro (não publica parcial)", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-fail-"));
    try {
      mkdirSync(resolve(root, "260727"), { recursive: true });
      const fakeGenerator: SectionCardGenerator = async () => {
        throw new Error("falha simulada de geração sob demanda");
      };
      const items = [sectionCandidateFixture({ title: "Item que falha", url: "https://exemplo.com/radar-falha", editionDate: "260727" })];
      const result = await resolveWeeklyImageUrls(items, root, { sectionCardGenerator: fakeGenerator });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.missingEditionDate, "260727");
        assert.match(result.onDemandError ?? "", /falha simulada de geração sob demanda/);
        assert.equal(result.missingDestaqueNumber, undefined);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cache hit (06-public-images.json já tem o card de seção) — reusa sem chamar o gerador", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-cachehit-"));
    try {
      const dir = resolve(root, "260727");
      mkdirSync(dir, { recursive: true });
      const item = sectionCandidateFixture({ title: "Item já gerado antes", url: "https://exemplo.com/radar-cache", editionDate: "260727" });
      const cacheKey = sectionCardCacheKey("radar", item.url);
      writeFileSync(resolve(dir, "06-public-images.json"), JSON.stringify({ images: { [cacheKey]: { url: "https://cdn.example.com/radar-cacheado.jpg" } } }), "utf8");

      let calls = 0;
      const fakeGenerator: SectionCardGenerator = async () => {
        calls++;
        return { url: "https://should-not-be-called.example.com" };
      };
      const result = await resolveWeeklyImageUrls([item], root, { sectionCardGenerator: fakeGenerator });
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.urls, ["https://cdn.example.com/radar-cacheado.jpg"]);
      assert.equal(calls, 0, "card já cacheado nunca deveria re-gerar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("integração: semana sem candidatos válidos — nenhum publisher é chamado", () => {
  it("script encerra sem lançar e sem exigir credenciais do Worker", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-empty-"));
    const dataRootDir = mkdtempSync(join(tmpdir(), "diaria-weekly-empty-data-"));
    try {
      const result = spawnSync(
        "npx",
        [
          "tsx",
          resolve(__ROOT, "scripts/publish-weekly-social.ts"),
          "--saturday",
          "260801",
          "--editions-root",
          editionsRoot,
          "--schedule", // mesmo com --schedule, não deve tentar publicar nada
        ],
        {
          cwd: __ROOT,
          encoding: "utf8",
          env: { ...process.env, DIARIA_LINKEDIN_CRON_TOKEN: "" },
          shell: process.platform === "win32",
        },
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        (result.stdout ?? "").includes("NÃO será publicado"),
        `stdout deveria explicar que nada foi publicado: ${result.stdout}`,
      );
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(dataRootDir, { recursive: true, force: true });
    }
  });
});

// ─── main() de ponta a ponta — rede mockada, sem `data/` real ─────────────

function makeReviewedMd(destaques: { n: 1 | 2 | 3; title: string; url: string }[]): string {
  return destaques
    .map((d) => `DESTAQUE ${d.n} | Notícias\n${d.title}\n${d.url}\n\nCorpo do D${d.n}.\n\nPor que isso importa:\nExplicação D${d.n}.`)
    .join("\n\n---\n\n");
}

function setupEdition(root: string, date: string, destaques: { n: 1 | 2 | 3; title: string; url: string }[]): string {
  const dir = resolve(root, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), makeReviewedMd(destaques), "utf8");
  return dir;
}

function addImageFixture(dir: string, n: 1 | 2 | 3, imageUrl: string): void {
  const publicImagesPath = resolve(dir, "06-public-images.json");
  const existing = existsSync(publicImagesPath) ? JSON.parse(readFileSync(publicImagesPath, "utf8")) : { images: {} };
  existing.images[`d${n}`] = { url: imageUrl };
  writeFileSync(publicImagesPath, JSON.stringify(existing), "utf8");
}

function writeCachePost(dataRoot: string, id: string, post: unknown): void {
  const dir = resolve(dataRoot, "beehiiv-cache/posts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${id}.json`), JSON.stringify(post), "utf8");
}

function epochFor(aammdd: string): number {
  const yy = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  const dd = Number(aammdd.slice(4, 6));
  return Math.floor(new Date(2000 + yy, mm - 1, dd, 8, 0, 0).getTime() / 1000);
}

function aammddOf(d: Date): string {
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

describe("main(): dispatch mockado", () => {
  let mockAgent: MockAgent;
  let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  let exitCode: number | null = null;
  let editionsRoot: string;
  let dataRoot: string;

  function mockExit(): void {
    exitCode = null;
    // @ts-expect-error mocking process.exit pra não matar o processo de teste
    process.exit = (code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__mocked_exit__");
    };
  }
  function restoreExit(): void {
    process.exit = originalExit;
  }
  async function expectMockedExit(fn: () => Promise<void>, expectedCode: number): Promise<void> {
    mockExit();
    try {
      await fn();
      assert.fail("esperava throw via process.exit mockado");
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__mocked_exit__") throw e;
      assert.equal(exitCode, expectedCode);
    } finally {
      restoreExit();
    }
  }

  before(() => {
    originalDispatcher = getGlobalDispatcher();
  });

  after(() => {
    setGlobalDispatcher(originalDispatcher);
  });

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    editionsRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-dispatch-"));
    dataRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-data-"));
    process.env.DIARIA_LINKEDIN_CRON_URL = "https://worker.test";
    process.env.DIARIA_LINKEDIN_CRON_TOKEN = "tok123";
  });

  afterEach(async () => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
    rmSync(editionsRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
    await mockAgent.close();
  });

  describe("--manifest-only", () => {
    it("emite posts_needing_clicks sem calcular seleção nem escrever nada em disco", async () => {
      const saturday = new Date(2027, 11, 25); // futuro, evita colisão com testes de horário passado
      const saturdayStr = aammddOf(saturday);
      setupEdition(editionsRoot, "271220", [{ n: 1, title: "Título A", url: "https://exemplo.com/a" }]);
      writeCachePost(dataRoot, "post_a", {
        id: "post_a",
        title: "Edição 271220",
        status: "confirmed",
        publish_date: epochFor("271220"),
        stats: { email: { clicks: 3, unique_opens: 100 }, clicks: [] },
      });

      let captured = "";
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await main(["--saturday", saturdayStr, "--editions-root", editionsRoot, "--manifest-only"], { dataRoot });
      } finally {
        console.log = originalLog;
      }
      const parsed = JSON.parse(captured);
      assert.equal(parsed.posts_needing_clicks.length, 1);
      assert.equal(parsed.posts_needing_clicks[0].id, "post_a");
      assert.equal(existsSync(resolve(dataRoot, "weekly")), false, "--manifest-only não deveria escrever nada em data/weekly");
    });
  });

  describe("seleção por clique cruzando o cache Beehiiv", () => {
    it("D2 de uma edição vence D1 de outra por taxa — carrossel usa a imagem PRÓPRIA de cada item selecionado", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);

      const dirA = setupEdition(editionsRoot, "271220", [
        { n: 1, title: "D1 pouco clicado", url: "https://exemplo.com/d1-baixo" },
        { n: 2, title: "D2 muito clicado", url: "https://exemplo.com/d2-alto" },
      ]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      addImageFixture(dirA, 2, "https://cdn.example.com/271220-d2.jpg");

      writeCachePost(dataRoot, "post_1220", {
        id: "post_1220",
        title: "Edição 271220",
        status: "confirmed",
        publish_date: epochFor("271220"),
        stats: {
          email: { clicks: 10, unique_opens: 100 },
          clicks: [
            { url: "https://exemplo.com/d1-baixo", base_url: "https://exemplo.com/d1-baixo", email: { unique_verified_clicks: 2 } },
            { url: "https://exemplo.com/d2-alto", base_url: "https://exemplo.com/d2-alto", email: { unique_verified_clicks: 8 } },
          ],
        },
      });

      let capturedBody: any = null;
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return {
            statusCode: 200,
            data: JSON.stringify({ queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly" }),
          };
        });

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot },
      );

      // D2 (8%) vem antes de D1 (2%) na caption e no carrossel de imagens.
      assert.match(capturedBody.text, /1\. D2 muito clicado[\s\S]*2\. D1 pouco clicado/);
      assert.deepEqual(capturedBody.image_urls, ["https://cdn.example.com/271220-d2.jpg", "https://cdn.example.com/271220-d1.jpg"]);
      assert.equal(capturedBody.image_url, null);

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "scheduled");
    });
  });

  describe("#4513: item de RADAR vence o ranking semanal — card 4:5 gerado SOB DEMANDA antes da publicação", () => {
    it("RADAR sem card pré-existente vence D1 por taxa — gerador é acionado 1x (nunca redundante pro D1, que já tem card)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);

      const dir = resolve(editionsRoot, "271220");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, "02-reviewed.md"),
        [
          "DESTAQUE 1 | Notícias",
          "D1 pouco clicado",
          "https://exemplo.com/d1-baixo",
          "",
          "Corpo do D1.",
          "",
          "Por que isso importa:",
          "Explicação D1.",
          "",
          "---",
          "",
          "**RADAR**",
          "",
          "**[Item de Radar vencedor](https://exemplo.com/radar-vencedor)**",
          "Descrição do item de radar.",
          "",
        ].join("\n"),
        "utf8",
      );
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg"); // RADAR nunca tem card pré-existente

      writeCachePost(dataRoot, "post_1220", {
        id: "post_1220",
        title: "Edição 271220",
        status: "confirmed",
        publish_date: epochFor("271220"),
        stats: {
          email: { clicks: 10, unique_opens: 100 },
          clicks: [
            { url: "https://exemplo.com/d1-baixo", base_url: "https://exemplo.com/d1-baixo", email: { unique_verified_clicks: 2 } },
            { url: "https://exemplo.com/radar-vencedor", base_url: "https://exemplo.com/radar-vencedor", email: { unique_verified_clicks: 8 } },
          ],
        },
      });

      let generatorCalls = 0;
      const fakeGenerator: SectionCardGenerator = async ({ item }) => {
        generatorCalls++;
        assert.equal(item.title, "Item de Radar vencedor");
        assert.equal(item.section, "radar");
        return { url: "https://cdn.example.com/radar-card-gerado-sob-demanda.jpg" };
      };

      let capturedBody: any = null;
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return {
            statusCode: 200,
            data: JSON.stringify({ queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly" }),
          };
        });

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, sectionCardGenerator: fakeGenerator },
      );

      // RADAR (8%) vence D1 (2%) — vem primeiro na caption E no carrossel.
      assert.match(capturedBody.text, /1\. Item de Radar vencedor[\s\S]*2\. D1 pouco clicado/);
      assert.deepEqual(capturedBody.image_urls, [
        "https://cdn.example.com/radar-card-gerado-sob-demanda.jpg",
        "https://cdn.example.com/271220-d1.jpg",
      ]);
      assert.equal(generatorCalls, 1, "gerador sob demanda deveria ser chamado exatamente 1x — nunca redundante pro D1, que já tinha card");

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "scheduled");
    });
  });

  describe("semana materialmente incompleta (< WEEKLY_MIN_ITEMS selecionados)", () => {
    it("sem --force-incomplete-week: aborta, nenhuma chamada de rede", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      assert.equal(WEEKLY_MIN_ITEMS, 4, "assunção do teste: limiar é 4");

      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único destaque da semana curta", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");

      let captured = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          // #4511 fleet review ALTO: nenhuma edição desta janela tem post no
          // cache Beehiiv, então o gate de dado de clique incompleto
          // dispararia ANTES do gate de MIN_ITEMS que este teste quer
          // exercitar isoladamente — `--force-incomplete-click-data` passa
          // por aquele gate (banner ainda impresso, sem exit) pra chegar no
          // gate de contagem sem `--force-incomplete-week`.
          () => main(["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-click-data"], { dataRoot }),
          1,
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /MATERIALMENTE INCOMPLETA/);
      assert.match(captured, /Selecionados 1 de 5/);
      assert.match(captured, /--force-incomplete-week/);
      assert.equal(existsSync(resolve(dataRoot, "weekly")), false);
    });

    it("com --force-incomplete-week: prossegue e despacha o Instagram", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único destaque", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");

      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply(200, { queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly" }, { headers: { "content-type": "application/json" } });

      await main(
        // #4511: sem cache Beehiiv pra 271220 → também precisa de
        // --force-incomplete-click-data (teste foca no gate de MIN_ITEMS,
        // não no de dado de clique).
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "scheduled");
    });
  });

  describe("carrossel: item sem imagem resolvível — post inteiro falha", () => {
    it("2º item sem 06-public-images.json → falha nomeando edição+destaque, Worker NUNCA é chamado", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Com imagem", url: "https://exemplo.com/com-imagem" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      setupEdition(editionsRoot, "271221", [{ n: 1, title: "Sem imagem", url: "https://exemplo.com/sem-imagem" }]);
      // 271221 nunca recebe addImageFixture — 06-public-images.json ausente.

      // disableNetConnect() garante que qualquer fetch não-mockado lança —
      // nenhum interceptor registrado de propósito.
      await main(
        // #4511: sem cache Beehiiv pra nenhuma das 2 edições → precisa de
        // --force-incomplete-click-data pra chegar na checagem de imagem.
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const instagram = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(instagram.status, "failed");
      assert.match(instagram.reason, /public_image_url_missing:271221:d1/);
    });
  });

  describe("Worker queue: falha HTTP → retenta e por fim marca failed", () => {
    it("2 falhas → esgota tentativas (maxAttempts=2, padrão compartilhado de worker-queue-client)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");

      let attempts = 0;
      const workerMock = mockAgent.get("https://worker.test");
      workerMock.intercept({ path: "/queue", method: "POST" }).reply(() => {
        attempts++;
        return { statusCode: 500, data: "worker down" };
      });
      workerMock.intercept({ path: "/queue", method: "POST" }).reply(() => {
        attempts++;
        return { statusCode: 500, data: "worker down" };
      });

      await main(
        // #4511: sem cache Beehiiv pra 271220 → precisa de --force-incomplete-click-data.
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot },
      );

      assert.equal(attempts, 2);
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "failed");
    });
  });

  describe("horário inválido (scheduled_at no passado)", () => {
    it("saturday no passado → aborta ANTES de qualquer chamada de rede, marca failed", async () => {
      const saturday = new Date(2020, 0, 4); // passado
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "191230", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/191230-d1.jpg");

      // disableNetConnect() garante que QUALQUER fetch não-mockado lança —
      // nenhum interceptor registrado de propósito.
      await expectMockedExit(
        () =>
          main(
            // #4511: sem cache Beehiiv pra 191230 → precisa de --force-incomplete-click-data
            // pra chegar na validação de scheduled_at, que é o que este teste cobre.
            ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
            { dataRoot },
          ),
        1,
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const entry = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(entry.status, "failed");
      assert.match(entry.reason, /scheduled_time_invalid/);
    });
  });

  describe("Worker não configurado", () => {
    it("sem DIARIA_LINKEDIN_CRON_TOKEN → marca failed, nunca lança", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");
      process.env.DIARIA_LINKEDIN_CRON_TOKEN = "";

      await main(
        // #4511: sem cache Beehiiv pra 271220 → precisa de --force-incomplete-click-data.
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "failed");
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").reason, "worker_not_configured");
    });
  });

  describe("gate de dado de clique incompleto (#4511 fleet review ALTO)", () => {
    it("edição sem post no cache Beehiiv → aborta com banner específico, nenhuma chamada de rede", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [
        { n: 1, title: "D1", url: "https://exemplo.com/d1" },
        { n: 2, title: "D2", url: "https://exemplo.com/d2" },
        { n: 3, title: "D3", url: "https://exemplo.com/d3" },
      ]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      addImageFixture(dirA, 2, "https://cdn.example.com/271220-d2.jpg");
      addImageFixture(dirA, 3, "https://cdn.example.com/271220-d3.jpg");
      // Nenhum writeCachePost — a edição fica ausente do cache Beehiiv.

      let captured = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () =>
            main(
              ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
              { dataRoot },
            ),
          1,
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /dado de clique INCOMPLETO/);
      assert.match(captured, /edição\(ões\) sem post confirmado no cache Beehiiv: 271220/);
      assert.match(captured, /--force-incomplete-click-data/);
      assert.equal(existsSync(resolve(dataRoot, "weekly")), false);
    });

    it("post da janela sem clicks enriquecidos (manifest não-vazio) → também bloqueia", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [
        { n: 1, title: "D1", url: "https://exemplo.com/d1" },
        { n: 2, title: "D2", url: "https://exemplo.com/d2" },
        { n: 3, title: "D3", url: "https://exemplo.com/d3" },
      ]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      addImageFixture(dirA, 2, "https://cdn.example.com/271220-d2.jpg");
      addImageFixture(dirA, 3, "https://cdn.example.com/271220-d3.jpg");
      // Post presente no cache, mas email.clicks>0 com stats.clicks vazio —
      // sintoma exato de "não-enriquecido" (identifyInstagramPostsNeedingClicks).
      writeCachePost(dataRoot, "post_1220", {
        id: "post_1220",
        title: "Edição 271220",
        status: "confirmed",
        publish_date: epochFor("271220"),
        stats: { email: { clicks: 5, unique_opens: 100 }, clicks: [] },
      });

      await expectMockedExit(
        () =>
          main(
            ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
            { dataRoot },
          ),
        1,
      );
      assert.equal(existsSync(resolve(dataRoot, "weekly")), false);
    });

    it("--force-incomplete-click-data: prossegue mesmo com dado incompleto", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [
        { n: 1, title: "D1", url: "https://exemplo.com/d1" },
        { n: 2, title: "D2", url: "https://exemplo.com/d2" },
        { n: 3, title: "D3", url: "https://exemplo.com/d3" },
      ]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      addImageFixture(dirA, 2, "https://cdn.example.com/271220-d2.jpg");
      addImageFixture(dirA, 3, "https://cdn.example.com/271220-d3.jpg");
      // Nenhum writeCachePost — a edição fica ausente do cache Beehiiv.

      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply(200, { queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly" }, { headers: { "content-type": "application/json" } });

      await main(
        [
          "--saturday",
          saturdayStr,
          "--editions-root",
          editionsRoot,
          "--schedule",
          "--force-incomplete-week",
          "--force-incomplete-click-data",
        ],
        { dataRoot },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "scheduled");
    });
  });

  describe("bookkeeping de sucesso separado do publish (#4511 fleet review CRÍTICO)", () => {
    it("postToWorkerQueue COM SUCESSO + persistência local falhando → erro FATAL propaga, NUNCA rotulado status:failed", async () => {
      // Regressão: antes do #4511, `tagAndAppend({status:"scheduled"})` vivia
      // no MESMO try do `postToWorkerQueue` — se a persistência local
      // lançasse DEPOIS do post já ter sido agendado com sucesso no Worker,
      // o erro caía no catch de FALHA DE PUBLISH, que rotulava
      // `status:"failed"` (mentiroso — o post real foi agendado) e tentava
      // gravar de novo (mesmo erro, agora sem catch → "Fatal error"). Sem a
      // entrada `status:"scheduled"` em disco, um re-run bem-intencionado
      // agendaria um SEGUNDO carrossel duplicado na conta real.
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");
      writeCachePost(dataRoot, "post_1220", {
        id: "post_1220",
        title: "Edição 271220",
        status: "confirmed",
        publish_date: epochFor("271220"),
        stats: {
          email: { clicks: 1, unique_opens: 100 },
          clicks: [{ url: "https://exemplo.com/unico", base_url: "https://exemplo.com/unico", email: { unique_verified_clicks: 1 } }],
        },
      });

      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply(200, { queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly" }, { headers: { "content-type": "application/json" } });

      // Simula falha de persistência local PÓS-sucesso: `06-weekly-published.json`
      // é um DIRETÓRIO em vez de arquivo — `appendSocialPosts` lança EISDIR
      // ao tentar ler/escrever nele, DEPOIS do Worker já ter confirmado o
      // agendamento (mockado acima). `--no-skip-existing` evita que o guard
      // de skip-existing tropece nesse mesmo path ANTES da chamada de rede
      // (o que testaria o cenário errado).
      const weeklyDir = resolve(dataRoot, "weekly", saturdayStr);
      mkdirSync(resolve(weeklyDir, "06-weekly-published.json"), { recursive: true });

      let captured = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await assert.rejects(
          () =>
            main(
              ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--no-skip-existing", "--force-incomplete-week"],
              { dataRoot },
            ),
          /EISDIR/,
          "falha de persistência PÓS-sucesso deveria propagar como erro FATAL (não ser engolida/mascarada)",
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /SCHEDULED mas falhou ao persistir localmente/);
      assert.match(captured, /NÃO re-rode, isso duplicaria o post/);
      assert.doesNotMatch(captured, /FAILED instagram\/weekly/, "NUNCA deveria cair no branch de falha de publish — o publish teve sucesso");
    });
  });
});
