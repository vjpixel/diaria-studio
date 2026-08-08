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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverWorkerPublicHosts } from "../scripts/lib/worker-public-hosts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = resolve(ROOT, "workers");

/** Varre recursivamente `dir` procurando algum `.ts` que contenha `needle`. */
function anyTsFileContains(dir: string, needle: string): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (anyTsFileContains(full, needle)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      if (readFileSync(full, "utf8").includes(needle)) return true;
    }
  }
  return false;
}

describe("guard: todo Worker com host público (custom_domain) tem /robots.txt próprio (#4777)", () => {
  const hosts = discoverWorkerPublicHosts(WORKERS_DIR);

  it("descobriu ao menos 1 host público — se isto falhar, checar o parser antes de confiar no resto do guard", () => {
    assert.ok(hosts.length > 0, "discoverWorkerPublicHosts não achou nenhum host — parser provavelmente quebrou");
  });

  for (const { workerDir, host } of hosts) {
    it(`workers/${workerDir} (${host}) serve /robots.txt próprio (não o default da Cloudflare)`, () => {
      const publicRobots = join(WORKERS_DIR, workerDir, "public", "robots.txt");
      if (existsSync(publicRobots)) {
        assert.ok(
          readFileSync(publicRobots, "utf8").trim().length > 0,
          `${publicRobots} existe mas está vazio`,
        );
        return;
      }

      const srcDir = join(WORKERS_DIR, workerDir, "src");
      assert.ok(
        anyTsFileContains(srcDir, "/robots.txt"),
        `workers/${workerDir} (host público ${host}) não tem public/robots.txt nem referência a "/robots.txt" ` +
          `em src/ — nasceu servindo o robots.txt DEFAULT da Cloudflare (bloqueia os 7 crawlers de IA, ver #4546/#4777).`,
      );
    });
  }
});
