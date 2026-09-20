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
 *
 * #6222: `MockAgent.disableNetConnect()` cobre `fetch`/undici (todos os
 * publishers deste script usam `fetch`), mas NÃO cobre `node:https`/
 * `node:http` — o caminho que `uploadTextToWorkerKV`/`uploadImageToWorkerKV`
 * (scripts/lib/cloudflare-kv-upload.ts) usam. `installNetworkRequestGuard`
 * (file-wide, abaixo) fecha essa lacuna pra este arquivo inteiro, inclusive
 * os describes ANTES de "main(): dispatch mockado" que não tinham nenhuma
 * proteção de rede. O teste de integração que spawna o CLI real como
 * SUBPROCESSO (linha ~419) fica FORA do alcance desse guard (processo
 * separado) — isolado à parte, limpando explicitamente as env vars de
 * credencial antes do spawn (ver comentário no teste).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { installNetworkRequestGuard } from "./_helpers/network-guard.ts";
import {
  computeWeeklyScheduledAt,
  resolveDestaqueImageUrl,
  resolveWeeklyImageUrls,
  weekRangeLabel,
  buildFlatCardTexts,
  DEFAULT_WEEKLY_TIME,
  WEEKLY_MIN_ITEMS,
  main,
} from "../scripts/publish-weekly-social.ts";
import type { InstagramRankedCandidate } from "../scripts/lib/weekly-instagram-select.ts";
import { sectionCardCacheKey, type SectionCardGenerator } from "../scripts/lib/weekly-instagram-ondemand-card.ts";
import type { FlatCardGenerator } from "../scripts/lib/weekly-flat-card.ts";
import type { NewsCardGenerator } from "../scripts/lib/weekly-carousel-news-card.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// #6222: guard de rede file-wide — ver docstring do topo do arquivo.
let __restoreNetworkGuard6222: () => void;
before(() => {
  __restoreNetworkGuard6222 = installNetworkRequestGuard();
});
after(() => {
  __restoreNetworkGuard6222();
});

/**
 * Fake do gerador de card capa/CTA (#5330) — nunca chama sharp/font/upload
 * real, só devolve uma URL determinística por kvKey (mesmo padrão dos fakes
 * de `sectionCardGenerator` já usados neste arquivo). Todo `main()` chamado
 * com `--schedule` precisa disso: sem injetar, cairia no
 * `defaultFlatCardGenerator` real (checa fonte de marca + upload de
 * verdade pro KV Cloudflare — nunca exercitado em teste).
 */
const fakeFlatCardGenerator: FlatCardGenerator = async ({ kvKey }) => ({
  url: `https://cdn.example.com/flat/${kvKey}`,
});

/**
 * Fake do gerador de card de notícia RECOMPOSTO (#5330) — nunca chama
 * `generateCard`/sharp/upload real (o arquivo de arte-base não existe nos
 * fixtures de teste, só a URL antiga é fixturada via `addImageFixture`,
 * irrelevante pro caminho novo). Devolve uma URL determinística a partir do
 * `kvKey` (que já embute editionDate+destaque+carouselKey) — mesma
 * convenção de `fakeFlatCardGenerator`.
 */
const fakeNewsCardGenerator: NewsCardGenerator = async ({ kvKey }) => ({
  url: `https://cdn.example.com/news/${kvKey}`,
});

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

  it("#5330: dayOffset=0 (default) agenda no PRÓPRIO sábado — modo 'highlights'", () => {
    const iso = computeWeeklyScheduledAt({ saturday: "260815", timezone: "America/Sao_Paulo" });
    assert.ok(iso.startsWith("2026-08-15T"));
  });

  it("#5330: dayOffset=1 agenda no domingo seguinte — modo 'clicked'", () => {
    const iso = computeWeeklyScheduledAt({ saturday: "260815", timezone: "America/Sao_Paulo", dayOffset: 1 });
    assert.ok(iso.startsWith("2026-08-16T"));
  });

  it("#5330: dayOffset cruza mês corretamente (aritmética de Date, não lógica de calendário manual)", () => {
    const iso = computeWeeklyScheduledAt({ saturday: "260831", timezone: "America/Sao_Paulo", dayOffset: 1 });
    assert.ok(iso.startsWith("2026-09-01T"), `esperava cruzar pra setembro, veio ${iso}`);
  });
});

describe("weekRangeLabel (#5330 — rodapé do card capa/CTA)", () => {
  it("formata primeiro e último dia da janela + mês abreviado em pt-BR", () => {
    assert.equal(weekRangeLabel(["260810", "260811", "260812", "260813", "260814"]), "10–14 ago");
  });

  it("janela vazia retorna string vazia (nunca lança)", () => {
    assert.equal(weekRangeLabel([]), "");
  });

  it("janela de 1 dia só (edge case) usa o mesmo dia nos dois lados", () => {
    assert.equal(weekRangeLabel(["260810"]), "10–10 ago");
  });

  it("#5330 fleet review (correctness): semana cruzando mês rotula CADA dia com o mês certo (achado — mês do último dia mislabelava o 1º)", () => {
    assert.equal(weekRangeLabel(["260831", "260901", "260902", "260903", "260904"]), "31 ago–4 set");
  });
});

describe("buildFlatCardTexts (#5330 — textos dos slides sem foto, por modo)", () => {
  it("modo 'highlights': título de capa é 'Os principais destaques de IA da semana'", () => {
    const texts = buildFlatCardTexts("highlights", ["260810", "260811", "260812", "260813", "260814"]);
    assert.equal(texts.cover.title, "Os principais destaques de IA da semana");
    assert.equal(texts.cover.footer, "10–14 ago · diar.ia.br");
  });

  it("modo 'clicked': título de capa é 'As notícias de IA mais lidas da semana' (#7571)", () => {
    const texts = buildFlatCardTexts("clicked", ["260810", "260811", "260812", "260813", "260814"]);
    assert.equal(texts.cover.title, "As notícias de IA mais lidas da semana");
  });

  it("CTA final é IDÊNTICO nos dois modos (convite pra assinar não depende de qual carrossel é)", () => {
    const highlights = buildFlatCardTexts("highlights", ["260810"]);
    const clicked = buildFlatCardTexts("clicked", ["260810"]);
    assert.deepEqual(highlights.cta, clicked.cta);
  });

  it("#8055 — CTA manda pro endereço, nunca pro 'link da bio': o card é o MESMO nos 4 canais", () => {
    // O JPEG do CTA é compartilhado por Instagram, Threads, LinkedIn e
    // Facebook (`carouselImageUrls`), e em 3 deles não existe bio com link.
    // A legenda continua podendo ser específica por canal — a ARTE, não.
    const { cta } = buildFlatCardTexts("highlights", ["260810"]);
    assert.match(cta.title, /Assine em diar\.ia\.br\./);
    assert.doesNotMatch(cta.title, /link da bio/i);
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
          // #6222: subprocesso separado — o `MockAgent`/network-guard do
          // processo PAI não alcança aqui. Numa máquina com `.env` real
          // (editor, `300`), `loadProjectEnv()` (chamado dentro do
          // script) populava credenciais REAIS de Worker/Facebook/Cloudflare
          // em `process.env` — herdadas por este spawn via `...process.env`
          // — que, se algum código sob teste chegasse a tentar publicar
          // (mesmo que a asserção espere "nada publicado"), abriria conexão
          // de rede real com credencial real. Zera TODAS explicitamente,
          // não só a que o teste original cobria (`DIARIA_LINKEDIN_CRON_TOKEN`).
          env: {
            ...process.env,
            DIARIA_LINKEDIN_CRON_URL: "",
            DIARIA_LINKEDIN_CRON_TOKEN: "",
            FACEBOOK_PAGE_ID: "",
            FACEBOOK_PAGE_ACCESS_TOKEN: "",
            CLOUDFLARE_ACCOUNT_ID: "",
            CLOUDFLARE_WORKERS_TOKEN: "",
          },
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

/**
 * `slug: id` é default, não incondicional (#8233 fixer) — `isPublicEdition`
 * (`edition-cache-reader.ts`) trata `slug` ausente/vazio como NÃO-público, e
 * `loadUnifiedPostsForRanking` (que `publish-weekly-social.ts` passou a usar
 * pra selecionar candidatos públicos, #8233) filtra em cima disso. Nenhum
 * ID de fixture usado neste arquivo (`post_a`, `post_1220`, ...) começa com
 * `teste-`/termina em `-patronos`, então o default é seguro. Caller que
 * passar `slug` explícito no literal de `post` continua vencendo.
 */
function writeCachePost(dataRoot: string, id: string, post: unknown): void {
  const dir = resolve(dataRoot, "beehiiv-cache/posts");
  mkdirSync(dir, { recursive: true });
  const withSlug = { slug: id, ...(post as Record<string, unknown>) };
  writeFileSync(resolve(dir, `${id}.json`), JSON.stringify(withSlug), "utf8");
}

/** #6185: escreve um broadcast Kit em `data/kit-cache/broadcasts/{id}.json`
 *  — mesmo shape que `normalizeKitBroadcast` (`edition-cache-reader.ts`)
 *  espera (`RawKitBroadcastFile` = `KitBroadcastSummary` + `clicks`
 *  opcional). Usado pra provar que a seleção por clique do carrossel
 *  semanal do Instagram lê edições de origem Kit, não só Beehiiv — mesmo
 *  padrão de `test/select-linkedin-weekly-integration.test.ts`.
 *
 * Default de `public_url` (#8233 fixer) — `normalizeKitBroadcast` nunca lê
 * um campo `slug` do JSON bruto: o slug de um post Kit é sempre DERIVADO de
 * `public_url` via `slugFromUrl`. Sem ele, `isPublicEdition` trata o post
 * como sem slug (não-público) e `loadUnifiedPostsForRanking` o filtra
 * inteiro — era exatamente isso que fazia o CLI abortar com "dado de
 * clique INCOMPLETO" (o fixture Kit desaparecia do pool). ID usado aqui
 * (`900_1221`) nunca colide com `teste-*`/`-patronos`. */
function writeKitCachePost(dataRoot: string, id: string | number, broadcast: unknown): void {
  const dir = resolve(dataRoot, "kit-cache/broadcasts");
  mkdirSync(dir, { recursive: true });
  const withPublicUrl = { public_url: `https://diar.ia.br/p/kit-${id}`, ...(broadcast as Record<string, unknown>) };
  writeFileSync(resolve(dir, `${id}.json`), JSON.stringify(withPublicUrl), "utf8");
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
        await main(["--saturday", saturdayStr, "--editions-root", editionsRoot, "--manifest-only"], { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator });
      } finally {
        console.log = originalLog;
      }
      const parsed = JSON.parse(captured);
      assert.equal(parsed.posts_needing_clicks.length, 1);
      assert.equal(parsed.posts_needing_clicks[0].id, "post_a");
      assert.equal(existsSync(resolve(dataRoot, "weekly")), false, "--manifest-only não deveria escrever nada em data/weekly");
    });

    it("#5330: modo 'highlights' sempre retorna posts_needing_clicks vazio — não ranqueia por clique, nada pra enriquecer", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupEdition(editionsRoot, "271220", [{ n: 1, title: "Título A", url: "https://exemplo.com/a" }]);
      // MESMO post não-enriquecido do teste acima (email.clicks>0, stats.clicks
      // vazio) — em modo clicked isso apareceria em posts_needing_clicks;
      // em highlights não deveria, porque o modo nem olha pra esse dado.
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
        await main(
          ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--manifest-only"],
          { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
        );
      } finally {
        console.log = originalLog;
      }
      const parsed = JSON.parse(captured);
      assert.equal(parsed.mode, "highlights");
      assert.deepEqual(parsed.posts_needing_clicks, []);
    });
  });

  describe("#8385: --images-only (resolve as imagens do carrossel sem despachar pra nenhum canal)", () => {
    it("resolve capa + itens + CTA em JSON, sem escrever 06-weekly-published.json nem chamar o Worker queue", async () => {
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

      // Nenhum intercept registrado pra "/queue" — se o script chegasse a
      // despachar pra algum canal, o MockAgent (disableNetConnect) lançaria.
      // O teste passar sem registrar nenhum intercept É a prova de que
      // --images-only nunca chama o Worker.
      //
      // O caminho normal (sem --manifest-only) imprime narrativa (seleção,
      // warnings) ANTES do JSON final — diferente do atalho de
      // --manifest-only, que sai cedo com 1 console.log só. Captura por
      // CHAMADA (não concatenado numa string só) e pega a ÚLTIMA — é o
      // console.log(JSON.stringify(...)) do bloco --images-only.
      const calls: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        calls.push(args.map(String).join(" "));
      };
      try {
        await main(
          ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--images-only", "--force-incomplete-week"],
          { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
        );
      } finally {
        console.log = originalLog;
      }

      const parsed = JSON.parse(calls[calls.length - 1]);
      assert.equal(parsed.mode, "clicked");
      assert.equal(parsed.saturday, saturdayStr);
      // D2 (8%) vence D1 (2%) — mesma ordem que o dispatch real usaria.
      assert.equal(parsed.items.length, 2);
      assert.equal(parsed.items[0].title, "D2 muito clicado");
      assert.equal(parsed.items[1].title, "D1 pouco clicado");
      assert.equal(parsed.carouselImageUrls.length, 4);
      assert.match(parsed.cover, /\/flat\/img-unknown-weekly-.*-clicked-cover-4x5\.jpg$/);
      assert.match(parsed.cta, /\/flat\/img-unknown-weekly-.*-clicked-cta-4x5\.jpg$/);
      assert.match(parsed.items[0].imageUrl, /\/news\/img-unknown-weekly-271225-clicked-271220-d2-\d+-4x5\.jpg$/);

      assert.equal(existsSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json")), false);
    });

    it("rejeita --schedule junto (a resolução de imagem já é parte desse fluxo)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      await expectMockedExit(
        () =>
          main(["--saturday", saturdayStr, "--editions-root", editionsRoot, "--images-only", "--schedule"], {
            dataRoot,
            flatCardGenerator: fakeFlatCardGenerator,
            newsCardGenerator: fakeNewsCardGenerator,
          }),
        1,
      );
    });

    it("rejeita --mode both junto (emitiria 2 JSONs em sequência)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      await expectMockedExit(
        () =>
          main(["--saturday", saturdayStr, "--editions-root", editionsRoot, "--images-only", "--mode", "both"], {
            dataRoot,
            flatCardGenerator: fakeFlatCardGenerator,
            newsCardGenerator: fakeNewsCardGenerator,
          }),
        1,
      );
    });

    it("#8385 fleet review P1: falha de resolução de imagem sai com código 1 e NUNCA escreve 06-weekly-published.json", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);

      // Mesmo fixture do teste "resolve capa + itens + CTA" acima, mas com
      // um newsCardGenerator que FALHA pro D2 — força !resolvedImages.ok
      // (a recomposição #5345 chama sempre o generator injetado, nunca lê
      // 06-public-images.json direto — addImageFixture não afeta esse
      // caminho). Antes do fix, os 3 blocos de erro que antecedem o `return
      // true` do --images-only (scheduled_at inválido, !resolvedImages.ok,
      // falha de card capa/CTA) chamavam tagAndAppend incondicionalmente
      // pros 4 canais, gravando status:"failed" em 06-weekly-published.json
      // mesmo numa invocação que nunca despachou pra canal nenhum —
      // exatamente o que o comentário do código e o SKILL.md prometem que
      // --images-only nunca faz.
      const failingNewsCardGenerator: NewsCardGenerator = async ({ destaque }) => {
        throw new Error(`falha simulada de geração pra ${destaque}`);
      };

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

      await expectMockedExit(
        () =>
          main(
            ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--images-only", "--force-incomplete-week"],
            { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: failingNewsCardGenerator },
          ),
        1,
      );
      assert.equal(existsSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json")), false);
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
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      // D2 (8%) vem antes de D1 (2%) na caption e no carrossel de imagens.
      assert.match(capturedBody.text, /1\. D2 muito clicado[\s\S]*2\. D1 pouco clicado/);
      // #5330: capa (sem foto) abre o carrossel, CTA (sem foto) fecha — os 2
      // itens de notícia ficam no meio, na mesma ordem de antes.
      assert.equal(capturedBody.image_urls.length, 4);
      assert.match(capturedBody.image_urls[0], /\/flat\/img-unknown-weekly-.*-clicked-cover-4x5\.jpg$/);
      // #5330: itens de notícia agora são RECOMPOSTOS com o tamanho de fonte
      // único do carrossel — a URL vem do fakeNewsCardGenerator, não mais da
      // URL fixturada em addImageFixture (que só alimentava o caminho antigo
      // de "reusa a URL já publicada tal como está").
      // fontSize faz parte da chave/nome do arquivo (#5330 fleet review —
      // cache nunca serve tamanho desatualizado) — casa por padrão, não
      // valor exato, já que o tamanho depende da fórmula de wrap real.
      assert.match(capturedBody.image_urls[1], /\/news\/img-unknown-weekly-271225-clicked-271220-d2-\d+-4x5\.jpg$/);
      assert.match(capturedBody.image_urls[2], /\/news\/img-unknown-weekly-271225-clicked-271220-d1-\d+-4x5\.jpg$/);
      assert.match(capturedBody.image_urls[3], /\/flat\/img-unknown-weekly-.*-clicked-cta-4x5\.jpg$/);
      assert.equal(capturedBody.image_url, null);

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "scheduled");
    });
  });

  describe("#6185: seleção por clique lê edição de origem Kit (broadcast completed em data/kit-cache/broadcasts/)", () => {
    it("candidato Kit (24% de taxa) vence candidato Beehiiv (0%) — prova que o ranking lê o cache unificado, não só Beehiiv", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);

      const dirA = setupEdition(editionsRoot, "271220", [
        { n: 1, title: "D1 Beehiiv sem clique", url: "https://exemplo.com/beehiiv-sem-clique" },
      ]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      writeCachePost(dataRoot, "post_1220", {
        id: "post_1220",
        title: "Edição 271220",
        status: "confirmed",
        publish_date: epochFor("271220"),
        stats: { email: { clicks: 0, unique_opens: 50 }, clicks: [] },
      });

      const dirB = setupEdition(editionsRoot, "271221", [
        { n: 1, title: "D1 Kit com clique", url: "https://exemplo.com/kit-com-clique" },
      ]);
      addImageFixture(dirB, 1, "https://cdn.example.com/271221-d1.jpg");
      const publishedAtLocalNoon = new Date(2027, 11, 21, 12, 0, 0).toISOString();
      writeKitCachePost(dataRoot, 900_1221, {
        id: 900_1221,
        subject: "Assunto Kit 271221",
        send_at: null,
        status: "completed",
        public: true,
        published_at: publishedAtLocalNoon,
        created_at: publishedAtLocalNoon,
        description: null,
        thumbnail_url: null,
        publication_id: 1,
        clicks: [{ url: "https://exemplo.com/kit-com-clique", unique_clicks: 12, click_to_delivery_rate: 0.2, click_to_open_rate: 0.24 }],
        stats: { recipients: 500, emails_opened: 50, unsubscribes: 0, total_clicks: 12, show_total_clicks: true, status: "completed" },
      });

      let captured = "";
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
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

      try {
        await main(
          ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
          { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
        );
      } finally {
        console.log = originalLog;
      }

      // O candidato Kit (24%: 12 cliques / 50 aberturas) vem ANTES do
      // Beehiiv (0%) — prova que o broadcast Kit entrou no ranking real via
      // `windowPostsUnified`, não `ratePct: 0` por omissão de origem.
      assert.match(capturedBody.text, /1\. D1 Kit com clique[\s\S]*2\. D1 Beehiiv sem clique/);

      // Nenhum warning de "sem dados de clique" pra 271221 — o broadcast
      // Kit foi encontrado e casado com a janela (#6185: sem isso, a edição
      // Kit ficaria de fora de `windowPostsUnified` e o warning apareceria
      // mesmo com o broadcast presente).
      assert.ok(
        !captured.includes("Sem dados de clique pra edição 271221"),
        `271221 não deveria aparecer em warning de dado ausente: ${captured}`,
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "scheduled");
    });
  });

  describe("#5903: --force-urls (override manual da seleção algorítmica)", () => {
    it("ordem forçada vence a ordem por taxa de clique — item MENOS clicado pode vir primeiro se listado primeiro", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);

      const dirA = setupEdition(editionsRoot, "271220", [
        { n: 1, title: "D1 muito clicado", url: "https://exemplo.com/d1-alto" },
        { n: 2, title: "D2 pouco clicado", url: "https://exemplo.com/d2-baixo" },
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
            { url: "https://exemplo.com/d1-alto", base_url: "https://exemplo.com/d1-alto", email: { unique_verified_clicks: 8 } },
            { url: "https://exemplo.com/d2-baixo", base_url: "https://exemplo.com/d2-baixo", email: { unique_verified_clicks: 2 } },
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
        [
          "--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week",
          "--force-urls", "https://exemplo.com/d2-baixo,https://exemplo.com/d1-alto",
        ],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      // Sem --force-urls, D1 (8%) viria antes de D2 (2%) — a ordem forçada
      // inverte isso: D2 (menos clicado) primeiro, por ter sido listado primeiro.
      assert.match(capturedBody.text, /1\. D2 pouco clicado[\s\S]*2\. D1 muito clicado/);
      // #5905 fleet review: em modo clicked, "As notícias de IA mais lidas
      // da semana" (#7571) viraria uma afirmação factualmente incorreta sob
      // seleção manual — a intro troca pra uma frase neutra.
      assert.match(capturedBody.text, /^Os destaques da semana na diar\.ia\.br:/);
      assert.doesNotMatch(capturedBody.text, /mais lidas/i);
    });

    it("--force-urls sem valor (fim do argv ou seguido de outra flag) — aborta com erro explícito, nunca cai de volta pra seleção algorítmica em silêncio", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único destaque", url: "https://exemplo.com/unico" }]);

      let captured = "";
      const origError = console.error;
      console.error = (...args: any[]) => {
        captured += args.join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          // --force-urls é o ÚLTIMO token — parseArgs não tem valor seguinte
          // pra atribuir, então cai em `flags`, não em `values`.
          () => main(
            ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-urls"],
            { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
          ),
          1,
        );
      } finally {
        console.error = origError;
      }

      assert.match(captured, /--force-urls foi passado sem valor/);
    });

    it("URL comercial/afiliada (ex: amazon.com.br) forçada — aborta, não bypassa a exclusão da seleção automática", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupEdition(editionsRoot, "271220", [
        { n: 1, title: "Destaque normal", url: "https://exemplo.com/normal" },
        { n: 2, title: "Produto na Amazon", url: "https://www.amazon.com.br/produto-x" },
      ]);

      let captured = "";
      const origError = console.error;
      console.error = (...args: any[]) => {
        captured += args.join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () => main(
            [
              "--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week",
              "--force-urls", "https://exemplo.com/normal,https://www.amazon.com.br/produto-x",
            ],
            { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
          ),
          1,
        );
      } finally {
        console.error = origError;
      }

      assert.match(captured, /--force-urls contém URL\(s\) comercial\/afiliada\/própria/);
      assert.match(captured, /amazon\.com\.br/);
    });

    it("--force-urls + --mode both — aborta cedo (pools de candidatos diferentes entre os 2 modos)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único destaque", url: "https://exemplo.com/unico" }]);

      let captured = "";
      const origError = console.error;
      console.error = (...args: any[]) => {
        captured += args.join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () => main(
            [
              "--saturday", saturdayStr, "--mode", "both", "--editions-root", editionsRoot, "--schedule",
              "--force-urls", "https://exemplo.com/unico",
            ],
            { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
          ),
          1,
        );
      } finally {
        console.error = origError;
      }

      assert.match(captured, /--force-urls não é compatível com --mode both/);
    });

    it("URL fora do pool de candidatos elegíveis da semana — aborta sem chamar nenhum publisher", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único destaque", url: "https://exemplo.com/unico" }]);

      // Nenhum interceptor registrado — `mockAgent.disableNetConnect()`
      // (beforeEach) faz qualquer chamada de rede não-mockada lançar, então
      // se o script chegasse a chamar um publisher (não deveria: aborta
      // antes) o teste falharia por essa exceção, não silenciosamente.
      let captured = "";
      const origError = console.error;
      console.error = (...args: any[]) => {
        captured += args.join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () => main(
            [
              "--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week",
              "--force-urls", "https://exemplo.com/url-que-nao-existe",
            ],
            { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
          ),
          1,
        );
      } finally {
        console.error = origError;
      }

      assert.match(captured, /--force-urls contém URL\(s\) fora do pool/);
    });
  });

  describe("#7571: --force-font-size (override manual do tamanho de fonte do carrossel)", () => {
    it("sem valor (fim do argv ou seguido de outra flag) — aborta com erro explícito, nunca cai de volta pro cálculo automático em silêncio", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "D1 da segunda", url: "https://exemplo.com/seg" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");

      let captured = "";
      const origError = console.error;
      console.error = (...args: any[]) => {
        captured += args.join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          // --force-font-size é o ÚLTIMO token — parseArgs não tem valor
          // seguinte pra atribuir, então cai em `flags`, não em `values`
          // (mesmo achado do #5905 pra --force-urls, replicado aqui pelo
          // review do PR #7573 — 3 agentes independentes flagaram).
          () => main(
            ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-font-size"],
            { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
          ),
          1,
        );
      } finally {
        console.error = origError;
      }

      assert.match(captured, /--force-font-size foi passado sem valor/);
    });

    it("valor inválido (não-inteiro, zero, negativo) — aborta com erro nomeando o valor recebido", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupEdition(editionsRoot, "271220", [{ n: 1, title: "D1 da segunda", url: "https://exemplo.com/seg" }]);

      for (const bad of ["0", "-5", "3.5", "abc"]) {
        let captured = "";
        const origError = console.error;
        console.error = (...args: any[]) => {
          captured += args.join(" ") + "\n";
        };
        try {
          await expectMockedExit(
            () => main(
              ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-font-size", bad],
              { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
            ),
            1,
          );
        } finally {
          console.error = origError;
        }
        assert.match(captured, /--force-font-size inválido/, `valor '${bad}' deveria ser rejeitado`);
      }
    });

    it("valor válido substitui computeCarouselTitleFontSize — URLs dos cards de notícia embutem o tamanho forçado, não o calculado", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "D1 da segunda", url: "https://exemplo.com/seg" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");

      let capturedBody: any = null;
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return {
            statusCode: 200,
            data: JSON.stringify({ queued: true, key: "queue:instagram:forced-font:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly-highlights" }),
          };
        });

      await main(
        ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-font-size", "99"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      // 99 é um valor que computeCarouselTitleFontSize nunca produziria pro
      // título curto deste fixture (ficaria em TITLE_SIZE_MAX de verdade) —
      // se o override não tivesse efeito, a asserção abaixo falharia contra
      // o tamanho calculado de verdade, não contra 99.
      assert.match(capturedBody.image_urls[1], /\/news\/img-unknown-weekly-271225-highlights-271220-d1-99-4x5\.jpg$/);
    });
  });

  describe("#5330: --mode highlights (os 5 D1 da semana, sem ranking, agenda no PRÓPRIO sábado)", () => {
    it("D1 de cada edição, ordem cronológica, agendado no sábado (não domingo) — ignora dado de clique inteiramente", async () => {
      const saturday = new Date(2027, 11, 25); // sábado
      const saturdayStr = aammddOf(saturday);

      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "D1 da segunda", url: "https://exemplo.com/seg" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      const dirB = setupEdition(editionsRoot, "271221", [{ n: 1, title: "D1 da terça", url: "https://exemplo.com/ter" }]);
      addImageFixture(dirB, 1, "https://cdn.example.com/271221-d1.jpg");
      // Sem cache Beehiiv nenhum — modo highlights não deveria precisar disso.

      let capturedBody: any = null;
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return {
            statusCode: 200,
            data: JSON.stringify({ queued: true, key: "queue:instagram:highlights:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly-highlights" }),
          };
        });

      await main(
        ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      assert.match(capturedBody.text, /^Confira aqui o resumo dos destaques:/);
      assert.match(capturedBody.text, /1\. D1 da segunda[\s\S]*2\. D1 da terça/);
      assert.equal(capturedBody.destaque, "weekly-highlights");
      assert.equal(capturedBody.image_urls.length, 4);
      assert.match(capturedBody.image_urls[0], /\/flat\/img-unknown-weekly-.*-highlights-cover-4x5\.jpg$/);
      assert.match(capturedBody.image_urls[1], /\/news\/img-unknown-weekly-271225-highlights-271220-d1-\d+-4x5\.jpg$/);
      assert.match(capturedBody.image_urls[2], /\/news\/img-unknown-weekly-271225-highlights-271221-d1-\d+-4x5\.jpg$/);
      assert.match(capturedBody.image_urls[3], /\/flat\/img-unknown-weekly-.*-highlights-cta-4x5\.jpg$/);

      // Agendado no PRÓPRIO sábado (dayOffset=0), não no domingo (dayOffset
      // default do modo "clicked") — diferença-chave do #5330.
      assert.equal(capturedBody.scheduled_at, "2027-12-25T11:00:00-03:00");

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const post = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(post.destaque, "weekly-highlights");
      assert.equal(post.status, "scheduled");
    });

    it("highlights e clicked do MESMO sábado, rodados em sequência, nunca colidem em skip-existing", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único D1", url: "https://exemplo.com/unico" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      writeCachePost(dataRoot, "post_a", {
        id: "post_a",
        title: "Edição 271220",
        status: "confirmed",
        publish_date: epochFor("271220"),
        stats: { email: { clicks: 1, unique_opens: 100 }, clicks: [{ url: "https://exemplo.com/unico", base_url: "https://exemplo.com/unico", email: { unique_verified_clicks: 1 } }] },
      });

      let requestCount = 0;
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply(() => {
          requestCount++;
          return { statusCode: 200, data: JSON.stringify({ queued: true, key: `queue:instagram:${requestCount}`, scheduled_at: "x", destaque: "weekly" }) };
        })
        // #5348 (unidade Threads) + #8052 (LinkedIn wired): Threads e
        // LinkedIn passaram a compartilhar o MESMO Worker queue do Instagram
        // — cada modo agora bate /queue 3x (instagram + threads + linkedin),
        // não mais 1x nem 2x. 2 modos × 3 canais = 6.
        .times(6);

      await main(
        ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );
      await main(
        ["--saturday", saturdayStr, "--mode", "clicked", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      assert.equal(requestCount, 6, "os 2 modos × 3 canais (instagram+threads+linkedin) deveriam disparar 6 chamadas de rede distintas — nenhum skip-existing indevido entre eles");
      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const destaques = out.posts.filter((p: any) => p.platform === "instagram").map((p: any) => p.destaque);
      assert.deepEqual(destaques.sort(), ["weekly-clicked", "weekly-highlights"]);
      const threadsDestaques = out.posts.filter((p: any) => p.platform === "threads").map((p: any) => p.destaque);
      assert.deepEqual(threadsDestaques.sort(), ["weekly-clicked", "weekly-highlights"]);
      const linkedInDestaques = out.posts.filter((p: any) => p.platform === "linkedin").map((p: any) => p.destaque);
      assert.deepEqual(linkedInDestaques.sort(), ["weekly-clicked", "weekly-highlights"]);
    });

    it("#5348 self-review (pr-test-analyzer): skip-existing é POR CANAL — Threads já 'scheduled' de uma tentativa anterior NÃO é re-tentado, mas Instagram (ainda sem entry) dispara normalmente na mesma rodada", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");

      // Simula uma re-run parcial: uma tentativa anterior já agendou o
      // Threads com sucesso (persistido em 06-weekly-published.json), mas o
      // processo morreu antes de tentar Instagram/Facebook.
      const publishedDir = resolve(dataRoot, "weekly", saturdayStr);
      mkdirSync(publishedDir, { recursive: true });
      writeFileSync(
        resolve(publishedDir, "06-weekly-published.json"),
        JSON.stringify({
          posts: [
            {
              platform: "threads",
              destaque: "weekly-highlights",
              url: null,
              status: "scheduled",
              scheduled_at: "2027-12-25T11:00:00-03:00",
              worker_queue_key: "queue:threads:pre-existing",
            },
          ],
        }),
      );

      const queueCalls: string[] = [];
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          const body = JSON.parse(opts.body as string);
          queueCalls.push(body.channel);
          return { statusCode: 200, data: JSON.stringify({ queued: true, key: `queue:${body.channel}:new`, scheduled_at: body.scheduled_at, destaque: body.destaque }) };
        })
        // #8052: Instagram + LinkedIn batem /queue (Threads é pulado por
        // skip-existing — entry pré-existente).
        .times(2);
      // Facebook não configurado neste teste (env limpo pelo afterEach da
      // suite) — cai em status:"failed" sem travar o resto, irrelevante
      // pro que este teste verifica (skip-existing do Threads).

      await main(
        ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      // #8052: LinkedIn agora também bate /queue (nenhuma entry pré-existente
      // pra ele) — só Threads é pulado por skip-existing (já 'scheduled').
      assert.deepEqual(queueCalls, ["instagram", "linkedin"], "Instagram e LinkedIn deveriam ter batido /queue — Threads foi pulado por skip-existing (já 'scheduled')");

      const out = JSON.parse(readFileSync(resolve(publishedDir, "06-weekly-published.json"), "utf8"));
      const threadsEntries = out.posts.filter((p: any) => p.platform === "threads" && p.destaque === "weekly-highlights");
      assert.equal(threadsEntries.length, 1, "a entry Threads pré-existente não deveria ser duplicada nem re-tentada");
      assert.equal(threadsEntries[0].worker_queue_key, "queue:threads:pre-existing", "a entry original não deveria ser sobrescrita");
      const igEntry = out.posts.find((p: any) => p.platform === "instagram" && p.destaque === "weekly-highlights");
      assert.ok(igEntry, "Instagram deveria ter uma entry nova, mesmo com Threads já publicado");
      assert.equal(igEntry.status, "scheduled");
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
        { dataRoot, sectionCardGenerator: fakeGenerator, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      // RADAR (8%) vence D1 (2%) — vem primeiro na caption E no carrossel.
      assert.match(capturedBody.text, /1\. Item de Radar vencedor[\s\S]*2\. D1 pouco clicado/);
      assert.equal(capturedBody.image_urls.length, 4);
      assert.equal(capturedBody.image_urls[1], "https://cdn.example.com/radar-card-gerado-sob-demanda.jpg");
      assert.match(capturedBody.image_urls[2], /\/news\/img-unknown-weekly-271225-clicked-271220-d1-\d+-4x5\.jpg$/);
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
          () => main(["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-click-data"], { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator }),
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
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      assert.equal(out.posts.find((p: any) => p.platform === "instagram").status, "scheduled");
    });
  });

  describe("carrossel: item sem imagem resolvível — post inteiro falha", () => {
    it("2º item com recomposição falhando (arte-base ausente) → falha nomeando edição+destaque, Worker NUNCA é chamado", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      setupEdition(editionsRoot, "271220", [{ n: 1, title: "Com imagem", url: "https://exemplo.com/com-imagem" }]);
      setupEdition(editionsRoot, "271221", [{ n: 1, title: "Sem imagem", url: "https://exemplo.com/sem-imagem" }]);

      // #5330: itens de notícia são RECOMPOSTOS via newsCardGenerator — simula
      // arte-base ausente pro item da 271221 (mesmo cenário de antes, agora
      // expresso como falha do generator em vez de URL ausente no JSON).
      const failingForSecondEdition: NewsCardGenerator = async ({ editionDate, destaque }) => {
        if (editionDate === "271221") throw new Error(`arte-base de ${destaque} ausente em 271221 (simulado)`);
        return { url: "https://cdn.example.com/recompose/271220-d1.jpg" };
      };

      // disableNetConnect() garante que qualquer fetch não-mockado lança —
      // nenhum interceptor registrado de propósito.
      await main(
        // #4511: sem cache Beehiiv pra nenhuma das 2 edições → precisa de
        // --force-incomplete-click-data pra chegar na checagem de imagem.
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: failingForSecondEdition },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const instagram = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(instagram.status, "failed");
      assert.match(instagram.reason, /on_demand_card_generation_failed:271221/);
      assert.match(instagram.reason, /arte-base de d1 ausente em 271221/);
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
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
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
            { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
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
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
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
              { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
            ),
          1,
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /dado de clique INCOMPLETO/);
      assert.match(captured, /edição\(ões\) sem post confirmado no cache Beehiiv\/Kit: 271220/);
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
            { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
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
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
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
              { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
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

  describe("#5330 fleet review (test-coverage): flatCardGenerator lançando é tratado como falha, não propaga sem bookkeeping", () => {
    it("generator lança (font ausente, KV mal-configurado, etc.) → status:failed gravado, nenhuma chamada de rede pro Worker de post", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "D1", url: "https://exemplo.com/d1" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");

      const throwingGenerator: FlatCardGenerator = async () => {
        throw new Error("platform.config.json → poll.kv_namespace_id não configurado (simulado)");
      };

      // Nenhum mockAgent.intercept — se o script tentasse postar mesmo assim,
      // o teste falharia por disableNetConnect() (undici lança em request
      // não-interceptada), confirmando que a falha do flat card ABORTA antes
      // de qualquer chamada de rede pro /queue.
      await main(
        ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, flatCardGenerator: throwingGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const post = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(post.status, "failed");
      assert.equal(post.destaque, "weekly-highlights");
      assert.match(post.reason, /flat_card_generation_failed/);
    });
  });

  describe("#8480 (260919): capa/CTA sempre 84px, cards internos sempre 62px — overflow ABORTA em vez de encolher", () => {
    it("capa/CTA: card sem foto sempre renderiza fixo em 84px, mesmo com título curto que ANTES encolheria/cresceria via fill", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "D1 curto", url: "https://exemplo.com/d1" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");

      let receivedLayouts: unknown[] = [];
      const layoutCapturingFlatCardGenerator: FlatCardGenerator = async ({ kvKey, layout }) => {
        receivedLayouts.push(layout);
        return { url: `https://cdn.example.com/flat/${kvKey}` };
      };

      mockAgent.get("https://worker.test").intercept({ path: "/queue", method: "POST" }).reply(200, {
        queued: true,
        key: "queue:instagram:1",
        scheduled_at: "2027-12-25T11:00:00-03:00",
        destaque: "weekly-highlights",
      });

      await main(
        ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, flatCardGenerator: layoutCapturingFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      // 2 chamadas: cover + cta, ambas com o MESMO layout fixo 84px (nunca
      // `{ mode: "fill" }`, que era o default pré-#8480).
      assert.equal(receivedLayouts.length, 2);
      for (const layout of receivedLayouts) {
        assert.deepEqual(layout, { mode: "fixed", size: 84, charWidthRatio: 0.62 });
      }
    });

    it("cards internos (com foto): SEMPRE fontSize=62 embutido na URL do card de notícia, mesmo com títulos curtos que ANTES subiriam pra até 88px", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      // Título de 2 chars ("IA") — com o cálculo antigo (computeCarouselTitleFontSize)
      // um único título curto fecharia perto do teto (88px). Com o piso
      // fixo (#8480), sai sempre 62.
      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "IA", url: "https://exemplo.com/d1" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");

      let capturedBody: any = null;
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return {
            statusCode: 200,
            data: JSON.stringify({ queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly-highlights" }),
          };
        });

      await main(
        ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      assert.match(capturedBody.image_urls[1], /\/news\/img-unknown-weekly-271225-highlights-271220-d1-62-4x5\.jpg$/);
    });

    it("cards internos: título que NÃO cabe no piso fixo (62px) ABORTA o carrossel inteiro (status:failed pros 4 canais), reescrever é o fix indicado", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      // Título deliberadamente longo — o teto de 52 chars é regra de D1/D2/D3,
      // não vale pra RADAR/USE MELHOR (o caso real que motivou a issue).
      const overflowingTitle =
        "Um título de notícia extraordinariamente longo, do tipo que só um item de RADAR ou USE MELHOR carregaria, sem o teto editorial de 52 caracteres dos destaques";
      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: overflowingTitle, url: "https://exemplo.com/d1" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");

      // Nenhum mockAgent.intercept — se o script tentasse postar mesmo
      // assim, o teste falharia por disableNetConnect() (undici lança em
      // request não-interceptada), confirmando que o overflow ABORTA antes
      // de qualquer chamada de rede pro /queue.
      await main(
        ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const post = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(post.status, "failed");
      assert.match(post.reason, /overlay_title_overflow_62px/);
    });
  });

  describe("#5348: Facebook — mesmo carrossel do Instagram, publicado junto (sem flag/canal separado)", () => {
    it("sucesso nos 2 canais — Facebook recebe o MESMO carrossel (cover+news+cta), agenda no MESMO horário do Instagram", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");
      process.env.FACEBOOK_PAGE_ID = "999";
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "fbtoken";

      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply(200, { queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-26T11:00:00-03:00", destaque: "weekly-clicked" });

      const fbMock = mockAgent.get("https://graph.facebook.com");
      let photoCalls = 0;
      const photoUrlsSeen: string[] = [];
      fbMock
        .intercept({ path: "/v25.0/999/photos", method: "POST" })
        .reply((opts) => {
          photoCalls++;
          // #5348 self-review: `opts.body` pra um POST via fetch()+FormData é
          // o objeto FormData em si (não serializado) neste runtime — bem
          // mais simples de inspecionar que parsear multipart cru.
          const body = opts.body as FormData;
          photoUrlsSeen.push(String(body.get("url")));
          assert.equal(body.get("published"), "false", "sempre unpublished — scheduling é o /feed do passo 2, nunca publish imediato de foto solta");
          return { statusCode: 200, data: JSON.stringify({ id: `photo_${photoCalls}` }) };
        })
        .times(3); // cover + 1 news card + cta = 3 imagens no carrossel de 1 item

      let feedBody: FormData | null = null;
      fbMock
        .intercept({ path: "/v25.0/999/feed", method: "POST" })
        .reply((opts) => {
          feedBody = opts.body as FormData;
          return { statusCode: 200, data: JSON.stringify({ id: "999_post123" }) };
        });

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      assert.equal(photoCalls, 3, "1 POST /photos por imagem do carrossel (cover+news+cta)");
      assert.equal(photoUrlsSeen.length, 3);
      // MESMAS URLs que o Instagram recebeu (mesmo carrossel, #5348) — cover
      // termina em cover-4x5.jpg, cta em cta-4x5.jpg, a do meio é a notícia.
      assert.ok(photoUrlsSeen.some((u) => u.endsWith("cover-4x5.jpg")));
      assert.ok(photoUrlsSeen.some((u) => u.endsWith("cta-4x5.jpg")));
      assert.ok(feedBody, "/feed deveria ter sido chamado após os 3 /photos");
      const feedForm = feedBody as unknown as FormData;
      // attached_media[0..2] — 1 campo de form POR ÍNDICE (Graph API não aceita array JSON único).
      assert.deepEqual(JSON.parse(String(feedForm.get("attached_media[0]"))), { media_fbid: "photo_1" });
      assert.deepEqual(JSON.parse(String(feedForm.get("attached_media[1]"))), { media_fbid: "photo_2" });
      assert.deepEqual(JSON.parse(String(feedForm.get("attached_media[2]"))), { media_fbid: "photo_3" });
      assert.ok(feedForm.get("scheduled_publish_time"), "agenda nativamente via scheduled_publish_time — Facebook não passa pelo Worker queue");
      assert.equal(feedForm.get("published"), "false");
      // Caption do Facebook tem link CLICÁVEL no corpo (diferente do Instagram, "link na bio").
      assert.match(String(feedForm.get("message")), /diar\.ia\.br/);
      assert.match(String(feedForm.get("message")), /1\. Único/);

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const fbEntry = out.posts.find((p: any) => p.platform === "facebook");
      const igEntry = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(fbEntry.status, "scheduled");
      assert.equal(fbEntry.url, "https://www.facebook.com/999/posts/999_post123");
      assert.equal(fbEntry.scheduled_at, igEntry.scheduled_at, "MESMO agendamento pros 2 canais (#5348)");
      assert.equal(igEntry.status, "scheduled");
    });

    it("FACEBOOK_PAGE_ID/TOKEN ausentes — Instagram publica normalmente, Facebook marca failed sem travar o resto", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");
      // #6206: apagar explicitamente, não confiar no afterEach da suite — ele só
      // reverte chaves ausentes do originalEnv (diff-based), então numa máquina
      // com .env real (credenciais reais carregadas antes dos testes) essas 2
      // variáveis nunca são zeradas e o teste vaza pra uma tentativa de fetch de
      // verdade (barrada por disableNetConnect(), reason genérico "fetch failed"
      // em vez de "facebook_not_configured").
      delete process.env.FACEBOOK_PAGE_ID;
      delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply(200, { queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-26T11:00:00-03:00", destaque: "weekly-clicked" });
      // Nenhum interceptor pro graph.facebook.com — se o script tentasse
      // chamar mesmo assim, disableNetConnect() derrubaria o teste.

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const fb = out.posts.find((p: any) => p.platform === "facebook");
      const ig = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(fb.status, "failed");
      assert.equal(fb.reason, "facebook_not_configured");
      assert.equal(ig.status, "scheduled");
    });

    it("Facebook falha na API (foto rejeitada) — Instagram já agendado NÃO é desfeito, Facebook marca failed com o motivo", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");
      process.env.FACEBOOK_PAGE_ID = "999";
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "fbtoken";

      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply(200, { queued: true, key: "queue:instagram:1", scheduled_at: "2027-12-26T11:00:00-03:00", destaque: "weekly-clicked" });

      mockAgent
        .get("https://graph.facebook.com")
        .intercept({ path: "/v25.0/999/photos", method: "POST" })
        .reply(400, { error: { message: "Invalid image URL (simulado)" } });
      // /feed nunca deveria ser chamado — falha parcial aborta o carrossel
      // inteiro (mesma decisão de escopo do Instagram, #4153). Nenhum
      // interceptor registrado pra /feed — disableNetConnect() denunciaria
      // uma tentativa indevida.

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const fb = out.posts.find((p: any) => p.platform === "facebook");
      const ig = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(fb.status, "failed");
      assert.match(fb.reason, /Facebook POST \/photos/);
      assert.equal(ig.status, "scheduled", "Facebook falhando não desfaz o Instagram já agendado");
    });
  });

  describe("#8052: LinkedIn — wiring real do dispatch (mecanismo já existia desde #8083)", () => {
    it("sucesso — LinkedIn recebe o MESMO carrossel do Instagram/Facebook/Threads, reusando LITERALMENTE fbCaption (nenhum formatLinkedInWeekly)", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");

      const capturedByChannel: Record<string, any> = {};
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          const body = JSON.parse(opts.body as string);
          capturedByChannel[body.channel] = body;
          return {
            statusCode: 200,
            data: JSON.stringify({ queued: true, key: `queue:${body.channel}:1`, scheduled_at: "2027-12-26T11:00:00-03:00", destaque: body.destaque }),
          };
        })
        .times(3); // instagram + threads + linkedin

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      assert.ok(capturedByChannel.linkedin, "LinkedIn deveria ter batido /queue");
      // #8052: reusa LITERALMENTE o mesmo texto do Facebook (fbCaption) —
      // mesma decisão do editor (briefing 260913b), sem formatter dedicado.
      // Facebook não passa pelo Worker queue (Graph API direta), então
      // comparamos contra o texto ESPERADO de `formatFacebookWeekly`, não
      // contra uma entry "facebook" no /queue (que nunca existe).
      assert.match(capturedByChannel.linkedin.text, /^As notícias de IA mais lidas da semana na diar\.ia\.br:/);
      assert.match(capturedByChannel.linkedin.text, /1\. Único/);
      // fbCaption inclui link CLICÁVEL no corpo (diferente da convenção do
      // publisher diário do LinkedIn, que nunca coloca URL no corpo) —
      // divergência aceita explicitamente pelo editor.
      assert.match(capturedByChannel.linkedin.text, /diar\.ia\.br\/\?utm_source=facebook/);
      // MESMO carrossel de imagens que Instagram/Threads recebem.
      assert.deepEqual(capturedByChannel.linkedin.image_urls, capturedByChannel.instagram.image_urls);
      assert.equal(capturedByChannel.linkedin.image_url, null);
      assert.equal(capturedByChannel.linkedin.destaque, "weekly-clicked");

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const liEntry = out.posts.find((p: any) => p.platform === "linkedin");
      assert.equal(liEntry.status, "scheduled");
      const igEntry = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(liEntry.scheduled_at, igEntry.scheduled_at, "MESMO agendamento do Instagram (#8052)");
    });

    it("Worker não configurado (sem DIARIA_LINKEDIN_CRON_URL/TOKEN) — LinkedIn marca failed sem travar Instagram", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");
      delete process.env.DIARIA_LINKEDIN_CRON_URL;
      delete process.env.DIARIA_LINKEDIN_CRON_TOKEN;
      // Sem interceptor pro /queue — se o script tentasse chamar mesmo assim
      // (Instagram/Threads/LinkedIn), disableNetConnect() derrubaria o teste.

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const liEntry = out.posts.find((p: any) => p.platform === "linkedin");
      assert.equal(liEntry.status, "failed");
      assert.equal(liEntry.reason, "worker_not_configured");
      const igEntry = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(igEntry.status, "failed", "sem Worker configurado, TODOS os canais que passam por /queue falham — mas cada um com sua própria entry, nenhum trava o outro");
    });

    it("#8303: Worker rejeita enqueue (creds LinkedIn ausentes no Worker) — LinkedIn marca 'skipped' com motivo, NÃO 'scheduled'/'failed', Instagram/Threads seguem normalmente", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");

      const queueCalls: string[] = [];
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          const body = JSON.parse(opts.body as string);
          queueCalls.push(body.channel);
          // #8303 — mesma resposta que o Worker real dá (handleEnqueue) quando
          // channel=linkedin carrega carrossel e LINKEDIN_ACCESS_TOKEN/
          // LINKEDIN_AUTHOR_URN não estão configurados nele. Instagram e
          // Threads continuam 200 normalmente — o Worker rejeita só o canal
          // sem credencial, não o request inteiro.
          if (body.channel === "linkedin") {
            return {
              statusCode: 400,
              data: JSON.stringify({
                error:
                  "channel='linkedin' com carrossel (image_urls) requer LINKEDIN_ACCESS_TOKEN e LINKEDIN_AUTHOR_URN configurados no Worker (API direta, #8052) — não configurados",
                code: "linkedin_creds_missing",
              }),
            };
          }
          return {
            statusCode: 200,
            data: JSON.stringify({ queued: true, key: `queue:${body.channel}:1`, scheduled_at: "2027-12-26T11:00:00-03:00", destaque: body.destaque }),
          };
        })
        .times(3); // instagram + threads + linkedin (linkedin responde 400, sem retry — ver worker-queue-client.ts)

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      assert.ok(queueCalls.includes("linkedin"), "o script AINDA tenta o enqueue — quem recusa é o Worker, não uma checagem local de process.env");
      assert.equal(queueCalls.filter((c) => c === "linkedin").length, 1, "HTTP 400 (rejeição de validação) não deve ser re-tentado — retry não mudaria o resultado");

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const liEntry = out.posts.find((p: any) => p.platform === "linkedin");
      assert.equal(liEntry.status, "skipped", "nunca 'scheduled' pra algo que o Worker recusou — era exatamente o falso positivo do #8303");
      assert.equal(liEntry.reason, "linkedin_creds_missing");
      assert.equal(liEntry.worker_queue_key, undefined, "nada foi enfileirado — sem key de fila pra registrar");

      // Instagram e Threads não são afetados pelo LinkedIn ter sido pulado.
      const igEntry = out.posts.find((p: any) => p.platform === "instagram");
      assert.equal(igEntry.status, "scheduled");
      const threadsEntry = out.posts.find((p: any) => p.platform === "threads");
      assert.equal(threadsEntry.status, "scheduled");
    });

    it("skip-existing: LinkedIn já 'scheduled' de uma tentativa anterior NÃO é re-tentado", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");

      const publishedDir = resolve(dataRoot, "weekly", saturdayStr);
      mkdirSync(publishedDir, { recursive: true });
      writeFileSync(
        resolve(publishedDir, "06-weekly-published.json"),
        JSON.stringify({
          posts: [
            {
              platform: "linkedin",
              destaque: "weekly-clicked",
              url: null,
              status: "scheduled",
              scheduled_at: "2027-12-26T11:00:00-03:00",
              worker_queue_key: "queue:linkedin:pre-existing",
            },
          ],
        }),
      );

      const queueCalls: string[] = [];
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          const body = JSON.parse(opts.body as string);
          queueCalls.push(body.channel);
          return { statusCode: 200, data: JSON.stringify({ queued: true, key: `queue:${body.channel}:new`, scheduled_at: body.scheduled_at, destaque: body.destaque }) };
        })
        // Instagram + Threads batem /queue (LinkedIn é pulado por skip-existing).
        .times(2);

      await main(
        ["--saturday", saturdayStr, "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week", "--force-incomplete-click-data"],
        { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
      );

      assert.ok(!queueCalls.includes("linkedin"), "LinkedIn não deveria ter batido /queue de novo — já 'scheduled'");
      assert.ok(queueCalls.includes("instagram"), "Instagram (sem entry pré-existente) deveria disparar normalmente");

      const out = JSON.parse(readFileSync(resolve(publishedDir, "06-weekly-published.json"), "utf8"));
      const liEntries = out.posts.filter((p: any) => p.platform === "linkedin" && p.destaque === "weekly-clicked");
      assert.equal(liEntries.length, 1, "a entry LinkedIn pré-existente não deveria ser duplicada nem re-tentada");
      assert.equal(liEntries[0].worker_queue_key, "queue:linkedin:pre-existing");
    });
  });

  describe("#5349: --mode both — roda os 2 modos numa única invocação", () => {
    it("--day-offset é incompatível com --mode both — aborta antes de rodar qualquer modo", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      let captured = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () =>
            main(
              ["--saturday", saturdayStr, "--mode", "both", "--day-offset", "2", "--editions-root", editionsRoot],
              { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
            ),
          1,
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /--day-offset não é compatível com --mode both/);
      assert.equal(existsSync(resolve(dataRoot, "weekly")), false, "nenhum modo deveria ter chegado a rodar");
    });

    it("--manifest-only é incompatível com --mode both — aborta antes de rodar qualquer modo", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      let captured = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () =>
            main(
              ["--saturday", saturdayStr, "--mode", "both", "--manifest-only", "--editions-root", editionsRoot],
              { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
            ),
          1,
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /--manifest-only não é compatível com --mode both/);
    });

    it("agenda os 2 carrosséis (highlights no sábado, clicked no domingo) numa única invocação", async () => {
      const saturday = new Date(2027, 11, 25); // sábado
      const saturdayStr = aammddOf(saturday);

      const dirA = setupEdition(editionsRoot, "271220", [{ n: 1, title: "D1 da segunda", url: "https://exemplo.com/seg" }]);
      addImageFixture(dirA, 1, "https://cdn.example.com/271220-d1.jpg");
      writeCachePost(dataRoot, "post_1220", {
        id: "post_1220",
        title: "Edição 271220",
        status: "confirmed",
        publish_date: epochFor("271220"),
        stats: { email: { clicks: 3, unique_opens: 100 }, clicks: [{ url: "https://exemplo.com/seg", base_url: "https://exemplo.com/seg", email: { unique_verified_clicks: 3 } }] },
      });

      const scheduledAts: string[] = [];
      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply((opts) => {
          const body = JSON.parse(opts.body as string);
          // #5348 (unidade Threads) + #8052 (LinkedIn wired): Threads e
          // LinkedIn passaram a compartilhar o MESMO Worker queue do
          // Instagram — cada modo agora bate /queue 3x (instagram + threads
          // + linkedin), não mais 1x nem 2x.
          scheduledAts.push(`${body.channel}:${body.destaque}@${body.scheduled_at}`);
          return { statusCode: 200, data: JSON.stringify({ queued: true, key: `queue:${body.channel}:${body.destaque}`, scheduled_at: body.scheduled_at, destaque: body.destaque }) };
        })
        .times(6);

      let captured = "";
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await main(
          ["--saturday", saturdayStr, "--mode", "both", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
          { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
        );
      } finally {
        console.log = originalLog;
      }
      assert.match(captured, /--mode both — rodando "highlights" e "clicked" em sequência/);
      assert.equal(
        scheduledAts.length,
        6,
        "os 2 modos deveriam ter chamado o Worker queue 3x cada (instagram + threads + linkedin, #5348/#8052)",
      );
      assert.ok(scheduledAts.some((s) => s.startsWith("instagram:weekly-highlights@2027-12-25")));
      assert.ok(scheduledAts.some((s) => s.startsWith("instagram:weekly-clicked@2027-12-26")));
      assert.ok(scheduledAts.some((s) => s.startsWith("threads:weekly-highlights@2027-12-25")));
      assert.ok(scheduledAts.some((s) => s.startsWith("threads:weekly-clicked@2027-12-26")));
      assert.ok(scheduledAts.some((s) => s.startsWith("linkedin:weekly-highlights@2027-12-25")));
      assert.ok(scheduledAts.some((s) => s.startsWith("linkedin:weekly-clicked@2027-12-26")));

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const highlights = out.posts.find((p: any) => p.destaque === "weekly-highlights");
      const clicked = out.posts.find((p: any) => p.destaque === "weekly-clicked");
      assert.equal(highlights.status, "scheduled");
      assert.equal(clicked.status, "scheduled");
      // highlights agenda no PRÓPRIO sábado (offset 0), clicked no domingo seguinte (offset 1, #5330).
      assert.match(highlights.scheduled_at as string, /^2027-12-25T11:00:00/);
      assert.match(clicked.scheduled_at as string, /^2027-12-26T11:00:00/);
    });

    it("falha em um modo não impede o outro — clicked sem dado de clique falha, highlights agenda normalmente, processo sai com código 1", async () => {
      const saturday = new Date(2027, 11, 25);
      const saturdayStr = aammddOf(saturday);
      const dir = setupEdition(editionsRoot, "271220", [{ n: 1, title: "Único destaque", url: "https://exemplo.com/unico" }]);
      addImageFixture(dir, 1, "https://cdn.example.com/271220-d1.jpg");
      // Sem writeCachePost — cache Beehiiv vazio: "clicked" bate no gate de dado
      // de clique incompleto (sem --force-incomplete-click-data) e falha;
      // "highlights" nem olha pra esse dado e agenda normalmente (com
      // --force-incomplete-week, já que só 1 de 5 itens é elegível).

      mockAgent
        .get("https://worker.test")
        .intercept({ path: "/queue", method: "POST" })
        .reply(200, { queued: true, key: "queue:instagram:highlights:1", scheduled_at: "2027-12-25T11:00:00-03:00", destaque: "weekly-highlights" });

      let captured = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        captured += args.map(String).join(" ") + "\n";
      };
      try {
        await expectMockedExit(
          () =>
            main(
              ["--saturday", saturdayStr, "--mode", "both", "--editions-root", editionsRoot, "--schedule", "--force-incomplete-week"],
              { dataRoot, flatCardGenerator: fakeFlatCardGenerator, newsCardGenerator: fakeNewsCardGenerator },
            ),
          1,
        );
      } finally {
        console.error = originalError;
      }
      assert.match(captured, /dado de clique INCOMPLETO/);

      const out = JSON.parse(readFileSync(resolve(dataRoot, "weekly", saturdayStr, "06-weekly-published.json"), "utf8"));
      const highlights = out.posts.find((p: any) => p.destaque === "weekly-highlights");
      const clicked = out.posts.find((p: any) => p.destaque === "weekly-clicked");
      assert.equal(highlights.status, "scheduled", "highlights deveria ter sido agendado mesmo com 'clicked' falhando");
      assert.equal(clicked, undefined, "clicked nunca chegou a gravar nada — falhou antes do mkdirSync/tagAndAppend");
    });
  });
});
