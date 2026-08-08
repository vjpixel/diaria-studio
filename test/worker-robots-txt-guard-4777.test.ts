/**
 * test/worker-robots-txt-guard-4777.test.ts (#4777, passo 2 da issue)
 *
 * Guard: TODO Worker com host público num domínio proxiado pela Cloudflare
 * (`[[routes]] custom_domain = true` em `workers/*​/wrangler.toml`) precisa
 * servir um `/robots.txt` PRÓPRIO — sem isso, o Worker nasce servindo o
 * default gerenciado pela Cloudflare, que bloqueia os 7 crawlers de
 * assistente/treino contra a decisão do editor de 03/ago (CLAUDE.md,
 * "Crawlers de IA ficam liberados nas nossas superfícies"). Aconteceu 3
 * vezes sem que ninguém reparasse (#4546: cursos/livros/arquivo; #4777:
 * poll/artigo-mensal/artigos) antes deste teste existir — o objetivo é que
 * o QUARTO Worker com custom_domain novo falhe aqui até ganhar seu próprio
 * handler, em vez de precisar de outro `curl` manual pra descobrir.
 *
 * Descoberta 100% automática via `discoverWorkerPublicHosts`
 * (`scripts/lib/worker-public-hosts.ts`) — sem lista hardcoded de hosts, o
 * mesmo padrão de `worker-drift-check.ts` (#4723). Dois caminhos de
 * handler são aceitos:
 *   1. Worker static-assets-only: `public/robots.txt` existe (o conteúdo
 *      exato é responsabilidade de testes dedicados por Worker, ex:
 *      `curadoria-sitemap-robots.test.ts`, `artigos-robots-txt-4777.test.ts`
 *      — aqui só confirma presença, não conteúdo).
 *   2. Worker com script: `src/` referencia a string `"/robots.txt"` em
 *      algum `.ts` — sinal de que existe uma rota registrada no código
 *      (verificação estrutural, não invoca `fetch` — cada Worker dinâmico
 *      já tem seu próprio teste de integração via `worker.fetch`, ex:
 *      `test/arquivo-render.test.ts`, `test/poll-robots-txt-4777.test.ts`,
 *      `test/worker-artigo-mensal-gate-3940.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverWorkerPublicHosts, anyTsFileHasRobotsRouteDispatch } from "../scripts/lib/worker-public-hosts.ts";
import { robotsTxtAllowsGeneralCrawling } from "../scripts/lib/shared/robots-txt.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = resolve(ROOT, "workers");

/**
 * Conjunto EXATO de hosts esperados hoje (#4782 achado 4) — `hosts.length >
 * 0` sozinho é piso, não teto: se o parser regredisse de 6 hosts pra 2, essa
 * checagem sozinha não percebe. Uma regressão real do parser (ou um Worker
 * novo que ganhou `custom_domain = true` sem que ninguém atualizasse esta
 * lista) faz este teste falhar — o que é o comportamento desejado: força
 * conferir/atualizar deliberadamente, nunca silencioso.
 */
const EXPECTED_HOSTS = [
  "arquivo:arquivo.diar.ia.br",
  "artigo-mensal:artigo.diar.ia.br",
  "artigos:especial.diar.ia.br",
  "cursos:cursos.diar.ia.br",
  "livros:livros.diar.ia.br",
  "poll:eia.diar.ia.br",
].sort();

describe("guard: todo Worker com host público (custom_domain) tem /robots.txt próprio (#4777)", () => {
  const hosts = discoverWorkerPublicHosts(WORKERS_DIR);

  it("descobriu ao menos 1 host público — se isto falhar, checar o parser antes de confiar no resto do guard", () => {
    assert.ok(hosts.length > 0, "discoverWorkerPublicHosts não achou nenhum host — parser provavelmente quebrou");
  });

  it("descobre exatamente o conjunto esperado de hosts públicos (#4782 achado 4 — piso vira teto)", () => {
    const discovered = hosts.map((h) => `${h.workerDir}:${h.host}`).sort();
    assert.deepEqual(
      discovered,
      EXPECTED_HOSTS,
      "conjunto de hosts descobertos mudou — se foi Worker novo/renomeado de propósito, atualize EXPECTED_HOSTS " +
        "acima; se não, é regressão do parser (hosts.length > 0 sozinho não detectaria isso).",
    );
  });

  for (const { workerDir, host } of hosts) {
    it(`workers/${workerDir} (${host}) serve /robots.txt próprio (não o default da Cloudflare)`, () => {
      const publicRobots = join(WORKERS_DIR, workerDir, "public", "robots.txt");
      if (existsSync(publicRobots)) {
        const content = readFileSync(publicRobots, "utf8");
        assert.ok(content.trim().length > 0, `${publicRobots} existe mas está vazio`);
        // #4782 achado 2: arquivo não-vazio não basta — um robots.txt
        // estático que fosse cópia do default bloqueante da Cloudflare
        // também passaria na checagem acima. Exige o mínimo de correção:
        // `Allow: /` sob `User-agent: *` e nenhum `Disallow: /` genérico ali.
        assert.ok(
          robotsTxtAllowsGeneralCrawling(content),
          `${publicRobots} não libera crawling geral (falta "Allow: /" sob "User-agent: *", ou tem um ` +
            `"Disallow: /" genérico ali) — conteúdo pode ser cópia do default bloqueante da Cloudflare.`,
        );
        return;
      }

      const srcDir = join(WORKERS_DIR, workerDir, "src");
      assert.ok(
        anyTsFileHasRobotsRouteDispatch(srcDir),
        `workers/${workerDir} (host público ${host}) não tem public/robots.txt nem uma rota real pra "/robots.txt" ` +
          `em src/ — nasceu servindo o robots.txt DEFAULT da Cloudflare (bloqueia os 7 crawlers de IA, ver #4546/#4777).`,
      );
    });
  }
});
