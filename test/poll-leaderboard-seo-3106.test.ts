/**
 * test/poll-leaderboard-seo-3106.test.ts (#3106)
 *
 * Regressão pra meta tags de SEO/compartilhamento (description, Open Graph,
 * Twitter card, canonical, favicon) nas páginas `/leaderboard*` do worker
 * `poll` — antes desta issue elas só tinham charset+viewport+title, então um
 * link compartilhado no WhatsApp/LinkedIn/Slack saía cru.
 *
 * Cobre as 5 rotas por trás de `renderLeaderboardHtml` / `renderArchiveListHtml`
 * / `renderArchiveVoteHtml`:
 *   1. GET /leaderboard                       (mês corrente, brand diaria)
 *   2. GET /leaderboard/{YYYY-MM}              (mês específico)
 *   3. GET /leaderboard/{YYYY}                 (ano — período canônico da clarice)
 *   4. GET /leaderboard/{YYYY}/arquivo         (lista de edições arquivadas)
 *   5. GET /leaderboard/{YYYY}/arquivo/{AAMMDD} (voto retroativo de 1 edição)
 *
 * Cada teste verifica que og:url/canonical apontam pro path EXATO que foi
 * requisitado (não outro) — regressão específica: `/leaderboard` (sem slug)
 * delega internamente pra `handleLeaderboardByMonth`, que por padrão
 * calcularia canonical com o slug do mês corrente; sem o override explícito
 * o crawler indexaria a URL errada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data)
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(seed: Record<string, string> = {}): Env {
  return {
    POLL: makeKv(seed),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

async function fetchHtml(path: string, env: Env = makeEnv()): Promise<string> {
  const req = new Request(`https://poll.diaria.workers.dev${path}`);
  const res = await workerDefault.fetch(req, env, {} as ExecutionContext);
  assert.equal(res.status, 200, `esperava 200 para ${path}, recebeu ${res.status}`);
  return res.text();
}

/** Asserções comuns a qualquer página coberta: description, OG básico, twitter
 * card, favicon presentes; og:image/twitter:image ausentes (decisão #3106). */
function assertCommonSeoTags(html: string, canonicalPath: string) {
  assert.match(html, /<meta name="description" content="[^"]+">/, "description ausente");
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:site_name" content="Diar\.ia">/);
  assert.match(html, /<meta property="og:title" content="[^"]+">/, "og:title ausente");
  assert.match(html, /<meta property="og:description" content="[^"]+">/, "og:description ausente");
  assert.match(html, /<meta name="twitter:card" content="summary">/, "twitter:card ausente");
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/, "favicon ausente");
  assert.doesNotMatch(html, /property="og:image"/, "og:image não deveria existir (decisão #3106)");
  assert.doesNotMatch(html, /name="twitter:image"/, "twitter:image não deveria existir (decisão #3106)");

  const escapedPath = canonicalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ogUrlRe = new RegExp(`<meta property="og:url" content="https://poll\\.diaria\\.workers\\.dev${escapedPath}">`);
  const canonicalRe = new RegExp(`<link rel="canonical" href="https://poll\\.diaria\\.workers\\.dev${escapedPath}">`);
  assert.match(html, ogUrlRe, `og:url deveria apontar pra ${canonicalPath}`);
  assert.match(html, canonicalRe, `canonical deveria apontar pra ${canonicalPath}`);
}

describe("GET /leaderboard — canonical aponta pro path SELF (sem slug), não pro mês corrente (#3106)", () => {
  it("canonical/og:url = /leaderboard (não /leaderboard/{slug-do-mês-corrente})", async () => {
    const html = await fetchHtml("/leaderboard");
    assertCommonSeoTags(html, "/leaderboard");
  });
});

describe("GET /leaderboard/{YYYY-MM} — canonical inclui o slug do mês (#3106)", () => {
  it("canonical/og:url = /leaderboard/2026-03", async () => {
    const html = await fetchHtml("/leaderboard/2026-03");
    assertCommonSeoTags(html, "/leaderboard/2026-03");
  });
});

describe("GET /leaderboard/{YYYY} — canonical inclui o ano (#3106)", () => {
  it("canonical/og:url = /leaderboard/2026", async () => {
    const html = await fetchHtml("/leaderboard/2026");
    assertCommonSeoTags(html, "/leaderboard/2026");
  });
});

describe("GET /leaderboard/{YYYY}/arquivo — canonical inclui /arquivo (#3106)", () => {
  it("canonical/og:url = /leaderboard/2026/arquivo", async () => {
    const html = await fetchHtml("/leaderboard/2026/arquivo");
    assertCommonSeoTags(html, "/leaderboard/2026/arquivo");
  });
});

describe("GET /leaderboard/{YYYY}/arquivo/{AAMMDD} — canonical inclui a edição (#3106)", () => {
  it("canonical/og:url = /leaderboard/2026/arquivo/260101 (edição com gabarito fechado)", async () => {
    const env = makeEnv({ "correct:260101": "A" });
    const html = await fetchHtml("/leaderboard/2026/arquivo/260101", env);
    assertCommonSeoTags(html, "/leaderboard/2026/arquivo/260101");
  });
});

describe("brand=clarice — canonical/og:url preserva ?brand=clarice (#3106)", () => {
  it("GET /leaderboard/2026?brand=clarice → canonical com query preservada", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    assertCommonSeoTags(html, "/leaderboard/2026?brand=clarice");
    // Título/descrição devem refletir a marca certa (Clarice News), não Diar.ia.
    assert.match(html, /<meta property="og:title" content="[^"]*Clarice News[^"]*">/);
  });
});
