/**
 * test/onboarding-kit-detection-7599.test.ts (#7599)
 *
 * Regressão do incidente registrado na issue #7599: o cadastro migrou da
 * Beehiiv pro Kit em 04/09/2026 (#7388), mas `onboarding-welcome-run.ts`
 * continuou detectando novos assinantes lendo a Beehiiv (`resolveBeehiivConfig`
 * + `GET /subscriptions`) — a base ficou zerada e a rodada diária saía
 * "verde" (`detected_new: 0`, exit 0) sem detectar ninguém, em silêncio.
 *
 * Cobre os 3 pontos técnicos da issue que este arquivo testa de forma
 * isolada (o 4º, condição do e-mail 3, é coberto por
 * `test/onboarding-state.test.ts`):
 *
 *   (a) Detecção lendo do Kit corretamente — `publishing.newsletter
 *       .subscriber_backend: "kit"` faz o script bater no mock do Kit
 *       (`GET /subscribers?status=all`), nunca na Beehiiv, e filtrar
 *       client-side por `created_at >= cursor` (mesmo padrão client-side já
 *       usado pra Beehiiv desde o #6043, porque o Kit também não documenta
 *       um jeito confiável de pedir só "os mais novos" nesta lista).
 *   (b) Troca de backend NUNCA reenvia retroativo — um cursor calculado sob
 *       Beehiiv (`last_detection_backend: "beehiiv"`) nunca é reusado
 *       diretamente contra o Kit; a 1ª rodada pós-troca re-bootstrapa
 *       (cursor em now, zero entradas), a mesma disciplina que evitou
 *       repetir o #6043 na migração de fonte.
 *   (c) Alarme de detecção zerada — N rodadas `--send` seguidas com
 *       `detected_new: 0` emitem uma nota de alarme no resumo (item 4 da
 *       issue: o guard que faltava pro caso "saiu verde, detectou zero,
 *       silenciosamente").
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

interface MockKitSubscriber {
  id: number;
  email_address: string;
  state: string;
  created_at: string;
}

/**
 * Mock mínimo do Kit — `GET /subscribers` (listagem paginada, envelope
 * `{subscribers, pagination}`) e falha alto (404) em qualquer outra rota,
 * pra garantir que o script NUNCA bate na Beehiiv nem em rota inesperada.
 */
function startMockKit(subscribers: MockKitSubscriber[]): Promise<{
  server: Server;
  url: string;
  lastQuery: () => string;
  hitPaths: () => string[];
}> {
  let lastQuery = "";
  const hitPaths: string[] = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      hitPaths.push(parsed.pathname);
      res.setHeader("content-type", "application/json");
      if (parsed.pathname === "/subscribers") {
        lastQuery = parsed.search;
        res.writeHead(200);
        res.end(
          JSON.stringify({
            subscribers,
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          }),
        );
        return;
      }
      // Individual GET /subscribers/{id} (refresh) — nenhum caso deste
      // arquivo tem candidato due pra refresh, respondido de forma
      // inofensiva caso aconteça.
      res.writeHead(404);
      res.end(JSON.stringify({ error: `unexpected path ${parsed.pathname}` }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, lastQuery: () => lastQuery, hitPaths: () => hitPaths });
    });
  });
}

function baseEnv(kitUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIT_API_URL: kitUrl,
    KIT_API_KEY: "test-kit-key-7599",
    // Credenciais Beehiiv de propósito AUSENTES/inválidas — provam que o
    // caminho Kit nunca cai de volta pra Beehiiv por engano.
    BEEHIIV_API_KEY: "",
    BEEHIIV_PUBLICATION_ID: "",
    BREVO_DIARIA_API_KEY: "test-brevo-key-7599",
  };
}

describe("onboarding-welcome-run.ts — detecção via Kit (#7599)", () => {
  it("(a) lê do Kit (status=all), nunca da Beehiiv, e filtra client-side por created_at >= cursor", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const CURSOR = nowSec - 3600;
    const subscribers: MockKitSubscriber[] = [
      { id: 101, email_address: "novo@example.com", state: "active", created_at: new Date((nowSec - 100) * 1000).toISOString() },
      { id: 102, email_address: "antigo@example.com", state: "active", created_at: new Date((CURSOR - 999_999) * 1000).toISOString() },
    ];
    const { server, url, lastQuery, hitPaths } = await startMockKit(subscribers);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-onboarding-7599-kit-"));
    try {
      const configPath = resolve(dir, "platform.config.json");
      const storePath = resolve(dir, "store.json");
      const snippetsDir = resolve(dir, "snippets"); // vazio — dry-run não precisa de conteúdo definitivo
      writeFileSync(
        configPath,
        JSON.stringify({
          onboarding: { enabled: true, snippets_dir: snippetsDir, store_path: storePath },
          publishing: { newsletter: { subscriber_backend: "kit" } },
        }),
      );
      writeFileSync(
        storePath,
        JSON.stringify({ version: 1, last_detection_cursor: CURSOR, last_detection_backend: "kit", d10_brevo_list_id: null, entries: {} }),
      );

      const r = await spawnScriptAsync(["--config", configPath, "--store", storePath], baseEnv(url));

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);
      const summary = JSON.parse(r.stdout) as { mode: string; detected_new: number };
      assert.equal(summary.mode, "dry-run");
      assert.equal(summary.detected_new, 1, `esperado 1 novo (o antigo fica de fora) — obteve ${summary.detected_new}. stdout: ${r.stdout}`);

      assert.match(lastQuery(), /status=all/, `esperado status=all na query do Kit — obteve: ${lastQuery()}`);
      assert.ok(
        hitPaths().every((p) => p.startsWith("/subscribers")),
        `nenhuma chamada deveria sair do domínio /subscribers do mock Kit — obteve: ${JSON.stringify(hitPaths())}`,
      );
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b) troca de backend (Beehiiv → Kit) re-bootstrapa o cursor — NUNCA reenvia retroativo", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Subscriber "antigo" do Kit, criado bem antes do cursor Beehiiv legado
    // — se o cursor fosse reusado ingenuamente ele ainda apareceria como
    // "novo" dependendo da comparação; o guard deve simplesmente NUNCA
    // avaliar isso, porque a troca de backend interrompe a rodada antes da
    // detecção rodar.
    const subscribers: MockKitSubscriber[] = [
      { id: 201, email_address: "cadastro-antigo@example.com", state: "active", created_at: new Date((nowSec - 10_000_000) * 1000).toISOString() },
    ];
    const { server, url, hitPaths } = await startMockKit(subscribers);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-onboarding-7599-switch-"));
    try {
      const configPath = resolve(dir, "platform.config.json");
      const storePath = resolve(dir, "store.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          onboarding: { enabled: true, store_path: storePath, sender_email: "oi@example.com" },
          publishing: { newsletter: { subscriber_backend: "kit" } },
        }),
      );
      // Store legado: cursor calculado sob BEEHIIV (epoch de `created`
      // qualquer, arbitrário) — o backend atual é "kit".
      const beehiivEraCursor = nowSec - 999_999_999;
      writeFileSync(
        storePath,
        JSON.stringify({
          version: 1,
          last_detection_cursor: beehiivEraCursor,
          last_detection_backend: "beehiiv",
          d10_brevo_list_id: null,
          entries: {},
        }),
      );

      const r = await spawnScriptAsync(["--config", configPath, "--store", storePath, "--send"], baseEnv(url));

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);
      const summary = JSON.parse(r.stdout) as { detected_new: number; notes: string[] };
      assert.equal(summary.detected_new, 0, "re-bootstrap não deve detectar NADA nesta rodada (nunca reenvio retroativo)");
      assert.ok(
        summary.notes.some((n) => n.includes("troca de backend")),
        `esperada nota de re-bootstrap por troca de backend: ${JSON.stringify(summary.notes)}`,
      );
      assert.equal(
        hitPaths().length,
        0,
        `re-bootstrap por troca de backend não deveria sequer chamar o Kit — obteve: ${JSON.stringify(hitPaths())}`,
      );

      const written = JSON.parse(readFileSync(storePath, "utf8")) as {
        last_detection_cursor: number;
        last_detection_backend: string;
        entries: Record<string, unknown>;
      };
      assert.equal(written.last_detection_backend, "kit", "backend persistido deve virar kit");
      assert.ok(
        written.last_detection_cursor > beehiivEraCursor,
        "cursor deve ser remarcado em now (bem depois do cursor legado da Beehiiv)",
      );
      assert.deepEqual(written.entries, {}, "nenhuma entrada deve ser adicionada no re-bootstrap");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(c) N rodadas --send seguidas com detected_new=0 emitem alarme de detecção zerada", async () => {
    const { server, url } = await startMockKit([]); // nunca há assinante novo
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-onboarding-7599-alarm-"));
    try {
      const configPath = resolve(dir, "platform.config.json");
      const storePath = resolve(dir, "store.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          onboarding: { enabled: true, store_path: storePath, sender_email: "oi@example.com" },
          publishing: { newsletter: { subscriber_backend: "kit" } },
        }),
      );
      writeFileSync(
        storePath,
        JSON.stringify({
          version: 1,
          last_detection_cursor: Math.floor(Date.now() / 1000) - 3600,
          last_detection_backend: "kit",
          d10_brevo_list_id: null,
          entries: {},
        }),
      );

      let lastSummary: { detected_new: number; notes: string[] } | null = null;
      for (let i = 0; i < 3; i++) {
        const r = await spawnScriptAsync(["--config", configPath, "--store", storePath, "--send"], baseEnv(url));
        assert.equal(r.status, 0, `rodada ${i + 1}: esperado exit 0 — stderr: ${r.stderr}`);
        lastSummary = JSON.parse(r.stdout);
        assert.equal(lastSummary!.detected_new, 0);
      }

      assert.ok(
        lastSummary!.notes.some((n) => n.includes("ALARME") && n.includes("detecção")),
        `3ª rodada deveria conter o alarme de detecção zerada: ${JSON.stringify(lastSummary!.notes)}`,
      );

      const written = JSON.parse(readFileSync(storePath, "utf8")) as { consecutive_zero_detections: number };
      assert.equal(written.consecutive_zero_detections, 3, "streak persistido deveria refletir as 3 rodadas");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
