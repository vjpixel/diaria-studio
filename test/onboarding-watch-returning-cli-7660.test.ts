/**
 * test/onboarding-watch-returning-cli-7660.test.ts (#7660)
 *
 * Trava a FIAÇÃO do watcher de recadastro — o que
 * `test/onboarding-returning-watch-7660.test.ts` (decisão pura) não alcança.
 *
 * A lição vem do review da #7674: o guard de "nada é escrito" não vive na
 * função pura, vive na ordem das operações do script. Aqui o que importa é
 * que a entrada semeada nasça com `email1_sent_at` PREENCHIDO — é isso, e
 * só isso, que faz a rodada das 09:05 não mandar o "bem-vindo".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "onboarding-watch-returning.ts");
const EMAIL = "voltou@example.com";
const KIT_ID = 987654;

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

/**
 * Mock do Kit que EXIGE a rota e a query certas — molde de
 * `test/onboarding-kit-detection-7599.test.ts`.
 *
 * A versão anterior respondia a qualquer path com o mesmo payload, o que
 * mascarava exatamente o que mais importa aqui: `getKitSubscriberByEmail`
 * consulta `?email_address={email}&status=all`, e o `status=all` é
 * LOAD-BEARING — sem ele a API só busca entre `active`, e o ramo
 * `nao-active` deste watcher (que depende de enxergar `inactive`,
 * `complained`, etc.) nunca dispararia. Um refactor que perdesse o
 * parâmetro passaria por todos os testes (achado do review da PR #7698).
 *
 * `byEmail` mapeia e-mail → assinante; qualquer rota inesperada devolve 404
 * e é registrada em `paths`, para o teste poder afirmar que o script não
 * bateu em lugar nenhum além do esperado.
 */
function startMockKit(
  byEmail: Record<string, { id: number; state: string; created_at?: string } | null>,
): Promise<{ server: Server; url: string; paths: () => string[]; queries: () => string[] }> {
  const paths: string[] = [];
  const queries: string[] = [];
  return new Promise((res) => {
    const server = createServer((req, rsp) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      paths.push(parsed.pathname);
      rsp.setHeader("content-type", "application/json");

      if (parsed.pathname !== "/subscribers") {
        rsp.writeHead(404);
        rsp.end(JSON.stringify({ error: `rota inesperada ${parsed.pathname}` }));
        return;
      }
      queries.push(parsed.search);
      const pedido = parsed.searchParams.get("email_address");
      const sub = pedido ? byEmail[pedido.toLowerCase()] : null;
      rsp.writeHead(200);
      rsp.end(
        JSON.stringify({
          subscribers: sub
            ? [
                {
                  id: sub.id,
                  email_address: pedido,
                  state: sub.state,
                  created_at: sub.created_at ?? "2026-09-10T08:30:00Z",
                  fields: {},
                },
              ]
            : [],
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      res({
        server,
        url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
        paths: () => paths,
        queries: () => queries,
      });
    });
  });
}

/** Atalho: só a pessoa do caso, com o estado pedido (ou ausente do Kit). */
function mockCom(state: string | null) {
  return startMockKit({ [EMAIL]: state ? { id: KIT_ID, state } : null });
}

function env(kitUrl: string): NodeJS.ProcessEnv {
  return { ...process.env, KIT_API_URL: kitUrl, KIT_API_KEY: "test-key-7660" };
}

function fixture(dir: string, storeEntries: Record<string, unknown> = {}) {
  const watchlistPath = resolve(dir, "wl.json");
  const storePath = resolve(dir, "store.json");
  writeFileSync(
    watchlistPath,
    JSON.stringify({
      version: 1,
      entries: [{ email: EMAIL, reason: "#7660", added_at: "2026-09-09T00:00:00.000Z", seeded_at: null, kit_id: null }],
    }),
  );
  writeFileSync(
    storePath,
    JSON.stringify({ version: 1, last_detection_cursor: 1_788_000_000, last_detection_backend: "kit", d10_brevo_list_id: null, entries: storeEntries }),
  );
  return { watchlistPath, storePath };
}

describe("watcher de recadastro — fiação (#7660)", () => {
  it("dry-run com a pessoa já recadastrada: anuncia SEMEAR e não escreve nada", async () => {
    const { server, url } = await mockCom("active");
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const { watchlistPath, storePath } = fixture(dir);
      const antesStore = readFileSync(storePath, "utf8");
      const antesWl = readFileSync(watchlistPath, "utf8");

      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir], env(url));

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /SEMEAR/);
      assert.match(r.stdout, new RegExp(EMAIL));
      assert.equal(readFileSync(storePath, "utf8"), antesStore, "dry-run não toca o store");
      assert.equal(readFileSync(watchlistPath, "utf8"), antesWl, "dry-run não toca a watchlist");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO: --send grava a entrada com email1_sent_at PREENCHIDO — é isso que impede o 'bem-vindo'", async () => {
    const { server, url } = await mockCom("active");
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const { watchlistPath, storePath } = fixture(dir);

      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir, "--send"], env(url));
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const store = JSON.parse(readFileSync(storePath, "utf8"));
      const e = store.entries[String(KIT_ID)];
      assert.ok(e, `entrada devia existir sob a chave ${KIT_ID} — entries: ${JSON.stringify(Object.keys(store.entries))}`);
      assert.equal(
        e.email1_sent_at,
        "2026-09-10T08:30:00Z",
        "sem isto a rodada das 09:05 manda 'Você está dentro' pra quem lê há meses",
      );
      assert.equal(e.seeded_by, "#7660", "a origem fica registrada pra auditoria");
      assert.equal(e.email3_state, "pending", "os e-mails 2 e 3 seguem a cadência normal");

      const wl = JSON.parse(readFileSync(watchlistPath, "utf8"));
      assert.ok(wl.entries[0].seeded_at, "sai da fila de observação");
      assert.equal(wl.entries[0].kit_id, KIT_ID);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ainda não recadastrado: continua na fila, nada escrito nem com --send", async () => {
    const { server, url } = await mockCom(null);
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const { watchlistPath, storePath } = fixture(dir);
      const antes = readFileSync(storePath, "utf8");

      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir, "--send"], env(url));

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /aguardando/);
      assert.equal(readFileSync(storePath, "utf8"), antes);
      assert.equal(JSON.parse(readFileSync(watchlistPath, "utf8")).entries[0].seeded_at, null, "segue observando");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rodada diária chegou antes (já está no store): sai da fila SEM sobrescrever", async () => {
    const { server, url } = await mockCom("active");
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const existente = {
        [String(KIT_ID)]: {
          subscription_id: String(KIT_ID),
          email: EMAIL,
          status_detectado: "active",
          created_at: 1_788_900_000,
          detected_at: "2026-09-10T09:05:00.000Z",
          email1_sent_at: "2026-09-10T09:05:01.000Z", // o "bem-vindo" JÁ saiu
          email1_brevo_id: "abc",
          email2_sent_at: null,
          email2_brevo_id: null,
          email3_state: "pending",
          email3_campaign_id: null,
          email3_decided_at: null,
        },
      };
      const { watchlistPath, storePath } = fixture(dir, existente);

      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir, "--send"], env(url));

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /resolvido/);
      const e = JSON.parse(readFileSync(storePath, "utf8")).entries[String(KIT_ID)];
      assert.equal(e.email1_brevo_id, "abc", "histórico existente intocado — semear por cima reenviaria tudo");
      assert.ok(JSON.parse(readFileSync(watchlistPath, "utf8")).entries[0].seeded_at, "para de observar: não há mais o que fazer");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a consulta ao Kit carrega email_address E status=all — sem status=all o ramo nao-active morre", async () => {
    const { server, url, paths, queries } = await mockCom("active");
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const { watchlistPath, storePath } = fixture(dir);
      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir], env(url));
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.deepEqual([...new Set(paths())], ["/subscribers"], "nenhuma rota inesperada");
      const q = queries().join(" ");
      assert.match(q, /email_address=/, "sem isto o watcher não está buscando por e-mail");
      assert.match(q, /status=all/, "sem isto a API só olha active e `nao-active` nunca dispara");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO: created_at malformado NÃO é semeado — NaN atravessaria os guards do pipeline", async () => {
    const { server, url } = await startMockKit({ [EMAIL]: { id: KIT_ID, state: "active", created_at: "nao-e-data" } });
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const { watchlistPath, storePath } = fixture(dir);
      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir, "--send"], env(url));

      assert.equal(r.status, 1, "data inválida precisa sair diferente de 0 — senão a task fica verde");
      assert.match(r.stdout, /created_at do Kit não parseia/);
      assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).entries, {}, "nada semeado com NaN");
      assert.equal(
        JSON.parse(readFileSync(watchlistPath, "utf8")).entries[0].seeded_at,
        null,
        "continua em observação: a data pode vir boa na próxima hora",
      );
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO: watchlist ILEGÍVEL aborta com exit 2 — nunca finge lista vazia", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const watchlistPath = resolve(dir, "wl.json");
      writeFileSync(watchlistPath, "{ isto nao e json valido");
      const r = await spawnScript(
        ["--watchlist", watchlistPath, "--store", resolve(dir, "store.json"), "--env-root", dir, "--send"],
        { ...process.env, KIT_API_KEY: "x", KIT_API_URL: "http://127.0.0.1:1" },
      );
      assert.equal(r.status, 2, "sair 0 aqui esconderia que a observação inteira se perdeu (#7599)");
      assert.match(r.stderr, /ILEGÍVEL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("duas pessoas: uma semeia, a outra ainda não voltou — nenhuma atrapalha a outra", async () => {
    const OUTRO = "aindanao@example.com";
    const { server, url } = await startMockKit({ [EMAIL]: { id: KIT_ID, state: "active" }, [OUTRO]: null });
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const watchlistPath = resolve(dir, "wl.json");
      const storePath = resolve(dir, "store.json");
      writeFileSync(
        watchlistPath,
        JSON.stringify({
          version: 1,
          entries: [
            { email: OUTRO, reason: "#7660", added_at: "2026-09-09T00:00:00.000Z", seeded_at: null, kit_id: null },
            { email: EMAIL, reason: "#7660", added_at: "2026-09-09T00:00:00.000Z", seeded_at: null, kit_id: null },
          ],
        }),
      );
      writeFileSync(
        storePath,
        JSON.stringify({ version: 1, last_detection_cursor: 1, last_detection_backend: "kit", d10_brevo_list_id: null, entries: {} }),
      );

      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir, "--send"], env(url));
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const entries = JSON.parse(readFileSync(storePath, "utf8")).entries;
      assert.deepEqual(Object.keys(entries), [String(KIT_ID)], "só quem voltou é semeado");
      const wl = JSON.parse(readFileSync(watchlistPath, "utf8"));
      const porEmail = Object.fromEntries(wl.entries.map((e: { email: string; seeded_at: string | null }) => [e.email, e.seeded_at]));
      assert.ok(porEmail[EMAIL], "quem voltou sai da fila");
      assert.equal(porEmail[OUTRO], null, "quem não voltou continua observado");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--add exige --reason (exit 2) e só grava com --send", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const watchlistPath = resolve(dir, "wl.json");
      const base = ["--watchlist", watchlistPath, "--env-root", dir];
      const e = { ...process.env, KIT_API_KEY: "x", KIT_API_URL: "http://127.0.0.1:1" };

      const semReason = await spawnScript([...base, "--add", "alguem@example.com", "--send"], e);
      assert.equal(semReason.status, 2, "sem --reason a entrada nasceria sem origem auditável");
      assert.ok(!existsSync(watchlistPath), "e nada é gravado");

      const dry = await spawnScript([...base, "--add", "alguem@example.com", "--reason", "#7660"], e);
      assert.equal(dry.status, 0);
      assert.match(dry.stdout, /dry-run/);
      assert.ok(!existsSync(watchlistPath), "dry-run não cria a watchlist");

      const send = await spawnScript([...base, "--add", "alguem@example.com", "--reason", "#7660", "--send"], e);
      assert.equal(send.status, 0);
      const wl = JSON.parse(readFileSync(watchlistPath, "utf8"));
      assert.equal(wl.entries.length, 1);
      assert.equal(wl.entries[0].email, "alguem@example.com");
      assert.equal(wl.entries[0].reason, "#7660");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO P0: store ILEGÍVEL aborta sem escrever — nunca apaga o histórico de todo mundo", async () => {
    // `readStore` devolve `emptyStore()` quando o JSON não parseia. Sem checar
    // `corrupted`, o watcher trataria o store como vazio, decidiria "semear"
    // (porque ninguém está lá), e o `writeStore` seguinte gravaria um objeto
    // com UMA entrada por cima do arquivo real — apagando todo mundo que
    // aguarda e-mail 2 ou 3. Cenário concreto no projeto: junction `data/` do
    // OneDrive caída no `helios` (#5956).
    const { server, url } = await mockCom("active");
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const { watchlistPath, storePath } = fixture(dir);
      writeFileSync(storePath, "{ store truncado no meio de uma escrita");
      const antes = readFileSync(storePath, "utf8");

      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir, "--send"], env(url));

      assert.equal(r.status, 2, "store ilegível precisa abortar, não seguir com store vazio");
      assert.match(r.stderr, /ILEGÍVEL/);
      assert.equal(readFileSync(storePath, "utf8"), antes, "o arquivo corrompido NÃO pode ser sobrescrito");
      assert.equal(
        JSON.parse(readFileSync(watchlistPath, "utf8")).entries[0].seeded_at,
        null,
        "a watchlist também não avança — a pessoa segue observada",
      );
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO: falha de consulta ao Kit sai com exit ≠ 0 — apagão não pode parecer 'ninguém voltou'", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const { watchlistPath, storePath } = fixture(dir);
      // Porta fechada: toda consulta falha.
      const r = await spawnScript(["--watchlist", watchlistPath, "--store", storePath, "--env-root", dir, "--send"], {
        ...process.env,
        KIT_API_KEY: "x",
        KIT_API_URL: "http://127.0.0.1:1",
      });

      assert.notEqual(r.status, 0, "exit 0 aqui é indistinguível de 'consultei e ninguém recadastrou'");
      assert.match(r.stderr, /ERRO consultando/);
      assert.equal(
        JSON.parse(readFileSync(watchlistPath, "utf8")).entries[0].seeded_at,
        null,
        "falha de rede não tira ninguém da observação",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watchlist ausente: sai limpo sem nem resolver credencial do Kit", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-watch-"));
    try {
      const r = await spawnScript(
        ["--watchlist", resolve(dir, "nao-existe.json"), "--store", resolve(dir, "store.json"), "--env-root", dir],
        { ...process.env, KIT_API_KEY: "", KIT_API_URL: "http://127.0.0.1:1" },
      );
      assert.equal(r.status, 0, `task horária com lista vazia precisa ser barata — stderr: ${r.stderr}`);
      assert.match(r.stdout, /ninguém em observação/);
      assert.ok(!existsSync(resolve(dir, "store.json")), "não cria store do nada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
