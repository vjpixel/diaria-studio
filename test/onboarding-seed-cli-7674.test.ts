/**
 * test/onboarding-seed-cli-7674.test.ts (#7674)
 *
 * Trava a FIAÇÃO do modo dirigido em `scripts/onboarding-welcome-run.ts` —
 * a camada que `test/onboarding-seed-7674.test.ts` não alcança.
 *
 * Por que dois arquivos: o outro testa `planSeed`, que é pura e decide QUEM
 * entra. Este testa o que acontece com essa decisão — parsing das flags,
 * exit code, e principalmente se algo é ESCRITO no disco. O guard real de
 * "nada é escrito quando o plano é recusado" não é `planSeed` devolvendo
 * `entries: []`; é o `process.exit(1)` estar posicionado ANTES do bloco de
 * escrita. Um refactor que invertesse essa ordem passaria intacto pelo teste
 * puro (achado do review da PR #7683, `pr-test-analyzer`).
 *
 * Mesmo molde de `test/onboarding-kit-detection-7599.test.ts`: subprocesso
 * real contra um mock HTTP local do Kit. O modo dirigido não toca a Brevo,
 * então um mock de `GET /subscribers` cobre a superfície inteira.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "onboarding-welcome-run.ts");

function spawnScript(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], { env, timeout: 30_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("close", (status) => res({ status, stdout, stderr }));
  });
}

interface MockSub {
  id: number;
  email_address: string;
  state: string;
  created_at: string;
}

function startMockKit(subscribers: MockSub[]): Promise<{ server: Server; url: string }> {
  return new Promise((res) => {
    const server = createServer((req, rsp) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      rsp.setHeader("content-type", "application/json");
      if (parsed.pathname === "/subscribers") {
        rsp.writeHead(200);
        rsp.end(
          JSON.stringify({
            subscribers,
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          }),
        );
        return;
      }
      rsp.writeHead(404);
      rsp.end(JSON.stringify({ error: `rota inesperada ${parsed.pathname}` }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function env(kitUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIT_API_URL: kitUrl,
    KIT_API_KEY: "test-kit-key-7674",
    BEEHIIV_API_KEY: "",
    BEEHIIV_PUBLICATION_ID: "",
    BREVO_DIARIA_API_KEY: "test-brevo-key-7674",
  };
}

/** Cenário base: 2 assinantes ativos no Kit, store vazio, cursor já marcado. */
function makeFixture(dir: string, opts: { entries?: Record<string, unknown>; backend?: string } = {}) {
  const configPath = resolve(dir, "platform.config.json");
  const storePath = resolve(dir, "store.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      onboarding: { enabled: true, snippets_dir: resolve(dir, "snippets"), store_path: storePath },
      publishing: { newsletter: { subscriber_backend: opts.backend ?? "kit" } },
    }),
  );
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      last_detection_cursor: Math.floor(Date.now() / 1000) - 3600,
      last_detection_backend: "kit",
      d10_brevo_list_id: null,
      entries: opts.entries ?? {},
    }),
  );
  return { configPath, storePath };
}

const SUBS: MockSub[] = [
  { id: 501, email_address: "um@example.com", state: "active", created_at: "2026-09-08T10:00:00Z" },
  { id: 502, email_address: "dois@example.com", state: "active", created_at: "2026-09-08T11:00:00Z" },
  { id: 503, email_address: "suprimido@example.com", state: "complained", created_at: "2026-09-08T12:00:00Z" },
];

describe("onboarding-welcome-run.ts — modo dirigido (#7674)", () => {
  it("dry-run: imprime a lista nominal e NÃO escreve no store", async () => {
    const { server, url } = await startMockKit(SUBS);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      const { configPath, storePath } = makeFixture(dir);
      const antes = readFileSync(storePath, "utf8");

      const r = await spawnScript(
        ["--config", configPath, "--store", storePath, "--emails", "um@example.com,dois@example.com", "--seeded-by", "#7665"],
        env(url),
      );

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /um@example\.com/, "dry-run precisa nomear cada endereço");
      assert.match(r.stdout, /dois@example\.com/);
      assert.match(r.stdout, /dry-run/);
      assert.equal(readFileSync(storePath, "utf8"), antes, "dry-run não pode tocar no store");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--send escreve as entradas com seeded_by, chave = id do Kit, e-mail 1 pendente", async () => {
    const { server, url } = await startMockKit(SUBS);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      const { configPath, storePath } = makeFixture(dir);

      const r = await spawnScript(
        ["--config", configPath, "--store", storePath, "--emails", "um@example.com", "--seeded-by", "#7665", "--send"],
        env(url),
      );

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      assert.deepEqual(Object.keys(store.entries), ["501"], "chave é o id NUMÉRICO do Kit");
      const e = store.entries["501"];
      assert.equal(e.email, "um@example.com");
      assert.equal(e.seeded_by, "#7665");
      assert.equal(e.email1_sent_at, null, "sem --seed-email1-sent-at o e-mail 1 fica pendente");
      assert.equal(e.email3_state, "pending");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--seed-email1-sent-at marca o e-mail 1 como já enviado, sem enviá-lo (#7675)", async () => {
    const { server, url } = await startMockKit(SUBS);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      const { configPath, storePath } = makeFixture(dir);

      const r = await spawnScript(
        [
          "--config", configPath, "--store", storePath,
          "--emails", "dois@example.com",
          "--seed-email1-sent-at", "2026-09-05T14:02:00Z",
          "--seeded-by", "#7675", "--send",
        ],
        env(url),
      );

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      assert.equal(store.entries["502"].email1_sent_at, "2026-09-05T14:02:00Z");
      assert.equal(store.entries["502"].email1_brevo_id, null, "marcar não é enviar — não há id de envio");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- o guard que só existe na fiação -------------------------------------

  it("REGRESSÃO: plano recusado com --send sai exit 1 e NÃO escreve nada", async () => {
    const { server, url } = await startMockKit(SUBS);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      // `um@example.com` já está no store; `dois@` seria válido. Tudo-ou-nada
      // exige que NENHUM dos dois seja escrito.
      const { configPath, storePath } = makeFixture(dir, {
        entries: {
          "501": {
            subscription_id: "501",
            email: "um@example.com",
            status_detectado: "active",
            created_at: 1_788_000_000,
            detected_at: "2026-09-01T00:00:00.000Z",
            email1_sent_at: "2026-09-01T12:00:00.000Z",
            email1_brevo_id: null,
            email2_sent_at: null,
            email2_brevo_id: null,
            email3_state: "pending",
            email3_campaign_id: null,
            email3_decided_at: null,
          },
        },
      });
      const antes = readFileSync(storePath, "utf8");

      const r = await spawnScript(
        ["--config", configPath, "--store", storePath, "--emails", "um@example.com,dois@example.com", "--seeded-by", "#7665", "--send"],
        env(url),
      );

      assert.equal(r.status, 1, `recusa precisa sair 1 — stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.match(r.stdout, /ABORTADO/);
      assert.match(r.stdout, /um@example\.com: ja_no_store/, "a recusa nomeia o endereço");
      assert.equal(
        readFileSync(storePath, "utf8"),
        antes,
        "NENHUMA entrada pode ser escrita quando o plano é recusado — nem a válida",
      );
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assinante complained é recusado pelo CLI, não semeado em silêncio", async () => {
    const { server, url } = await startMockKit(SUBS);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      const { configPath, storePath } = makeFixture(dir);
      const r = await spawnScript(
        ["--config", configPath, "--store", storePath, "--emails", "suprimido@example.com", "--seeded-by", "#7665", "--send"],
        env(url),
      );
      assert.equal(r.status, 1);
      assert.match(r.stdout, /estado_nao_active/);
      assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).entries, {});
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--emails-file: uma linha por e-mail, `#` comenta, mas não corta local-part com #", async () => {
    const subs: MockSub[] = [
      ...SUBS,
      { id: 504, email_address: "user#tag@example.com", state: "active", created_at: "2026-09-08T13:00:00Z" },
    ];
    const { server, url } = await startMockKit(subs);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      const { configPath, storePath } = makeFixture(dir);
      const listPath = resolve(dir, "lista.txt");
      writeFileSync(
        listPath,
        ["# coorte #7665 — órfãos", "um@example.com  # o primeiro", "", "user#tag@example.com", ""].join("\n"),
      );

      const r = await spawnScript(
        ["--config", configPath, "--store", storePath, "--emails-file", listPath, "--seeded-by", "#7665", "--send"],
        env(url),
      );

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const entries = JSON.parse(readFileSync(storePath, "utf8")).entries;
      assert.deepEqual(Object.keys(entries).sort(), ["501", "504"]);
      assert.equal(entries["504"].email, "user#tag@example.com", "`#` no local-part não pode ser tratado como comentário");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--emails-file inexistente sai exit 2, sem tocar no store", async () => {
    const { server, url } = await startMockKit(SUBS);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      const { configPath, storePath } = makeFixture(dir);
      const antes = readFileSync(storePath, "utf8");
      const r = await spawnScript(
        ["--config", configPath, "--store", storePath, "--emails-file", resolve(dir, "nao-existe.txt"), "--seeded-by", "#7665", "--send"],
        env(url),
      );
      assert.equal(r.status, 2);
      assert.equal(readFileSync(storePath, "utf8"), antes);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend != kit é recusado — a resolução por e-mail é da API do Kit", async () => {
    const { server, url } = await startMockKit(SUBS);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      const { configPath, storePath } = makeFixture(dir, { backend: "beehiiv" });
      const r = await spawnScript(
        ["--config", configPath, "--store", storePath, "--emails", "um@example.com", "--seeded-by", "#7665", "--send"],
        env(url),
      );
      assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.match(r.stderr, /modo dirigido exige backend/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("semear NÃO envia: o store fica com a entrada, mas nenhum e-mail sai na mesma invocação", async () => {
    const { server, url } = await startMockKit(SUBS);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-seed-cli-"));
    try {
      const { configPath, storePath } = makeFixture(dir);
      const r = await spawnScript(
        ["--config", configPath, "--store", storePath, "--emails", "um@example.com", "--seeded-by", "#7665", "--send"],
        env(url),
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const summary = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      assert.deepEqual(summary.actions, [], "nenhuma ação de envio na rodada de semeadura");
      assert.equal(summary.detected_new, 0, "modo dirigido não faz detecção");
      // O mock só serve /subscribers; se o script tentasse enviar, bateria na
      // Brevo real com uma key de teste — o exit 0 já prova que não tentou.
      assert.ok(existsSync(storePath));
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
