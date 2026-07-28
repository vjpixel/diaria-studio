/**
 * publish-weekly-social.test.ts (#4101, carrossel Instagram #4146)
 *
 * Cobre:
 *   - computeWeeklyScheduledAt (pura, baseada em `saturday` — nunca Date.now()).
 *   - resolvePublicImageUrl / resolveLocalImagePath / resolveWeeklyImageUrls
 *     (leitura de disco).
 *   - Integração: semana com 0 edições válidas → o script encerra ANTES de
 *     qualquer publisher ser chamado (nunca lança por falta de credenciais
 *     Facebook/Worker, porque nunca chega a precisar delas).
 *   - #4146: Instagram despacha carrossel de N imagens (`image_urls`, 1 por
 *     dia da semana) em vez de reusar só a imagem da última edição; falha o
 *     post inteiro se qualquer dia não resolver imagem. Facebook continua
 *     usando só a imagem da última edição (inalterado, #4146 é Instagram-only).
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
  resolvePublicImageUrl,
  resolveLocalImagePath,
  resolveWeeklyImageUrls,
  DEFAULT_WEEKLY_TIME,
  WEEKLY_MIN_ITEMS,
  main,
} from "../scripts/publish-weekly-social.ts";
import { computeWeekdayEditionDates } from "../scripts/lib/select-weekly-d1.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

describe("resolvePublicImageUrl / resolveLocalImagePath", () => {
  it("retorna null quando os arquivos não existem", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-img-"));
    try {
      assert.equal(resolvePublicImageUrl(root), null);
      assert.equal(resolveLocalImagePath(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lê a URL pública 4x5 com fallback pra 1x1", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-img-"));
    try {
      writeFileSync(
        resolve(root, "06-public-images.json"),
        JSON.stringify({ images: { d1: { url: "https://cdn.example.com/d1-1x1.jpg" } } }),
        "utf8",
      );
      assert.equal(resolvePublicImageUrl(root), "https://cdn.example.com/d1-1x1.jpg");

      writeFileSync(
        resolve(root, "06-public-images.json"),
        JSON.stringify({
          images: {
            d1: { url: "https://cdn.example.com/d1-1x1.jpg" },
            d1_4x5: { url: "https://cdn.example.com/d1-4x5.jpg" },
          },
        }),
        "utf8",
      );
      assert.equal(resolvePublicImageUrl(root), "https://cdn.example.com/d1-4x5.jpg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefere o arquivo local 4x5, cai pra 1x1", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-img-"));
    try {
      writeFileSync(resolve(root, "04-d1-1x1.jpg"), "fake-jpg-1x1");
      assert.equal(resolveLocalImagePath(root), resolve(root, "04-d1-1x1.jpg"));

      writeFileSync(resolve(root, "04-d1-4x5.jpg"), "fake-jpg-4x5");
      assert.equal(resolveLocalImagePath(root), resolve(root, "04-d1-4x5.jpg"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveWeeklyImageUrls (#4146 — carrossel Instagram)", () => {
  function makeEditionsWithImages(root: string, dates: string[], missingIndex?: number): void {
    dates.forEach((date, i) => {
      const dir = resolve(root, date);
      mkdirSync(dir, { recursive: true });
      if (i === missingIndex) return; // simula 06-public-images.json ausente
      writeFileSync(
        resolve(dir, "06-public-images.json"),
        JSON.stringify({ images: { d1: { url: `https://cdn.example.com/${date}.jpg` } } }),
        "utf8",
      );
    });
  }

  it("retorna 1 URL por item, na mesma ordem de `items`, quando todos resolvem", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-"));
    try {
      const dates = ["260727", "260728", "260729", "260730", "260731"];
      makeEditionsWithImages(root, dates);
      const items = dates.map((d) => ({ editionDate: d, title: `T ${d}`, url: `https://x/${d}`, category: "noticias" }));
      const result = resolveWeeklyImageUrls(items, root);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(result.urls, dates.map((d) => `https://cdn.example.com/${d}.jpg`));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna ok:false apontando o editionDate que falhou, quando um dia não resolve imagem", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-carousel-"));
    try {
      const dates = ["260727", "260728", "260729", "260730", "260731"];
      makeEditionsWithImages(root, dates, 2); // 260729 (3º dia) sem imagem
      const items = dates.map((d) => ({ editionDate: d, title: `T ${d}`, url: `https://x/${d}`, category: "noticias" }));
      const result = resolveWeeklyImageUrls(items, root);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.missingEditionDate, "260729");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("integração: semana com 0 edições — nenhum publisher é chamado", () => {
  it("script encerra sem lançar e sem exigir credenciais Facebook/Worker", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-empty-"));
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
          // Sem env de credenciais — se o script tentasse dispatchar um
          // publisher de verdade, falharia aqui por falta de env vars antes
          // de qualquer fetch de rede.
          env: { ...process.env, FACEBOOK_PAGE_ID: "", FACEBOOK_PAGE_ACCESS_TOKEN: "", DIARIA_LINKEDIN_CRON_TOKEN: "" },
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
    }
  });
});

// ─── #4101 self-review — findings 6, 7, 9, 10 ──────────────────────────────
//
// Cobre main() de ponta a ponta com rede MOCKADA (undici MockAgent,
// disableNetConnect() — qualquer request sem interceptor registrado lança).
// GUARD DE PUBLICAÇÃO: nenhuma chamada de rede real é feita nestes testes.

function makeReviewedMd(d1Title: string, d1Url: string): string {
  return `DESTAQUE 1 | Notícias\n${d1Title}\n${d1Url}\n\nCorpo do D1.\n\nPor que isso importa:\nExplicação D1.`;
}

function setupEdition(root: string, date: string, title: string, url: string): string {
  const dir = resolve(root, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), makeReviewedMd(title, url), "utf8");
  return dir;
}

/** Adiciona os assets de imagem exigidos por Facebook (jpg local) e Instagram (06-public-images.json). */
function addImageFixtures(dir: string, imageUrl = "https://cdn.example.com/d1-1x1.jpg"): void {
  writeFileSync(resolve(dir, "04-d1-1x1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(
    resolve(dir, "06-public-images.json"),
    JSON.stringify({ images: { d1: { url: imageUrl } } }),
    "utf8",
  );
}

/**
 * Monta as 5 (ou `count`) edições da semana anterior a `saturdayDate`.
 * `imagesFor: "last"` (default, comportamento pré-#4146) adiciona imagem só
 * na última edição — usado pelos testes de Facebook (inalterado por #4146).
 * `imagesFor: "all"` adiciona 1 imagem por dia, com URL distinta por data
 * (`https://cdn.example.com/{date}.jpg`) — usado pelos testes de carrossel
 * Instagram, pra poder verificar ordem. `skipImageAt` (índice 0-based) omite
 * a imagem de 1 dia específico mesmo com `imagesFor: "all"` — simula o dia
 * que falha a resolução (#4146 finding: post inteiro deve falhar).
 */
function setupWeekFixtures(
  root: string,
  saturdayDate: Date,
  count = 5,
  opts: { imagesFor?: "last" | "all"; skipImageAt?: number } = {},
): { dates: string[]; dirs: string[] } {
  const dates = computeWeekdayEditionDates(saturdayDate).slice(0, count);
  const dirs = dates.map((date, i) =>
    setupEdition(root, date, `Título ${date}`, `https://example.com/${date}`),
  );
  const imagesFor = opts.imagesFor ?? "last";
  if (imagesFor === "all") {
    dirs.forEach((dir, i) => {
      if (i === opts.skipImageAt) return;
      addImageFixtures(dir, `https://cdn.example.com/${dates[i]}.jpg`);
    });
  } else if (dirs.length > 0) {
    addImageFixtures(dirs[dirs.length - 1]);
  }
  return { dates, dirs };
}

function aammddOf(d: Date): string {
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

describe("main(): dispatch mockado (#4101 self-review findings 6/7/9/10)", () => {
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
    mockAgent.disableNetConnect(); // qualquer fetch sem interceptor registrado lança
    setGlobalDispatcher(mockAgent);
    editionsRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-dispatch-"));
    dataRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-data-"));
    process.env.DIARIA_LINKEDIN_CRON_URL = "https://worker.test";
    process.env.DIARIA_LINKEDIN_CRON_TOKEN = "tok123";
    process.env.FACEBOOK_PAGE_ID = "999";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "fb-tok";
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

  // ─── Finding 9: --channels com typo falha alto ───────────────────────────
  describe("finding 9 — --channels desconhecido", () => {
    it("aborta com exit 1 e lista os canais válidos, sem tocar rede/disco", async () => {
      let captured = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () =>
            main(["--saturday", "260801", "--editions-root", editionsRoot, "--channels", "linkedn,facebook"], {
              dataRoot,
            }),
          1,
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /canal\(is\) desconhecido\(s\): linkedn/i);
      assert.match(captured, /linkedin, facebook, instagram, threads/);
      assert.equal(existsSync(resolve(dataRoot, "weekly")), false, "não deve ter criado nada em data/weekly");
    });
  });

  // ─── Finding 6: semana materialmente incompleta ──────────────────────────
  describe("finding 6 — semana materialmente incompleta (< 4 de 5 D1)", () => {
    it("com 3 de 5 (< WEEKLY_MIN_ITEMS): aborta sem --force-incomplete-week, nenhum publisher chamado", async () => {
      const saturday = new Date(2027, 11, 25); // futuro — 271225, evita colidir com o teste de horário passado
      const saturdayStr = aammddOf(saturday);
      setupWeekFixtures(editionsRoot, saturday, 3); // só 3 das 5 dirs existem
      assert.equal(WEEKLY_MIN_ITEMS, 4, "assunção do teste: limiar é 4");

      let captured = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () =>
            main(
              ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--channels", "facebook"],
              { dataRoot },
            ),
          1,
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /MATERIALMENTE INCOMPLETA/);
      assert.match(captured, /Encontrados 3 de 5/);
      assert.match(captured, /--force-incomplete-week/);
    });

    it("com 3 de 5 + --force-incomplete-week: prossegue e despacha o(s) canal(is) pedido(s)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupWeekFixtures(editionsRoot, saturday, 3);

      const fbMock = mockAgent.get("https://graph.facebook.com");
      fbMock.intercept({ path: /\/v25\.0\/999\/photos/, method: "POST" }).reply(
        200,
        { id: "post123" },
        { headers: { "content-type": "application/json" } },
      );

      await main(
        [
          "--saturday",
          saturdayStr,
          "--editions-root",
          editionsRoot,
          "--schedule",
          "--channels",
          "facebook",
          "--force-incomplete-week",
          "--test-mode",
        ],
        { dataRoot },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const fb = out.posts.find((p: any) => p.platform === "facebook");
      assert.equal(fb.status, "scheduled");
    });
  });

  // ─── Finding 7: dispatch real coberto por rede mockada ───────────────────
  describe("finding 7 — dispatch bem-sucedido por canal (rede mockada)", () => {
    it("facebook: POST /photos com scheduled_publish_time, marca status scheduled", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupWeekFixtures(editionsRoot, saturday, 5);

      // Corpo real é multipart/form-data (native FormData) — não dá pra
      // pattern-match como string via matcher de undici (o predicate recebe
      // a representação interna do body, não o texto serializado). A
      // asserção de "chamou de verdade com os campos certos" fica pro
      // side-effect observável: status/fb_post_id persistidos.
      let called = false;
      const fbMock = mockAgent.get("https://graph.facebook.com");
      fbMock.intercept({ path: /\/v25\.0\/999\/photos/, method: "POST" }).reply(() => {
        called = true;
        return { statusCode: 200, data: JSON.stringify({ id: "post456" }) };
      });

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--channels", "facebook", "--test-mode"],
        { dataRoot },
      );

      assert.ok(called, "POST /photos deveria ter sido chamado");
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const fb = out.posts.find((p: any) => p.platform === "facebook");
      assert.equal(fb.status, "scheduled");
      assert.equal(fb.fb_post_id, "post456");
    });

    it("linkedin/threads: POST /queue no Worker com channel correto, marca status scheduled", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupWeekFixtures(editionsRoot, saturday, 5);

      // #4101: o predicate de `body` de undici pode ser avaliado mais de uma
      // vez por request real durante a resolução do interceptor — um side
      // effect ali (push num array) conta de mais. Em vez disso, o channel é
      // lido dentro do CALLBACK de reply (garantido 1x por request de fato
      // respondida) — via `.persist()` um único interceptor cobre as 2 chamadas.
      const capturedChannels: string[] = [];
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          const channel = JSON.parse(opts.body as string).channel;
          capturedChannels.push(channel);
          return {
            statusCode: 200,
            data: JSON.stringify({
              queued: true,
              key: `queue:${channel}:1`,
              scheduled_at: "2027-12-25T11:00:00-03:00",
              destaque: "weekly",
            }),
          };
        })
        .persist();

      await main(
        [
          "--saturday",
          saturdayStr,
          "--editions-root",
          editionsRoot,
          "--schedule",
          "--channels",
          "linkedin,threads",
          "--test-mode",
        ],
        { dataRoot },
      );

      assert.deepEqual(capturedChannels.sort(), ["linkedin", "threads"]);
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "linkedin").status, "scheduled");
      assert.equal(out.posts.find((p: any) => p.platform === "threads").status, "scheduled");
    });

    // ─── #4146: Instagram carrossel de 5 (1 imagem por dia) ────────────────
    it("instagram: POST /queue com image_urls (1 por dia, ordem correta), image_url null, status scheduled", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const { dates } = setupWeekFixtures(editionsRoot, saturday, 5, { imagesFor: "all" });

      let capturedBody: any = null;
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return {
            statusCode: 200,
            data: JSON.stringify({
              queued: true,
              key: "queue:instagram:1",
              scheduled_at: "2027-12-25T11:00:00-03:00",
              destaque: "weekly",
            }),
          };
        });

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--channels", "instagram", "--test-mode"],
        { dataRoot },
      );

      assert.equal(capturedBody.image_url, null);
      assert.deepEqual(capturedBody.image_urls, dates.map((d) => `https://cdn.example.com/${d}.jpg`));
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "scheduled");
    });

    it("instagram: 3º dia sem imagem → post inteiro falha nomeando o dia, Worker NUNCA é chamado pro instagram", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const { dates } = setupWeekFixtures(editionsRoot, saturday, 5, { imagesFor: "all", skipImageAt: 2 });

      // disableNetConnect() já garante que qualquer fetch não-mockado lança —
      // nenhum interceptor registrado de propósito: se o script chegasse a
      // POSTar pro Worker apesar da imagem faltando, o teste falharia aqui.
      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--channels", "instagram", "--test-mode"],
        { dataRoot },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const instagram = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(instagram.status, "failed");
      assert.equal(instagram.reason, `public_image_url_missing:${dates[2]}`);
    });

    // ─── Regressão: Facebook continua single-image (última edição), #4146 é Instagram-only ───
    it("facebook: continua usando só a imagem da ÚLTIMA edição, mesmo com dias anteriores sem imagem própria", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      // imagesFor "last" (default) — só a última edição tem 04-d1-*.jpg;
      // as 4 anteriores não têm NENHUM asset de imagem (nem 06-public-images.json).
      setupWeekFixtures(editionsRoot, saturday, 5);

      let called = false;
      const fbMock = mockAgent.get("https://graph.facebook.com");
      fbMock.intercept({ path: /\/v25\.0\/999\/photos/, method: "POST" }).reply(() => {
        called = true;
        return { statusCode: 200, data: JSON.stringify({ id: "post999" }) };
      });

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--channels", "facebook", "--test-mode"],
        { dataRoot },
      );

      assert.ok(called, "POST /photos deveria ter sido chamado com a imagem da última edição");
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "facebook").status, "scheduled");
    });
  });

  describe("finding 7 — falha de rede com retry", () => {
    it("facebook: 2 falhas + 1 sucesso → status scheduled (retry+backoff, --test-mode pula o sleep)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupWeekFixtures(editionsRoot, saturday, 5);

      let attempts = 0;
      const fbMock = mockAgent.get("https://graph.facebook.com");
      fbMock.intercept({ path: /\/v25\.0\/999\/photos/, method: "POST" }).reply(() => {
        attempts++;
        return { statusCode: 500, data: "transient error" };
      });
      fbMock.intercept({ path: /\/v25\.0\/999\/photos/, method: "POST" }).reply(() => {
        attempts++;
        return { statusCode: 500, data: "transient error" };
      });
      fbMock.intercept({ path: /\/v25\.0\/999\/photos/, method: "POST" }).reply(() => {
        attempts++;
        return { statusCode: 200, data: JSON.stringify({ id: "post789" }), responseOptions: { headers: { "content-type": "application/json" } } };
      });

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--channels", "facebook", "--test-mode"],
        { dataRoot },
      );

      assert.equal(attempts, 3, "deve tentar 3x (2 falhas + 1 sucesso)");
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "facebook").status, "scheduled");
    });

    it("facebook: 3 falhas → esgota as tentativas, status failed (nunca lança pro caller)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupWeekFixtures(editionsRoot, saturday, 5);

      let attempts = 0;
      const fbMock = mockAgent.get("https://graph.facebook.com");
      for (let i = 0; i < 3; i++) {
        fbMock.intercept({ path: /\/v25\.0\/999\/photos/, method: "POST" }).reply(() => {
          attempts++;
          return { statusCode: 500, data: "persistent error" };
        });
      }

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--channels", "facebook", "--test-mode"],
        { dataRoot },
      );

      assert.equal(attempts, 3, "deve esgotar as 3 tentativas antes de desistir");
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const fb = out.posts.find((p: any) => p.platform === "facebook");
      assert.equal(fb.status, "failed");
      assert.match(fb.reason, /HTTP 500/);
    });

    it("worker queue (linkedin): falha HTTP → retenta e por fim marca failed (maxAttempts=2, padrão compartilhado)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupWeekFixtures(editionsRoot, saturday, 5);

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
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--channels", "linkedin"],
        { dataRoot },
      );

      assert.equal(attempts, 2, "postToWorkerQueue tenta 2x (default do cliente compartilhado)");
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "linkedin").status, "failed");
    });
  });

  describe("finding 7 / finding 10b — caminho de horário inválido (scheduled_at no passado)", () => {
    it("saturday no passado → aborta ANTES de qualquer chamada de rede, marca failed pra todos os canais pedidos", async () => {
      // 2020-01-04 é passado — computeWeeklyScheduledAt vai gerar um scheduled_at
      // muito antes de `now`, então validateScheduledTime deve rejeitar.
      const saturday = new Date(2020, 0, 4);
      const saturdayStr = aammddOf(saturday);
      setupWeekFixtures(editionsRoot, saturday, 5);

      // disableNetConnect() já garante que QUALQUER fetch não-mockado lança —
      // nenhum interceptor é registrado aqui de propósito, então se o script
      // tentar uma chamada de rede real o teste falha por network não permitida.
      await expectMockedExit(
        () =>
          main(
            [
              "--saturday",
              saturdayStr,
              "--editions-root",
              editionsRoot,
              "--schedule",
              "--channels",
              "facebook,linkedin,instagram,threads",
              "--test-mode",
            ],
            { dataRoot },
          ),
        1,
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      for (const platform of ["facebook", "linkedin", "instagram", "threads"]) {
        const entry = out.posts.find((p: any) => p.platform === platform);
        assert.equal(entry.status, "failed");
        assert.match(entry.reason, /scheduled_time_invalid/);
      }
    });
  });
});
