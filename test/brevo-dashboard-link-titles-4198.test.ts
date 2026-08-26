/**
 * test/brevo-dashboard-link-titles-4198.test.ts (#4198)
 *
 * KV persistence + Worker/Studio wiring pro TÍTULO editorial nas tabelas de
 * link do dashboard Clarice — a lacuna que #4218 deixou deliberadamente
 * aberta (aquele PR só entregou a camada de render pura + o parser puro
 * `parsePrioritizedUrlTitles`/`buildLinkTitleMap`, já testados em
 * `test/brevo-dashboard-link-section-4184.test.ts` e
 * `test/brevo-dashboard-link-content-4053.test.ts`). Este arquivo espelha
 * `brevo-dashboard-link-section-4184.test.ts` (o wiring KV análogo pra coluna
 * "Seção"), aplicado ao TÍTULO da coluna "Conteúdo".
 *
 * Caso real da issue (mesmo fixture canônico usado no #4184/#4218):
 * `https://link.amazon/B0249coGp` classifica como "B0249coGp (link.amazon)"
 * (rótulo ilegível) — o título editorial "Como ter acesso à Alexa+" já existe
 * em `data/monthly/2606-07/prioritized.md` e deveria substituir o rótulo
 * opaco assim que o KV/Studio estiverem servindo o mapa de título.
 *
 * Cobre:
 *  - loadLinkTitleMapForCycle (scripts/lib/mensal/monthly-link-sections.ts) —
 *    wrapper de I/O fail-soft (ciclo ausente / formato inválido → null,
 *    nunca lança). O caminho feliz "ciclo válido, prioritized.md existe,
 *    parseia corretamente" NÃO é re-testado aqui contra um
 *    `data/monthly/{ciclo}/prioritized.md` real, deliberadamente: isso exigiria
 *    criar (mesmo que transitoriamente) um diretório `data/` real na raiz do
 *    repo, e `scripts/lib/exec-mode.ts::detectExecMode` (#2643) usa
 *    justamente a presença de `data/` como sinal canônico local-vs-cloud —
 *    `node --test` roda arquivos de teste em paralelo, então um `data/`
 *    transitório aqui arriscaria uma corrida contra a detecção de exec-mode
 *    em outro arquivo rodando ao mesmo tempo. `loadLinkSectionMapForCycle`
 *    (o sibling do #4184) tem exatamente a mesma lacuna pelo mesmo motivo —
 *    o caminho feliz é coberto indiretamente pelos testes PUROS de
 *    `parsePrioritizedUrlTitles`/`buildLinkTitleMap` (já existentes no
 *    #4184/#4218), já que `loadLinkTitleMapForCycle` é só
 *    `buildLinkTitleMap(parsePrioritizedUrlTitles(fs.readFileSync(...)))` com
 *    1 try/catch em volta.
 *  - normalizeLinkTitleMap / mergeLinkTitleMaps (workers/brevo-dashboard/src/link-section.ts).
 *  - linkTitlesKvKey (workers/brevo-dashboard/src/types.ts).
 *  - readLinkTitlesByCycle (workers/brevo-dashboard/src/brevo-api.ts) — KV mock,
 *    mesmo padrão de teste que cobre readLinkSectionsByCycle indiretamente.
 *  - buildRateLimitFallback / buildFatalErrorFallback também populam o título
 *    editorial agora (mirror das 2 suítes "Seção via KV" do #4184).
 *  - E2E: renderDashboardHtml com linkTitlesByCycle exibe o título real
 *    ("Como ter acesso à Alexa+") em vez do rótulo opaco derivado da URL —
 *    tanto no drill-down por campanha quanto na tabela agregada (mesma
 *    campanha alimenta as duas seções no mesmo render).
 *  - push-link-titles-kv.ts: smoke test do CLI --dry-run (nunca toca o KV de
 *    verdade — ver header do script).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  normalizeLinkTitleMap,
  mergeLinkTitleMaps,
  readLinkTitlesByCycle,
  renderDashboardHtml,
  buildRateLimitFallback,
  buildFatalErrorFallback,
  linkTitlesKvKey,
  LASTGOOD_CAMPAIGNS_KEY,
  type BrevoLinksStats,
} from "../workers/brevo-dashboard/src/index.ts";
import { loadLinkTitleMapForCycle } from "../scripts/lib/mensal/monthly-link-sections.ts";
import { classifyLinkContent } from "../workers/brevo-dashboard/src/link-content.ts";

// ─── loadLinkTitleMapForCycle (fail-soft I/O wrapper) ──────────────────────

describe("loadLinkTitleMapForCycle (#4198)", () => {
  test("ciclo válido no formato mas sem prioritized.md em data/monthly/ (ou data/ inacessível — sessão cloud) → null, nunca lança", () => {
    assert.doesNotThrow(() => loadLinkTitleMapForCycle("9911-12"));
    assert.equal(loadLinkTitleMapForCycle("9911-12"), null);
  });

  test("identificador em formato inválido → null (monthlyDir lança internamente, capturado pelo catch)", () => {
    assert.doesNotThrow(() => loadLinkTitleMapForCycle("nao-e-um-ciclo"));
    assert.equal(loadLinkTitleMapForCycle("nao-e-um-ciclo"), null);
  });

  test("string vazia → null, nunca lança", () => {
    assert.doesNotThrow(() => loadLinkTitleMapForCycle(""));
    assert.equal(loadLinkTitleMapForCycle(""), null);
  });
});

// ─── normalizeLinkTitleMap (choke point de leitura do KV) ───────────────────

describe("normalizeLinkTitleMap (#4198)", () => {
  test("payload válido (todos os valores string) passa integralmente", () => {
    const raw = { "conteúdo a": "Título A", "conteúdo b": "Título B" };
    assert.deepEqual(normalizeLinkTitleMap(raw), raw);
  });

  test("não-objeto (null, string, array, número) → null", () => {
    assert.equal(normalizeLinkTitleMap(null), null);
    assert.equal(normalizeLinkTitleMap("texto"), null);
    assert.equal(normalizeLinkTitleMap(42), null);
    assert.equal(normalizeLinkTitleMap(["Título A"]), null);
  });

  test("filtra entradas cujo valor NÃO é string, mantém as boas (não descarta o mapa inteiro)", () => {
    const raw = { "conteúdo a": "Título A", "conteúdo b": 42, "conteúdo c": ["array"], "conteúdo d": null };
    assert.deepEqual(normalizeLinkTitleMap(raw), { "conteúdo a": "Título A" });
  });

  test("string vazia como valor é filtrada (título vazio não é título)", () => {
    const raw = { "conteúdo a": "Título A", "conteúdo b": "" };
    assert.deepEqual(normalizeLinkTitleMap(raw), { "conteúdo a": "Título A" });
  });

  test("objeto vazio → objeto vazio (não é erro)", () => {
    assert.deepEqual(normalizeLinkTitleMap({}), {});
  });
});

// ─── mergeLinkTitleMaps ──────────────────────────────────────────────────────

describe("mergeLinkTitleMaps (#4198)", () => {
  test("união de títulos por conteúdo entre múltiplos ciclos", () => {
    const a = { "clarice.ai/precos": "Título do ciclo A" };
    const b = { "outro conteúdo": "Título do ciclo B" };
    assert.deepEqual(mergeLinkTitleMaps([a, b]), {
      "clarice.ai/precos": "Título do ciclo A",
      "outro conteúdo": "Título do ciclo B",
    });
  });

  test("mesmo conteúdo em 2+ mapas → o PRIMEIRO da lista vence (nunca o último sobrescreve silenciosamente)", () => {
    const older = { "gpt 5 (openai.com)": "Título mais antigo" };
    const newer = { "gpt 5 (openai.com)": "Título mais recente" };
    assert.deepEqual(mergeLinkTitleMaps([older, newer]), { "gpt 5 (openai.com)": "Título mais antigo" });
    // ordem importa — invertendo a lista, o vencedor muda (confirma que É
    // "primeiro da lista", não "ordem alfabética" ou outro critério oculto).
    assert.deepEqual(mergeLinkTitleMaps([newer, older]), { "gpt 5 (openai.com)": "Título mais recente" });
  });

  test("entradas null/undefined são ignoradas sem lançar", () => {
    assert.doesNotThrow(() => mergeLinkTitleMaps([null, undefined, {}]));
    assert.deepEqual(mergeLinkTitleMaps([null, undefined]), {});
  });

  test("lista vazia → mapa vazio", () => {
    assert.deepEqual(mergeLinkTitleMaps([]), {});
  });
});

// ─── linkTitlesKvKey ─────────────────────────────────────────────────────────

describe("linkTitlesKvKey (#4198)", () => {
  test("formata 'titulo:{ciclo}' — sibling de linkSectionsKvKey ('secao:{ciclo}')", () => {
    assert.equal(linkTitlesKvKey("2606-07"), "titulo:2606-07");
    assert.equal(linkTitlesKvKey("2605-06"), "titulo:2605-06");
  });
});

// ─── readLinkTitlesByCycle (KV mock) ────────────────────────────────────────

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string, type?: string) => {
      const val = store.get(key);
      if (val == null) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("readLinkTitlesByCycle (#4198)", () => {
  test("sem env.STATS_CACHE → {} sem nenhuma chamada de rede", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readLinkTitlesByCycle({} as any, ["2606-07"]);
    assert.deepEqual(result, {});
  });

  test("cycles vazio → {} mesmo com KV presente (sem custo de leitura)", async () => {
    const kv = makeKv({ [linkTitlesKvKey("2606-07")]: JSON.stringify({ a: "Título A" }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readLinkTitlesByCycle({ STATS_CACHE: kv } as any, []);
    assert.deepEqual(result, {});
  });

  test("lê titulo:{ciclo} do KV pra cada ciclo, em paralelo, com dedup automático", async () => {
    const kv = makeKv({
      [linkTitlesKvKey("2606-07")]: JSON.stringify({ "gpt 5 (openai.com)": "Anthropic capta US$ 65 bi" }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readLinkTitlesByCycle({ STATS_CACHE: kv } as any, ["2606-07", "2606-07", "2606-07"]);
    assert.deepEqual(result, { "2606-07": { "gpt 5 (openai.com)": "Anthropic capta US$ 65 bi" } });
  });

  test("ciclo ausente do KV (chave nunca gravada) é omitido do resultado, não vira entrada vazia", async () => {
    const kv = makeKv({
      [linkTitlesKvKey("2606-07")]: JSON.stringify({ a: "Título A" }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readLinkTitlesByCycle({ STATS_CACHE: kv } as any, ["2606-07", "2605-06"]);
    assert.ok("2606-07" in result);
    assert.equal("2605-06" in result, false);
  });

  test("JSON corrompido no KV para um ciclo é omitido (fail-soft), outros ciclos não são afetados", async () => {
    const kv = makeKv({
      [linkTitlesKvKey("2606-07")]: JSON.stringify({ a: "Título A" }),
      [linkTitlesKvKey("2605-06")]: "{ json malformado sem fechar",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readLinkTitlesByCycle({ STATS_CACHE: kv } as any, ["2606-07", "2605-06"]);
    assert.deepEqual(result, { "2606-07": { a: "Título A" } });
  });
});

// ─── E2E: renderDashboardHtml com linkTitlesByCycle ────────────────────────
// Fixture canônico da issue: link.amazon/B0249coGp → "Como ter acesso à Alexa+".

describe("renderDashboardHtml: título editorial via linkTitlesByCycle (#4198)", () => {
  const AMAZON_URL = "https://link.amazon/B0249coGp";
  const AMAZON_BASE_CONTENT = classifyLinkContent(AMAZON_URL).content;

  test("pré-condição: sem título, o rótulo derivado da URL é o opaco da issue original", () => {
    assert.equal(AMAZON_BASE_CONTENT, "B0249coGp (link.amazon)");
  });

  test("campanha do ciclo mensal certo com linkTitlesByCycle → título editorial substitui o rótulo opaco (drill-down E agregado, mesmo render)", () => {
    const linksStats: BrevoLinksStats = { [AMAZON_URL]: 5 };
    const monthly = {
      id: 90,
      name: "Clarice News 2606-07 — A · dom",
      subject: "s",
      status: "sent",
      sentDate: "2026-07-01T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-07-01T09:00:00Z",
      recipients: { lists: [1] },
      statistics: {
        globalStats: {
          sent: 100, delivered: 98, hardBounces: 1, softBounces: 0, uniqueViews: 20, viewed: 22,
          trackableViews: 15, uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0, appleMppOpens: 3,
        },
        linksStats,
      },
    };
    const html = renderDashboardHtml([monthly], [], null, null, null, null, null, null, null, null, null, {
      linkTitlesByCycle: { "2606-07": { [AMAZON_BASE_CONTENT]: "Como ter acesso à Alexa+" } },
    });
    assert.match(html, /Como ter acesso à Alexa\+/, "título editorial deve aparecer no HTML renderizado");
    assert.doesNotMatch(html, /B0249coGp \(link\.amazon\)/, "rótulo opaco NÃO deve mais aparecer quando há título conhecido");
  });

  test("campanha diária (sem prioritized.md equivalente) — sem linkTitlesByCycle correspondente, cai no rótulo derivado (regressão)", () => {
    const linksStats: BrevoLinksStats = { [AMAZON_URL]: 5 };
    const daily = {
      id: 91,
      name: "Clarice News 2607 d05 (seg)",
      subject: "s",
      status: "sent",
      sentDate: "2026-07-05T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-07-05T09:00:00Z",
      recipients: { lists: [1] },
      statistics: {
        globalStats: {
          sent: 100, delivered: 98, hardBounces: 1, softBounces: 0, uniqueViews: 20, viewed: 22,
          trackableViews: 15, uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0, appleMppOpens: 3,
        },
        linksStats,
      },
    };
    const html = renderDashboardHtml([daily], [], null, null, null, null, null, null, null, null, null, {
      linkTitlesByCycle: { "2606-07": { [AMAZON_BASE_CONTENT]: "Como ter acesso à Alexa+" } },
    });
    assert.match(html, /B0249coGp \(link\.amazon\)/, "campanha diária não tem ciclo mensal — mapa não se aplica, cai no rótulo derivado");
  });

  test("sem linkTitlesByCycle (ausente/null) — comportamento idêntico ao pré-#4198, nunca lança", () => {
    const monthly = {
      id: 92, name: "Clarice News 2606-07 — B · dom", subject: "s", status: "sent",
      sentDate: "2026-07-01T09:00:00Z", scheduledAt: null, createdAt: "2026-07-01T09:00:00Z",
      recipients: { lists: [1] },
      statistics: { linksStats: { [AMAZON_URL]: 5 } },
    };
    let html = "";
    assert.doesNotThrow(() => { html = renderDashboardHtml([monthly]); });
    assert.match(html, /B0249coGp \(link\.amazon\)/);
  });
});

// ─── buildRateLimitFallback / buildFatalErrorFallback: título também via KV ─
// Mirror das suítes "coluna Seção via KV" do #4184, aplicado ao título.

const staleAmazonCampaign = {
  id: 902,
  name: "Clarice News 2606-07 — A · dom",
  subject: "s",
  status: "sent",
  sentDate: "2026-07-20T09:00:00Z",
  scheduledAt: null,
  createdAt: "2026-07-20T09:00:00Z",
  recipients: { lists: [] as number[] },
  statistics: { linksStats: { "https://link.amazon/B0249coGp": 5 } },
};
const AMAZON_BASE = classifyLinkContent("https://link.amazon/B0249coGp").content;

describe("buildRateLimitFallback: título editorial via KV (#4198)", () => {
  test("com titulo:{ciclo} presente no KV → título editorial aparece no fallback de 429", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleAmazonCampaign], scheduled: [], generatedAt: "2026-07-20T10:00:00.000Z",
      }),
      [linkTitlesKvKey("2606-07")]: JSON.stringify({ [AMAZON_BASE]: "Como ter acesso à Alexa+" }),
    });
    const env = { STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildRateLimitFallback(env as any, 60);
    assert.strictEqual(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /Como ter acesso à Alexa\+/, "título editorial deve aparecer mesmo no fallback de rate-limit");
  });

  test("SEM titulo:{ciclo} no KV → rótulo derivado da URL, sem crash (regressão)", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleAmazonCampaign], scheduled: [], generatedAt: "2026-07-20T10:00:00.000Z",
      }),
    });
    const env = { STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: Response;
    await assert.doesNotReject(async () => { resp = await buildRateLimitFallback(env as any, 60); });
    const body = await resp!.text();
    assert.match(body, /B0249coGp \(link\.amazon\)/);
  });
});

describe("buildFatalErrorFallback: título editorial via KV (#4198)", () => {
  test("com titulo:{ciclo} presente no KV → título editorial aparece no catch de última instância", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleAmazonCampaign], scheduled: [], generatedAt: "2026-07-20T10:00:00.000Z",
      }),
      [linkTitlesKvKey("2606-07")]: JSON.stringify({ [AMAZON_BASE]: "Como ter acesso à Alexa+" }),
    });
    const env = { STATS_CACHE: kv, COUPONS_TAB_ENABLED: "true" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildFatalErrorFallback(env as any, new Error("causa sintética"));
    assert.strictEqual(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /Como ter acesso à Alexa\+/);
  });

  test("SEM titulo:{ciclo} no KV → nunca lança (regressão)", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleAmazonCampaign], scheduled: [],
      }),
    });
    const env = { STATS_CACHE: kv, COUPONS_TAB_ENABLED: "true" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.doesNotReject(async () => buildFatalErrorFallback(env as any, "causa não-Error"));
  });
});

// ─── push-link-titles-kv.ts CLI --dry-run (nunca toca o KV de verdade) ─────

describe("push-link-titles-kv.ts CLI (#4198)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "push-link-titles-kv.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  test("--cycle sem prioritized.md (ambiente sem data/ real) → warning + exit 0, nunca grava no KV", () => {
    const result = runCli(["--cycle", "9911-12", "--dry-run"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /sem prioritized\.md/);
  });

  test("--cycle em formato inválido → exit 1, mensagem explícita", () => {
    const result = runCli(["--cycle", "nao-e-um-ciclo", "--dry-run"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--cycle inválido/);
  });

  test("sem --cycle nem --all → exit 2, uso impresso", () => {
    const result = runCli([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Uso: push-link-titles-kv\.ts/);
  });

  test("--all sem nenhum ciclo com prioritized.md → exit 1 (#6222: fixture isolada via --monthly-dir, nunca escaneia data/ real)", () => {
    // #6222: sem `--monthly-dir`, este teste dependia de `data/monthly/`
    // estar ausente (a forma do CI) — numa máquina com `data/` real
    // (editor, `helios`) SEMPRE há ao menos 1 ciclo com prioritized.md,
    // então `--all` encontrava ciclos de verdade e o teste falhava. Um
    // tmpdir vazio reproduz "nenhum ciclo encontrado" deterministicamente,
    // em qualquer ambiente.
    const emptyDir = mkdtempSync(join(tmpdir(), "push-link-titles-empty-"));
    try {
      const result = runCli(["--all", "--dry-run", "--monthly-dir", emptyDir]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /nenhum ciclo com prioritized\.md/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
