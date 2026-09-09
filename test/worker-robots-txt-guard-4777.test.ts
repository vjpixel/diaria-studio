/**
 * test/worker-robots-txt-guard-4777.test.ts (#4777, passo 2 da issue)
 *
 * Guard: TODO Worker com host público num domínio proxiado pela Cloudflare
 * (`[[routes]] custom_domain = true` em `workers/*​/wrangler.toml`) precisa
 * servir um `/robots.txt` PRÓPRIO — sem isso, o Worker nasce servindo só o
 * default gerenciado pela Cloudflare, que bloqueia os 7 crawlers de
 * assistente/treino contra a decisão do editor de 03/ago (CLAUDE.md,
 * "Crawlers de IA ficam liberados nas nossas superfícies"). **Correção
 * (#4910): mesmo servindo o próprio, o default gerenciado NÃO some — ele é
 * ANEXADO antes do bloco do Worker no mesmo arquivo, e como grupo nomeado
 * vence o curinga `*` (RFC 9309), os 7 crawlers continuam bloqueados pelo
 * bloco da Cloudflare independente deste teste passar; ver a docstring de
 * `scripts/lib/shared/robots-txt.ts` pro comportamento completo e por que
 * isso não quebra o objetivo de citação do #4546.** Este guard garante só
 * que o Worker declara SUA PARTE corretamente (`CURADORIA_BLOCKED_BOTS`) —
 * não que o arquivo final servido esteja livre do bloco gerenciado.
 * Aconteceu 3 vezes sem que ninguém reparasse (#4546: cursos/livros/
 * arquivo; #4777: poll/artigo-mensal/artigos) antes deste teste existir —
 * o objetivo é que o QUARTO Worker com custom_domain novo falhe aqui até
 * ganhar seu próprio handler, em vez de precisar de outro `curl` manual
 * pra descobrir.
 *
 * Descoberta 100% automática via `discoverWorkerPublicHosts`
 * (`scripts/lib/worker-public-hosts.ts`) — sem lista hardcoded de hosts, o
 * mesmo padrão de `worker-drift-check.ts` (#4723). A asserção por host é
 * HOST-AWARE (#7733) via `classifyHostRobotsHandling`, que reconhece três
 * padrões de roteamento (não há verificação genérica "src/ menciona
 * robots.txt em algum lugar" — isso é exatamente o defeito que o #7733
 * corrigiu, que dava `ok` pra qualquer host de um diretório com custom_domain
 * múltiplo só porque OUTRO host do mesmo diretório tinha a rota):
 *   1. Worker static-assets-only: `public/robots.txt` existe e passa por um
 *      mínimo de correção de conteúdo (`robotsTxtAllowsGeneralCrawling` —
 *      `Allow: /` sob `User-agent: *`, sem `Disallow: /` genérico ali,
 *      #4782 achado 2); o conteúdo exato específico de cada Worker segue
 *      nos testes dedicados, ex: `curadoria-sitemap-robots.test.ts`,
 *      `artigos-robots-txt-4777.test.ts`.
 *   2. Worker com script, host sem ramificação por `url.host`: `src/` tem
 *      um dispatch de rota REAL pra `/robots.txt` (`anyTsFileHasRobotsRouteDispatch`
 *      — `===`/`case`, não apenas a string aparecendo solta num comentário
 *      ou log, #4782 achado 1) — sinal de que existe uma rota registrada no
 *      código (verificação estrutural, não invoca `fetch` — cada Worker
 *      dinâmico já tem seu próprio teste de integração via `worker.fetch`,
 *      ex: `test/arquivo-render.test.ts`, `test/poll-robots-txt-4777.test.ts`).
 *   3. Worker multi-host com redirect-tudo (#7658/#7709, `workers/retrospectiva`):
 *      um host redireciona INCONDICIONALMENTE (`if (url.host === X) { ...
 *      return Response.redirect(...) }`, sem testar `url.pathname` na mesma
 *      condição) pra outro host que, por sua vez, serve robots.txt via 1 ou
 *      2 acima. Reconhecido por `analyzeHostBranching`.
 *   Roteamento que não casa nenhum dos três padrões — inclusive um host que
 *   aparece numa condição `url.host === ...` cujo bloco NÃO é redirect-tudo
 *   reconhecível (redirect parcial por path, alvo não resolvível) — produz
 *   `cannot-verify`, nunca `ok`: o guard preventivo que passa por não ter
 *   entendido o código é pior que o guard impreciso de antes do #7733, que
 *   ao menos era honesto sobre o que checava.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverWorkerPublicHosts, classifyHostRobotsHandling } from "../scripts/lib/worker-public-hosts.ts";
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
// #7658/PR #7709 consolidou as três retrospectivas num Worker só:
// `workers/anual` virou `workers/retrospectiva` e `workers/artigo-mensal` foi
// absorvido (removido). O Worker resultante declara os TRÊS custom_domain —
// `retrospectiva.diar.ia.br` (novo) mais `anual.diar.ia.br` e
// `artigo.diar.ia.br` (preservados pra não quebrar link publicado). Esta
// lista não acompanhou o rename e deixou o master vermelho; é exatamente o
// caso que a mensagem de erro da asserção prevê ("se foi Worker novo/
// renomeado de propósito, atualize EXPECTED_HOSTS").
//
// O guard por Worker (abaixo) não acusou nada junto, o que é o sinal de que
// a consolidação NÃO perdeu robots.txt no caminho — só a lista esperada
// ficou defasada.
const EXPECTED_HOSTS = [
  "arquivo:arquivo.diar.ia.br",
  "artigos:especial.diar.ia.br",
  "cursos:cursos.diar.ia.br",
  "livros:livros.diar.ia.br",
  "poll:eia.diar.ia.br",
  "retrospectiva:anual.diar.ia.br",
  "retrospectiva:artigo.diar.ia.br",
  "retrospectiva:retrospectiva.diar.ia.br",
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

  const siblingHostsByWorkerDir = new Map<string, string[]>();
  for (const { workerDir, host } of hosts) {
    const list = siblingHostsByWorkerDir.get(workerDir) ?? [];
    list.push(host);
    siblingHostsByWorkerDir.set(workerDir, list);
  }

  for (const { workerDir, host } of hosts) {
    it(`workers/${workerDir} (${host}) serve /robots.txt próprio (não o default da Cloudflare)`, () => {
      const verdict = classifyHostRobotsHandling(WORKERS_DIR, workerDir, host, siblingHostsByWorkerDir.get(workerDir));

      if (verdict.kind === "cannot-verify") {
        assert.fail(
          `workers/${workerDir} (host ${host}): o guard não conseguiu determinar o roteamento de robots.txt com ` +
            `confiança — ${verdict.reason}. Analise manualmente; se o comportamento estiver correto, ensine o ` +
            `padrão ao guard (analyzeHostBranching em scripts/lib/worker-public-hosts.ts) em vez de contornar aqui ` +
            `— um guard que passa em silêncio por não ter entendido o código é pior que um guard impreciso (#7733).`,
        );
        return;
      }

      if (verdict.kind === "missing") {
        assert.fail(
          `workers/${workerDir} (host público ${host}) não tem public/robots.txt nem uma rota real pra "/robots.txt" ` +
            `em src/ — nasceu servindo o robots.txt DEFAULT da Cloudflare (bloqueia os 7 crawlers de IA, ver #4546/#4777).`,
        );
        return;
      }

      // "ok-direct" ou "ok-redirect": se este Worker serve public/robots.txt
      // (diretamente, ou como destino de um redirect-tudo de outro host),
      // ainda valida o CONTEÚDO — existência sozinha não basta (#4782
      // achado 2: pode ser cópia do default bloqueante da Cloudflare).
      const publicRobots = join(WORKERS_DIR, workerDir, "public", "robots.txt");
      if (existsSync(publicRobots)) {
        const content = readFileSync(publicRobots, "utf8");
        assert.ok(content.trim().length > 0, `${publicRobots} existe mas está vazio`);
        assert.ok(
          robotsTxtAllowsGeneralCrawling(content),
          `${publicRobots} não libera crawling geral (falta "Allow: /" sob "User-agent: *", ou tem um ` +
            `"Disallow: /" genérico ali) — conteúdo pode ser cópia do default bloqueante da Cloudflare.`,
        );
      }
      // Sem public/robots.txt: verificado estruturalmente (verdict acima)
      // que este host alcança um dispatch de rota real pra "/robots.txt",
      // direto ou via redirect-tudo pra outro host do mesmo Worker.
    });
  }
});
