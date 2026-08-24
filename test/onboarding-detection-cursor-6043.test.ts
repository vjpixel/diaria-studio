/**
 * test/onboarding-detection-cursor-6043.test.ts (#6043)
 *
 * Regressão do incidente de mass-send de 24/08/2026: `fetchSubscriptionsSince`
 * em `scripts/onboarding-welcome-run.ts` filtrava via `created_at__gte` na
 * query da API pública v2 da Beehiiv — parâmetro NÃO honrado por esse
 * endpoint (confirmado ao vivo contra a API real: `created_at__gte`,
 * `created__gte`, `created_after`, `min_created`, `since` e `created_at_gte`
 * são todos silenciosamente ignorados, a resposta sempre volta na ordem
 * padrão created ASC — mais antigo primeiro). A run de produção do dia
 * tratou boa parte da base histórica de assinantes como "novos" e mandou
 * o e-mail 1 de boas-vindas a 585 deles, alguns com até 1 ano de casa.
 *
 * Fix: pedir `order_by=created&direction=desc` (confirmado funcional) e
 * filtrar CLIENT-SIDE, parando assim que a página (ordenada desc) alcança
 * um item `created < cursor` (corte ESTRITO — ver docstring de
 * `fetchSubscriptionsSince`: empate exato no cursor conta como novo, pra
 * manter a semântica inclusiva do `created_at__gte` original).
 *
 * Este teste sobe um mock HTTP local da API Beehiiv (mesmo padrão de
 * test/verify-scheduled-post.test.ts — override `BEEHIIV_API_URL`, nunca
 * toca a API real). Cobre:
 *
 *   1. A requisição feita à Beehiiv usa `order_by=created&direction=desc`
 *      (nunca mais `created_at__gte`, que provou ser um no-op perigoso).
 *   2. Assinantes com `created < cursor` NUNCA entram em `detected_new`,
 *      mesmo vindo na mesma resposta que assinantes genuinamente novos —
 *      é exatamente o cenário que causou o incidente (resposta contendo
 *      uma mistura de antigos e novos, sem filtro de servidor confiável).
 *   3. Um assinante com `created === cursor` (empate exato) É contado como
 *      novo — achado do review de #6054: um corte `<=` dropava esse caso
 *      permanentemente, pois o cursor avança pro maior `created` visto e
 *      um empate no próximo run cairia fora do filtro sem passar sequer
 *      pelo dedup por id de `classifyNewSubscribers`.
 *   4. Com `--send` (segundo teste), o cursor persistido em disco avança
 *      pro maior `created` DETECTADO (não o antigo, que nunca entra em
 *      `all`) — prova que `main()` não regride pra uma direção errada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "onboarding-welcome-run.ts");
const PUB_ID = "pub_test_6043";

function spawnScriptAsync(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      env,
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/**
 * Mock mínimo de GET /publications/{pubId}/subscriptions. Devolve SEMPRE a
 * mesma página (mistura de antigo + novo, ordenada desc) e registra a
 * última query string recebida pra asserção de parâmetros.
 */
function startMockBeehiiv(subscriptions: { id: string; email: string; status: string; created: number }[]): Promise<{
  server: Server;
  url: string;
  /** Query string da chamada à LISTAGEM (`GET .../subscriptions`) — distinta
   * do GET individual por id (`.../subscriptions/{id}`), que o script também
   * chama no passo de refresh e não deve mascarar a asserção. */
  lastListQuery: () => string;
}> {
  let lastListQuery = "";
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (!parsed.pathname.endsWith("/subscriptions")) {
        // GET individual por id (refresh de status/stats) — não usado por
        // este teste (assinantes ficam fora da janela de refresh), mas
        // respondido de forma inofensiva caso aconteça.
        res.writeHead(404);
        res.end(JSON.stringify({ error: `unexpected path ${parsed.pathname}` }));
        return;
      }
      lastListQuery = parsed.search;
      const page = Number(parsed.searchParams.get("page") ?? "1");
      // Só a página 1 tem dados — página 2 vazia encerra a paginação se o
      // script não parar sozinho ao cruzar o cursor (defesa em profundidade).
      const data = page === 1 ? subscriptions : [];
      res.writeHead(200);
      res.end(JSON.stringify({ data, total_results: subscriptions.length, limit: 100 }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, lastListQuery: () => lastListQuery });
    });
  });
}

describe("onboarding-welcome-run.ts — detecção via cursor (#6043)", () => {
  // Cursor relativo a AGORA (não um epoch fixo arbitrário): os "novos"
  // ficam a minutos/segundos de distância — bem dentro da janela de 3 dias
  // do e-mail 2, então NÃO disparam o passo de refresh individual (que só
  // olha candidatos due), o que deixaria as asserções mais simples e fiéis
  // ao caminho real (detecção pura, sem ruído de outra chamada).
  function buildFixture() {
    const nowSec = Math.floor(Date.now() / 1000);
    const CURSOR = nowSec - 3600; // 1h atrás
    // 2 "novos" (created > cursor) + 1 "empatado" (created === cursor,
    // achado #6054 — deve contar como novo) + 1 "antigo" (created < cursor)
    // — todos na MESMA resposta, replicando o cenário real do incidente:
    // página mista, sem filtro de servidor confiável.
    const subscriptions = [
      { id: "sub_novo_2", email: "novo2@example.com", status: "active", created: nowSec - 200 },
      { id: "sub_novo_1", email: "novo1@example.com", status: "active", created: nowSec - 100 },
      { id: "sub_empate_cursor", email: "empate@example.com", status: "active", created: CURSOR },
      { id: "sub_antigo", email: "antigo@example.com", status: "active", created: CURSOR - 999_999 },
    ];
    return { nowSec, CURSOR, subscriptions };
  }

  it("filtra client-side por created < cursor (estrito) e nunca envia created_at__gte à API", async () => {
    const { CURSOR, subscriptions } = buildFixture();
    const { server, url, lastListQuery } = await startMockBeehiiv(subscriptions);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-onboarding-6043-"));
    try {
      const configPath = resolve(dir, "platform.config.json");
      const storePath = resolve(dir, "store.json");
      const snippetsDir = resolve(dir, "snippets"); // vazio de propósito — dry-run não precisa de conteúdo definitivo
      writeFileSync(
        configPath,
        JSON.stringify({ onboarding: { enabled: true, snippets_dir: snippetsDir, store_path: storePath } }),
      );
      // Store fixture: cursor já bootstrapado (não é a 1ª execução), sem entries conhecidas.
      writeFileSync(
        storePath,
        JSON.stringify({ version: 1, last_detection_cursor: CURSOR, d10_brevo_list_id: null, entries: {} }),
      );

      const r = await spawnScriptAsync(["--config", configPath, "--store", storePath], {
        ...process.env,
        BEEHIIV_API_KEY: "test-key-6043",
        BEEHIIV_PUBLICATION_ID: PUB_ID,
        BEEHIIV_API_URL: url,
        BREVO_DIARIA_API_KEY: "test-brevo-key-6043",
      });

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);
      const summary = JSON.parse(r.stdout) as { mode: string; detected_new: number };
      assert.equal(summary.mode, "dry-run");
      assert.equal(
        summary.detected_new,
        3,
        `esperado detectar os 2 "novos" + o empatado no cursor (created === cursor conta como novo) — obteve ${summary.detected_new}. stdout: ${r.stdout}`,
      );

      const query = lastListQuery();
      assert.equal(
        query.includes("created_at__gte"),
        false,
        `a requisição NUNCA deve usar created_at__gte (provado no-op contra a API real, #6043) — query: ${query}`,
      );
      assert.match(query, /order_by=created/, `esperado order_by=created na query — obteve: ${query}`);
      assert.match(query, /direction=desc/, `esperado direction=desc na query — obteve: ${query}`);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--send: cursor persistido em disco avança pro maior created DETECTADO, entry antiga nunca entra no store", async () => {
    const { nowSec, CURSOR, subscriptions } = buildFixture();
    const { server, url } = await startMockBeehiiv(subscriptions);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-onboarding-6043-send-"));
    try {
      const configPath = resolve(dir, "platform.config.json");
      const storePath = resolve(dir, "store.json");
      const snippetsDir = resolve(dir, "snippets"); // sem arquivos — email1/2/3 ficam skip (corpo_pendente), só o cursor/entries importam aqui
      writeFileSync(
        configPath,
        JSON.stringify({
          onboarding: { enabled: true, snippets_dir: snippetsDir, store_path: storePath, sender_email: "oi@example.com" },
        }),
      );
      writeFileSync(
        storePath,
        JSON.stringify({ version: 1, last_detection_cursor: CURSOR, d10_brevo_list_id: null, entries: {} }),
      );

      const r = await spawnScriptAsync(["--config", configPath, "--store", storePath, "--send"], {
        ...process.env,
        BEEHIIV_API_KEY: "test-key-6043",
        BEEHIIV_PUBLICATION_ID: PUB_ID,
        BEEHIIV_API_URL: url,
        BREVO_DIARIA_API_KEY: "test-brevo-key-6043",
      });

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);

      const written = JSON.parse(readFileSync(storePath, "utf8")) as {
        last_detection_cursor: number;
        entries: Record<string, { email: string }>;
      };
      assert.equal(
        written.last_detection_cursor,
        nowSec - 100,
        `cursor deveria avançar pro maior created DETECTADO (o "novo" mais recente) — obteve ${written.last_detection_cursor}`,
      );
      const ids = Object.keys(written.entries);
      assert.deepEqual(
        ids.sort(),
        ["sub_empate_cursor", "sub_novo_1", "sub_novo_2"].sort(),
        `store deveria conter só os 3 detectados como novos — obteve ${JSON.stringify(ids)}`,
      );
      assert.ok(!("sub_antigo" in written.entries), "sub_antigo (created < cursor) nunca deveria entrar no store");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
