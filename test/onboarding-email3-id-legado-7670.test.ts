/**
 * test/onboarding-email3-id-legado-7670.test.ts (#7670)
 *
 * Regressão do bug que manteve o e-mail 3 do onboarding SEM NUNCA DISPARAR
 * pra ninguém até 08/09/2026 (585 `skipped_sem_dados`, 19 `pending`, zero
 * enviados — com 5 entradas já vencidas do D+10 e `email3_decided_at: null`).
 *
 * Mecanismo: `subscription_id` é a chave do store e a semântica dela muda
 * conforme o backend vigente quando a entrada nasceu — entradas antigas
 * guardam um id da Beehiiv (`sub_...`), as novas guardam o id numérico do
 * Kit. Com o backend em `kit` desde o #7599, o refresh fazia
 * `Number("sub_c32a8dc4-...")` → `NaN` e desistia na primeira linha. Sem
 * stats de abertura frescos, a elegibilidade do e-mail 3 nunca decide, e a
 * entrada fica `pending` para sempre.
 *
 * O agravante que torna isto P1 e não cosmético: pela decisão registrada na
 * #7599, o e-mail 3 passou a ser o PEDIDO DE APOIO — a única conversão de
 * receita do onboarding estava atrás desse degrau.
 *
 * Molde de `test/onboarding-kit-detection-7599.test.ts`: subprocesso real
 * contra mock HTTP local do Kit.
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

function spawnScript(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((res, rej) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], { env, timeout: 30_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("close", (status) => res({ status, stdout, stderr }));
  });
}

const KIT_ID = 4264399626;
const EMAIL = "legado@example.com";

/**
 * Mock do Kit. Registra quais rotas foram batidas, pra o teste provar que a
 * resolução aconteceu POR E-MAIL (`/subscribers?email_address=...`) e não por
 * um id numérico que não existe.
 */
function startMockKit(opts: { statsOpens: number }): Promise<{ server: Server; url: string; paths: () => string[] }> {
  const paths: string[] = [];
  return new Promise((res) => {
    const server = createServer((req, rsp) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      paths.push(parsed.pathname + parsed.search);
      rsp.setHeader("content-type", "application/json");

      // Lookup por e-mail — o caminho que o #7670 acrescenta.
      if (parsed.pathname === "/subscribers" && parsed.searchParams.get("email_address")) {
        rsp.writeHead(200);
        rsp.end(
          JSON.stringify({
            subscribers: [
              { id: KIT_ID, email_address: EMAIL, state: "active", created_at: "2026-08-25T12:00:00Z", fields: {} },
            ],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          }),
        );
        return;
      }
      // Listagem de detecção (sem e-mail): vazia, o teste não exercita detecção.
      if (parsed.pathname === "/subscribers") {
        rsp.writeHead(200);
        rsp.end(
          JSON.stringify({
            subscribers: [],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          }),
        );
        return;
      }
      if (parsed.pathname === `/subscribers/${KIT_ID}/stats`) {
        rsp.writeHead(200);
        rsp.end(JSON.stringify({ subscriber: { stats: { total_unique_opens: opts.statsOpens } } }));
        return;
      }
      rsp.writeHead(404);
      rsp.end(JSON.stringify({ error: `rota inesperada ${parsed.pathname}` }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `http://127.0.0.1:${port}`, paths: () => paths });
    });
  });
}

function env(kitUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIT_API_URL: kitUrl,
    KIT_API_KEY: "test-kit-key-7670",
    BEEHIIV_API_KEY: "",
    BEEHIIV_PUBLICATION_ID: "",
    BREVO_DIARIA_API_KEY: "test-brevo-key-7670",
  };
}

/** Entrada LEGADA: id da Beehiiv, vencida no D+10, e-mail 3 ainda pendente. */
function fixture(dir: string, over: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const configPath = resolve(dir, "platform.config.json");
  const storePath = resolve(dir, "store.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      onboarding: {
        enabled: true,
        snippets_dir: resolve(dir, "snippets"), // inexistente: corpo pendente ⇒ nenhum envio é planejado
        store_path: storePath,
        email3_days: 10,
        sender_email: "oi@example.com",
        sender_name: "teste",
      },
      publishing: { newsletter: { subscriber_backend: "kit" } },
    }),
  );
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      last_detection_cursor: nowSec - 60,
      last_detection_backend: "kit",
      d10_brevo_list_id: null,
      entries: {
        "sub_c32a8dc4-b64f-45e6-b4ec-54f4c7f50ea4": {
          subscription_id: "sub_c32a8dc4-b64f-45e6-b4ec-54f4c7f50ea4",
          email: EMAIL,
          status_detectado: "active",
          created_at: nowSec - 20 * 86_400, // D+20: vencido no e-mail 3 (D+10)
          detected_at: "2026-08-25T12:05:00.000Z",
          email1_sent_at: "2026-08-25T12:05:00.000Z",
          email1_brevo_id: null,
          email2_sent_at: "2026-08-28T12:05:01.000Z",
          email2_brevo_id: null,
          email3_state: "pending",
          email3_campaign_id: null,
          email3_decided_at: null,
          ...over,
        },
      },
    }),
  );
  return { configPath, storePath };
}

describe("onboarding: id legado da Beehiiv sob backend Kit (#7670)", () => {
  it("REGRESSÃO: entrada com sub_... resolve pelo E-MAIL em vez de desistir", async () => {
    const { server, url, paths } = await startMockKit({ statsOpens: 3 });
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-7670-"));
    try {
      const { configPath, storePath } = fixture(dir);

      const r = await spawnScript(["--config", configPath, "--store", storePath], env(url));

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(
        !/refresh falhou pra sub_c32a8dc4/.test(r.stderr),
        `o refresh não podia mais falhar — stderr: ${r.stderr}`,
      );
      assert.ok(
        paths().some((p) => p.includes("email_address=")),
        `esperado lookup por e-mail — rotas batidas: ${JSON.stringify(paths())}`,
      );
      assert.ok(
        paths().some((p) => p === `/subscribers/${KIT_ID}/stats`),
        `esperado buscar stats pelo id resolvido — rotas: ${JSON.stringify(paths())}`,
      );
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o id resolvido é gravado em kit_subscriber_id, sem mexer na chave nem em subscription_id", async () => {
    const { server, url } = await startMockKit({ statsOpens: 3 });
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-7670-"));
    try {
      const { configPath, storePath } = fixture(dir);

      const r = await spawnScript(["--config", configPath, "--store", storePath, "--send"], env(url));
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const store = JSON.parse(readFileSync(storePath, "utf8"));
      const chaves = Object.keys(store.entries);
      assert.deepEqual(chaves, ["sub_c32a8dc4-b64f-45e6-b4ec-54f4c7f50ea4"], "a chave do store NÃO pode ser rekeyada");
      const e = store.entries[chaves[0]];
      assert.equal(e.subscription_id, "sub_c32a8dc4-b64f-45e6-b4ec-54f4c7f50ea4", "subscription_id fica intocado");
      assert.equal(e.kit_subscriber_id, KIT_ID, "o id do Kit resolvido é cacheado à parte");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com kit_subscriber_id já cacheado, não repete o lookup por e-mail", async () => {
    const { server, url, paths } = await startMockKit({ statsOpens: 3 });
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-7670-"));
    try {
      const { configPath, storePath } = fixture(dir, { kit_subscriber_id: KIT_ID });

      const r = await spawnScript(["--config", configPath, "--store", storePath], env(url));
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(
        !paths().some((p) => p.includes("email_address=")),
        `id cacheado devia entrar pelo caminho numérico — rotas: ${JSON.stringify(paths())}`,
      );
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refresh que falha numa entrada VENCIDA no e-mail 3 vira aviso explícito no sumário", async () => {
    // Mock que NÃO acha o e-mail — simula o assinante tendo sumido do Kit.
    const paths: string[] = [];
    const server = createServer((req, rsp) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      paths.push(parsed.pathname + parsed.search);
      rsp.setHeader("content-type", "application/json");
      rsp.writeHead(200);
      rsp.end(
        JSON.stringify({
          subscribers: [],
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-7670-"));
    try {
      const { configPath, storePath } = fixture(dir);

      const r = await spawnScript(["--config", configPath, "--store", storePath], env(url));

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const summary = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      const aviso = (summary.notes as string[]).find((n) => n.includes("#7670"));
      assert.ok(
        aviso,
        `falha de refresh em entrada vencida no e-mail 3 precisa aparecer no sumário, não só num stderr solto — notes: ${JSON.stringify(summary.notes)}`,
      );
      assert.match(aviso, new RegExp(EMAIL), "o aviso nomeia quem ficou sem decisão");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
