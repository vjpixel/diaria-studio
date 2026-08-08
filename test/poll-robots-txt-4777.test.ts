/**
 * test/poll-robots-txt-4777.test.ts (#4777)
 *
 * Regressão (#633) — `eia.diar.ia.br` (Worker `poll`) servia o robots.txt
 * DEFAULT gerenciado pela Cloudflare (bloqueia os 7 crawlers de assistente/
 * treino), contrariando a decisão do editor de 03/ago (CLAUDE.md, "Crawlers
 * de IA ficam liberados nas nossas superfícies"). Mesmo padrão de cobertura
 * de `test/arquivo-render.test.ts` (GET /robots.txt via `worker.fetch` real).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../workers/poll/src/index.ts";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    POLL: {} as unknown as Env["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    ...overrides,
  };
}

describe("GET /robots.txt no Worker poll (#4777)", () => {
  it("200 texto com Allow: /, Disallow: /vote e sem Sitemap: (host sem sitemap próprio)", async () => {
    const res = await worker.fetch(new Request("https://eia.diar.ia.br/robots.txt"), makeEnv());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/plain/);
    const body = await res.text();
    assert.match(body, /Allow: \//);
    // #4777 passo 3: URLs de voto são rastreáveis mas sem valor de índice.
    assert.match(body, /Disallow: \/vote/);
    assert.doesNotMatch(body, /Sitemap:/);
  });

  it("liberação seletiva (#4777, mesma decisão do #4546): só Amazonbot e CloudflareBrowserRenderingCrawler continuam bloqueados", async () => {
    const res = await worker.fetch(new Request("https://eia.diar.ia.br/robots.txt"), makeEnv());
    const body = await res.text();
    assert.match(body, /User-agent: Amazonbot\nDisallow: \//);
    assert.match(body, /User-agent: CloudflareBrowserRenderingCrawler\nDisallow: \//);
    for (const bot of [
      "GPTBot",
      "ClaudeBot",
      "CCBot",
      "Google-Extended",
      "Bytespider",
      "meta-externalagent",
      "Applebot-Extended",
    ]) {
      assert.doesNotMatch(body, new RegExp(`User-agent: ${bot}\\b`));
    }
  });

  it("não exige nenhum secret (mesma classe de rota pública que /stats, /editions)", async () => {
    const res = await worker.fetch(
      new Request("https://eia.diar.ia.br/robots.txt"),
      makeEnv({ POLL_SECRET: "", ADMIN_SECRET: "" }),
    );
    assert.equal(res.status, 200);
  });
});
