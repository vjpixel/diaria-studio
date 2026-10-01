/**
 * test/onboarding-kit-transport-run-counters-7922.test.ts (#7922, §3 do
 * docs/onboarding-kit-cutover.md — alarme de continuidade do transporte Kit)
 *
 * Regressão #7922: o alarme do transporte Kit lê o que o executor grava em
 * `store.kit_transport.last_send_run`/`consecutive_failed_send_runs`. Os
 * contadores só valem se o EXECUTOR REAL os produzir certo — este arquivo
 * roda `onboarding-kit-transport-run.ts --send` em subprocesso contra um
 * mock HTTP do Kit (`KIT_API_URL`), sobre store/config/snippets temporários
 * (kill switch ligado SÓ no config temporário; nenhuma rede real):
 *   - lote criado e agendado → `lots_created`, streak 0, entry marcada;
 *   - criação de tag 422 → `lots_failed`, streak 1, `last_error` no lote;
 *   - rodada seguinte dentro da janela de stale (`blocked_concurrent` sobre o
 *     `pending` com erro) NÃO conta falha nova (sem dupla contagem);
 *   - broadcast de e-mail 1 devolvido sem agendamento (`draft`) → lote falho;
 *   - snippet ausente → `content_skipped`, rodada falha;
 *   - backend ≠ kit com o switch ligado → rodada registrada como ABORTADA;
 *   - Kit respondendo 401 a tudo (auth quebrada) → refresh conta como erro
 *     de transporte; "assinante não encontrado" (404 + busca vazia) não conta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "onboarding-kit-transport-run.ts");
const REAL_STORE_PATH = resolve(ROOT, "data/onboarding/store.json");

function fingerprintRealStore(): string | null {
  if (!existsSync(REAL_STORE_PATH)) return null;
  return `${statSync(REAL_STORE_PATH).size}:${createHash("sha256").update(readFileSync(REAL_STORE_PATH)).digest("hex")}`;
}

interface MockOpts {
  /** Status de `POST /tags` (default 201). */
  tagCreateStatus?: number;
  /** `status` devolvido por `POST /broadcasts` (default "scheduled"). */
  broadcastStatus?: string;
  /** Responde este status a QUALQUER rota (simula auth quebrada / Kit fora). */
  everything?: number;
  /** `GET /subscribers/{id}` devolve 404 e a busca por e-mail vem vazia. */
  subscriberMissing?: boolean;
}

function startMockKit(opts: MockOpts = {}): Promise<{ server: Server; url: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        const p = u.pathname;
        hits.push(`${req.method} ${p}`);
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (opts.everything) return send(opts.everything, { errors: ["mock"] });
        const pagination = { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 };
        let m: RegExpMatchArray | null;
        if (req.method === "GET" && (m = p.match(/^\/subscribers\/(\d+)\/stats$/))) {
          return send(200, { subscriber: { id: Number(m[1]), stats: { opened: 2 } } });
        }
        if (req.method === "GET" && (m = p.match(/^\/subscribers\/(\d+)$/))) {
          if (opts.subscriberMissing) return send(404, { errors: ["Not Found"] });
          return send(200, { subscriber: { id: Number(m[1]), email_address: "x@example.com", state: "active", created_at: "2026-09-01T00:00:00Z" } });
        }
        if (req.method === "GET" && p === "/subscribers") return send(200, { subscribers: [], pagination });
        if (req.method === "GET" && p === "/tags") return send(200, { tags: [], pagination });
        if (req.method === "POST" && p === "/tags") {
          const status = opts.tagCreateStatus ?? 201;
          if (status >= 400) return send(status, { errors: ["Name is invalid"] });
          return send(201, { tag: { id: 777, name: JSON.parse(raw || "{}").name, created_at: "2026-10-01T00:00:00Z" } });
        }
        if (req.method === "POST" && /^\/tags\/\d+\/subscribers\/\d+$/.test(p)) return send(201, { subscriber: {} });
        if (req.method === "POST" && p === "/broadcasts") {
          const body = JSON.parse(raw || "{}") as { send_at?: string | null };
          return send(201, {
            broadcast: { id: 4242, status: opts.broadcastStatus ?? "scheduled", send_at: body.send_at ?? null, public: false, subject: "s" },
          });
        }
        send(404, { error: `unexpected ${req.method} ${p}` });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, hits });
    });
  });
}

function runExecutor(args: string[], kitUrl: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, KIT_API_KEY: "fixture_fake_kit_key_do_not_use", KIT_API_URL: kitUrl },
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

const NOW_MS = Date.now();
const iso = (daysAgo: number) => new Date(NOW_MS - daysAgo * 86_400_000).toISOString();
const sec = (daysAgo: number) => Math.floor((NOW_MS - daysAgo * 86_400_000) / 1000);

/** Entrada nova, `active`, devida no e-mail 1 (transporte Kit ligado). */
function newEntry(id: string) {
  return {
    subscription_id: id,
    kit_subscriber_id: Number(id),
    email: `n${id}@example.com`,
    status_detectado: "active",
    created_at: sec(0.1),
    detected_at: iso(0.1),
    email1_sent_at: null,
    email1_brevo_id: null,
    email2_sent_at: null,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
  };
}

function setup(opts: { backend?: string; snippets?: number[]; entries?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-run-counters-"));
  const configPath = join(dir, "platform.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publishing: { newsletter: { subscriber_backend: opts.backend ?? "kit" } },
      onboarding: { kit_transport: { enabled: true } },
    }),
  );
  const storePath = join(dir, "store.json");
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      last_detection_cursor: sec(0),
      last_detection_backend: "kit",
      d10_brevo_list_id: null,
      entries: opts.entries ?? { "501": newEntry("501") },
      kit_transport: { lots: {} },
    }),
  );
  const snippetsDir = join(dir, "snippets");
  mkdirSync(snippetsDir, { recursive: true });
  for (const n of opts.snippets ?? [1, 2, 3]) {
    writeFileSync(join(snippetsDir, `onboarding-${n}.md`), `<!-- assunto: "assunto ${n}" preview_text: "preview ${n}" -->\nCorpo ${n}.\n`);
  }
  const args = ["--send", "--config", configPath, "--store", storePath, "--snippets-dir", snippetsDir];
  const readKt = () => JSON.parse(readFileSync(storePath, "utf8")).kit_transport;
  return { dir, storePath, args, readKt };
}

async function withMock<T>(opts: MockOpts, fn: (url: string, hits: string[]) => Promise<T>): Promise<T> {
  const { server, url, hits } = await startMockKit(opts);
  try {
    return await fn(url, hits);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("#7922 — contadores da rodada --send do executor Kit (alimentam o alarme de continuidade)", () => {
  const realBefore = fingerprintRealStore();

  it("lote criado e agendado → lots_created=1, streak 0, entry com email1_sent_at", async () => {
    const t = setup();
    try {
      await withMock({}, async (url) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const kt = t.readKt();
        assert.equal(kt.last_send_run.lots_created, 1);
        assert.equal(kt.last_send_run.lots_failed, 0);
        assert.equal(kt.consecutive_failed_send_runs, 0);
        const store = JSON.parse(readFileSync(t.storePath, "utf8"));
        assert.ok(store.entries["501"].email1_sent_at, "lote agendado marca o envio na entry");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("criação de tag 422 → lots_failed=1, streak 1; nova rodada na janela de stale NÃO conta falha nova", async () => {
    const t = setup();
    try {
      await withMock({ tagCreateStatus: 422 }, async (url) => {
        const r1 = await runExecutor(t.args, url);
        assert.equal(r1.status, 0, `stdout: ${r1.stdout} stderr: ${r1.stderr}`);
        const kt1 = t.readKt();
        assert.equal(kt1.last_send_run.lots_failed, 1);
        assert.equal(kt1.consecutive_failed_send_runs, 1);
        const lot = Object.values(kt1.lots as Record<string, { status: string; last_error: string | null }>)[0]!;
        assert.equal(lot.status, "pending");
        assert.match(lot.last_error ?? "", /422/);

        // 2ª rodada logo em seguida: o `pending` com erro está dentro dos 15
        // min de stale → blocked_concurrent. A falha já foi contada na 1ª.
        const r2 = await runExecutor(t.args, url);
        assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
        assert.match(r2.stdout, /blocked_concurrent/);
        const kt2 = t.readKt();
        assert.equal(kt2.last_send_run.lots_failed, 0, "sem dupla contagem da mesma falha");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("broadcast de e-mail 1 devolvido como rascunho (sem agendamento) → lote falho, entry NÃO marcada", async () => {
    const t = setup();
    try {
      await withMock({ broadcastStatus: "draft" }, async (url) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const kt = t.readKt();
        assert.equal(kt.last_send_run.lots_created, 0);
        assert.equal(kt.last_send_run.lots_failed, 1);
        assert.equal(kt.consecutive_failed_send_runs, 1);
        const lot = Object.values(kt.lots as Record<string, { status: string; broadcast_id: number; last_error: string }>)[0]!;
        assert.equal(lot.status, "created");
        assert.equal(lot.broadcast_id, 4242);
        assert.match(lot.last_error, /sem agendamento/);
        const store = JSON.parse(readFileSync(t.storePath, "utf8"));
        assert.equal(store.entries["501"].email1_sent_at, null);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("snippet do e-mail 1 ausente → content_skipped>0 e a rodada conta como falha", async () => {
    const t = setup({ snippets: [2, 3] });
    try {
      await withMock({}, async (url) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const kt = t.readKt();
        assert.ok(kt.last_send_run.content_skipped >= 1, JSON.stringify(kt.last_send_run));
        assert.equal(kt.last_send_run.lots_created, 0);
        assert.equal(kt.consecutive_failed_send_runs, 1);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("backend ≠ kit com o switch ligado → exit 2 e rodada registrada como ABORTADA", async () => {
    const t = setup({ backend: "beehiiv" });
    try {
      await withMock({}, async (url, hits) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const kt = t.readKt();
        assert.equal(kt.last_send_run.aborted, true);
        assert.match(kt.last_send_run.error, /backend/);
        assert.equal(kt.consecutive_failed_send_runs, 1);
        assert.equal(hits.length, 0, "abortou antes de qualquer chamada ao Kit");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("refresh: 401 (auth quebrada) conta como erro de transporte; 'não encontrado' não conta", async () => {
    // Entrada devida no e-mail 2 → precisa de refresh de status.
    const due2 = {
      ...newEntry("601"),
      created_at: sec(5),
      detected_at: iso(5),
      email1_sent_at: iso(5),
      email1_transport: "kit",
      email1_kit_lot_id: "email1-x-01",
    };
    const t401 = setup({ entries: { "601": due2 } });
    try {
      await withMock({ everything: 401 }, async (url) => {
        const r = await runExecutor(t401.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const run = t401.readKt().last_send_run;
        assert.equal(run.refresh_candidates, 1);
        assert.equal(run.refresh_failed, 1);
        assert.equal(t401.readKt().consecutive_failed_send_runs, 1, "todos os refreshes falharam por transporte");
      });
    } finally {
      rmSync(t401.dir, { recursive: true, force: true });
    }
    const t404 = setup({ entries: { "601": due2 } });
    try {
      await withMock({ subscriberMissing: true }, async (url) => {
        const r = await runExecutor(t404.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const run = t404.readKt().last_send_run;
        assert.equal(run.refresh_candidates, 1);
        assert.equal(run.refresh_failed, 0, "assinante que não existe mais no Kit não é apagão");
        assert.equal(t404.readKt().consecutive_failed_send_runs, 0);
      });
    } finally {
      rmSync(t404.dir, { recursive: true, force: true });
    }
  });

  it("store real de produção intocado", () => {
    assert.equal(fingerprintRealStore(), realBefore);
  });
});
