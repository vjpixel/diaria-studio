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
 *   - e-mail 1 cuja RELEITURA no Kit não ecoa `send_at` → broadcast apagado,
 *     lote cancelado, entrada volta ao plano (não fica presa); com o DELETE
 *     falhando → `schedule_failed`, e a rodada seguinte recria o lote;
 *   - releitura que falha (rede/API) → `lots_unverified`, lote `created`;
 *   - exceção no meio da rodada → registro `aborted` com contadores parciais;
 *   - switch DESLIGADO ou `--pilot` com aborto → nada registrado;
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
import { runAndRecordSendRun, confirmOrCleanUpScheduledLot, isKitAlreadySentError } from "../scripts/onboarding-kit-transport-run.ts";
import { recordKitSendRun, type OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";

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
  /** Releitura `GET /broadcasts/{id}` devolve `send_at: null` (não agendado). */
  rereadNoSendAt?: boolean;
  /** Status HTTP da releitura `GET /broadcasts/{id}` (default 200). */
  rereadHttpStatus?: number;
  /** Status HTTP do `DELETE /broadcasts/{id}` (default 204). */
  deleteHttpStatus?: number;
  /** Chamado ao receber `POST /tags` (antes de responder) — injeta efeitos. */
  onTagCreate?: () => void;
  /** Muda o comportamento a partir da N-ésima releitura (1-based). */
  rereadNoSendAtOnlyFirst?: boolean;
  /** `rereadNoSendAt` vale só pro 1º broadcast criado (id 4242), em TODAS as
   *  releituras dele — os criados depois agendam normal (#9367). */
  rereadNoSendAtFirstBroadcastOnly?: boolean;
  /** Status Kit devolvido na releitura (sobrepõe o default "scheduled"/"draft"). */
  rereadStatus?: string;
  /** Corpo do erro do `DELETE` quando `deleteHttpStatus` ≥ 400. */
  deleteErrorBody?: unknown;
}

function startMockKit(opts: MockOpts = {}): Promise<{ server: Server; url: string; hits: string[] }> {
  const hits: string[] = [];
  const broadcasts = new Map<number, { id: number; send_at: string | null }>();
  let nextId = 4242;
  let rereads = 0;
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
          opts.onTagCreate?.();
          const status = opts.tagCreateStatus ?? 201;
          if (status >= 400) return send(status, { errors: ["Name is invalid"] });
          return send(201, { tag: { id: 777, name: JSON.parse(raw || "{}").name, created_at: "2026-10-01T00:00:00Z" } });
        }
        if (req.method === "POST" && /^\/tags\/\d+\/subscribers\/\d+$/.test(p)) return send(201, { subscriber: {} });
        if (req.method === "POST" && p === "/broadcasts") {
          const body = JSON.parse(raw || "{}") as { send_at?: string | null };
          const id = nextId++;
          broadcasts.set(id, { id, send_at: body.send_at ?? null });
          return send(201, {
            broadcast: { id, status: opts.broadcastStatus ?? "scheduled", send_at: body.send_at ?? null, public: false, subject: "s" },
          });
        }
        if ((m = p.match(/^\/broadcasts\/(\d+)$/))) {
          const id = Number(m[1]);
          if (req.method === "GET") {
            rereads++;
            if (opts.rereadHttpStatus && opts.rereadHttpStatus >= 400) return send(opts.rereadHttpStatus, { errors: ["mock"] });
            const b = broadcasts.get(id);
            if (!b) return send(404, { errors: ["Not Found"] });
            const drop =
              opts.rereadNoSendAt &&
              (opts.rereadNoSendAtFirstBroadcastOnly ? id === 4242 : !opts.rereadNoSendAtOnlyFirst || rereads === 1);
            return send(200, {
              broadcast: { id, status: opts.rereadStatus ?? (drop ? "draft" : "scheduled"), send_at: drop ? null : b.send_at, public: false, subject: "s" },
            });
          }
          if (req.method === "DELETE") {
            if (opts.deleteHttpStatus && opts.deleteHttpStatus >= 400) return send(opts.deleteHttpStatus, opts.deleteErrorBody ?? { errors: ["mock"] });
            broadcasts.delete(id);
            res.writeHead(204);
            return res.end();
          }
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

function setup(opts: { backend?: string; snippets?: number[]; entries?: Record<string, unknown>; enabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-run-counters-"));
  const configPath = join(dir, "platform.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publishing: { newsletter: { subscriber_backend: opts.backend ?? "kit" } },
      onboarding: { kit_transport: { enabled: opts.enabled ?? true } },
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
  return { dir, storePath, configPath, snippetsDir, args, readKt };
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
        assert.equal(kt2.last_send_run.blocked_concurrent, 1);
        assert.equal(kt2.consecutive_failed_send_runs, 1, "rodada só com blocked_concurrent é NEUTRA (não zera)");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("releitura sem send_at → broadcast apagado, lote cancelado, entrada NÃO fica presa (rodada seguinte recria)", async () => {
    const t = setup();
    try {
      await withMock({ rereadNoSendAt: true, rereadNoSendAtOnlyFirst: true }, async (url, hits) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const kt = t.readKt();
        assert.equal(kt.last_send_run.lots_created, 0);
        assert.equal(kt.last_send_run.lots_failed, 1);
        assert.equal(kt.consecutive_failed_send_runs, 1);
        const lot = Object.values(kt.lots as Record<string, { status: string; last_error: string }>)[0]!;
        assert.equal(lot.status, "cancelled");
        assert.match(lot.last_error, /sem agendamento na releitura/);
        assert.ok(hits.some((h) => h.startsWith("DELETE /broadcasts/")), "broadcast não agendado é apagado");
        assert.equal(JSON.parse(readFileSync(t.storePath, "utf8")).entries["501"].email1_sent_at, null);

        // Rodada seguinte (agora o Kit agenda): a entrada volta ao plano.
        const r2 = await runExecutor(t.args, url);
        assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
        const kt2 = t.readKt();
        assert.equal(kt2.last_send_run.lots_created, 1, "recriado com identidade nova");
        assert.equal(kt2.consecutive_failed_send_runs, 0);
        assert.ok(JSON.parse(readFileSync(t.storePath, "utf8")).entries["501"].email1_sent_at);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("releitura sem send_at + DELETE falho → schedule_failed; não conta como confirmado e a rodada seguinte recria", async () => {
    const t = setup();
    try {
      // #9367: o 1º broadcast continua rascunho em TODAS as releituras (a
      // releitura do início da rodada seguinte também o vê não-agendado);
      // só o recriado agenda.
      await withMock({ rereadNoSendAt: true, rereadNoSendAtFirstBroadcastOnly: true, deleteHttpStatus: 401 }, async (url) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const kt = t.readKt();
        const lot = Object.values(kt.lots as Record<string, { status: string; schedule_failed?: boolean; last_error: string }>)[0]!;
        assert.equal(lot.status, "created");
        assert.equal(lot.schedule_failed, true);
        assert.match(lot.last_error, /DELETE falhou/);
        assert.equal(kt.last_send_run.lots_failed, 1);

        const r2 = await runExecutor(t.args, url);
        assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
        const kt2 = t.readKt();
        assert.equal(Object.keys(kt2.lots).length, 2, "lote novo criado (o falho não é reusado)");
        assert.equal(kt2.last_send_run.lots_created, 1);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("releitura que FALHA (401) → lots_unverified, lote created sem marcar a entry, rodada conta falha de transporte", async () => {
    const t = setup();
    try {
      await withMock({ rereadHttpStatus: 401 }, async (url, hits) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const kt = t.readKt();
        assert.equal(kt.last_send_run.lots_unverified, 1);
        assert.equal(kt.last_send_run.lots_failed, 0, "sem leitura não se declara falha de entrega");
        assert.equal(kt.consecutive_failed_send_runs, 1);
        const lot = Object.values(kt.lots as Record<string, { status: string }>)[0]!;
        assert.equal(lot.status, "created");
        assert.ok(!hits.some((h) => h.startsWith("DELETE")), "sem leitura, nunca apaga");
        assert.equal(JSON.parse(readFileSync(t.storePath, "utf8")).entries["501"].email1_sent_at, null);
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

  it("switch DESLIGADO + backend ≠ kit → exit 2 e NADA registrado", async () => {
    const t = setup({ backend: "beehiiv", enabled: false });
    try {
      await withMock({}, async (url) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(t.readKt().last_send_run, undefined);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("--pilot com aborto (backend ≠ kit) → exit 2 e NADA registrado no store do piloto", async () => {
    const t = setup({ backend: "beehiiv" });
    try {
      await withMock({}, async (url) => {
        const r = await runExecutor([...t.args, "--pilot", "--pilot-recipients", "editor@example.com"], url);
        assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(t.readKt().last_send_run, undefined);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("exceção no meio da rodada (store corrompido durante o --send) → exit != 0", async () => {
    const t = setup();
    try {
      await withMock({ tagCreateStatus: 422, onTagCreate: () => writeFileSync(t.storePath, "{ corrompido") }, async (url) => {
        const r = await runExecutor(t.args, url);
        assert.notEqual(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.match(r.stderr, /CORROMPIDO/);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("runAndRecordSendRun: exceção no meio grava `aborted` com os contadores PARCIAIS e propaga o erro", async () => {
    const t = setup();
    try {
      const counters = { lots_created: 1, lots_failed: 0, lots_unverified: 0, blocked_concurrent: 0, refresh_candidates: 2, refresh_failed: 0, content_skipped: 0 };
      await assert.rejects(
        runAndRecordSendRun(t.storePath, true, counters, async () => {
          counters.lots_failed++;
          throw new Error("claimLot explodiu com x@example.com");
        }),
        /claimLot explodiu/,
      );
      const run = t.readKt().last_send_run;
      assert.equal(run.aborted, true);
      assert.equal(run.lots_created, 1);
      assert.equal(run.lots_failed, 1);
      assert.match(run.error, /claimLot explodiu/);
      assert.doesNotMatch(run.error, /x@example\.com/, "motivo sem PII");
      assert.equal(t.readKt().consecutive_failed_send_runs, 1);
      // Sem --send: nada registrado.
      const t2 = setup();
      try {
        await assert.rejects(runAndRecordSendRun(t2.storePath, false, counters, async () => { throw new Error("x"); }));
        assert.equal(t2.readKt().last_send_run, undefined);
      } finally {
        rmSync(t2.dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  const mkLot = (): OnboardingKitLot => ({
    lot_id: "email1-x-01", kind: "email1", tag_name: "t", tag_id: 1, broadcast_id: 9, recipient_subscription_ids: ["1"],
    recipient_emails: ["a@example.com"], status: "created", created_at: new Date().toISOString(), send_at: null, last_reconciled_at: null, last_error: null,
  });

  it("confirmOrCleanUpScheduledLot: só status ∈ {scheduled, sending, completed} confirma; fora disso (inclusive fora do enum) nunca vira undefined", async () => {
    const ok = mkLot();
    assert.equal(await confirmOrCleanUpScheduledLot(ok, { getBroadcast: async () => ({ status: "scheduled", send_at: "2026-10-01T12:00:00Z" }), deleteBroadcast: async () => {} }), "scheduled");
    assert.equal(ok.status, "scheduled");
    // #9367 item 3: status fora do enum com send_at ecoado NÃO é agendado.
    const weird = mkLot();
    assert.equal(await confirmOrCleanUpScheduledLot(weird, { getBroadcast: async () => ({ status: "weird", send_at: "2026-10-01T12:00:00Z" }), deleteBroadcast: async () => {} }), "unscheduled");
    assert.equal(weird.status, "cancelled");
    const missing = mkLot();
    assert.equal(await confirmOrCleanUpScheduledLot(missing, { getBroadcast: async () => ({}), deleteBroadcast: async () => {} }), "unscheduled");
    assert.equal(missing.status, "cancelled");
  });

  it("#9367 item 3: releitura `aborted` com send_at ecoado → caminho unscheduled (apaga + cancela), nunca `scheduled`", async () => {
    const lot = mkLot();
    let deleted = 0;
    const out = await confirmOrCleanUpScheduledLot(lot, {
      getBroadcast: async () => ({ status: "aborted", send_at: "2026-10-01T12:00:00Z" }),
      deleteBroadcast: async () => {
        deleted++;
      },
    });
    assert.equal(out, "unscheduled");
    assert.equal(lot.status, "cancelled");
    assert.equal(deleted, 1);
  });

  it("#9367 item 2: releitura `sending`/`completed` SEM send_at ecoado → enviado (completed), nunca apaga", async () => {
    for (const status of ["sending", "completed"]) {
      const lot = { ...mkLot(), send_at: "2026-10-01T11:00:00Z" };
      let deleted = 0;
      const out = await confirmOrCleanUpScheduledLot(lot, {
        getBroadcast: async () => ({ status, send_at: null }),
        deleteBroadcast: async () => {
          deleted++;
        },
      });
      assert.equal(out, "scheduled", status);
      assert.equal(lot.status, "completed", status);
      assert.equal(deleted, 0, `${status}: broadcast que já saiu nunca é apagado`);
      assert.equal(lot.send_at, "2026-10-01T11:00:00Z", "send_at do POST preservado quando a releitura não ecoa");
    }
  });

  it("#9367 item 2: DELETE 422 'already been sent' → enviado (completed), não schedule_failed nem volta ao plano", async () => {
    const lot = mkLot();
    const out = await confirmOrCleanUpScheduledLot(lot, {
      getBroadcast: async () => ({ status: "draft", send_at: null }),
      deleteBroadcast: async () => {
        throw new KitApiError("/broadcasts/9", 422, JSON.stringify({ errors: ["Broadcast has already been sent."] }));
      },
    });
    assert.equal(out, "scheduled");
    assert.equal(lot.status, "completed");
    assert.equal(lot.schedule_failed, undefined);
    assert.match(lot.last_error ?? "", /already been sent/);
    // 422 com OUTRO motivo continua sendo DELETE falho.
    const other = mkLot();
    await confirmOrCleanUpScheduledLot(other, {
      getBroadcast: async () => ({ status: "draft", send_at: null }),
      deleteBroadcast: async () => {
        throw new KitApiError("/broadcasts/9", 422, "Name is invalid");
      },
    });
    assert.equal(other.status, "created");
    assert.equal(other.schedule_failed, true);
    assert.equal(isKitAlreadySentError(new Error("already been sent")), false, "só KitApiError 422 conta");
  });

  it("#9367 item 2 (executor): releitura atrasada vê o broadcast `completed` sem send_at → lote completed, entry marcada, sem DELETE", async () => {
    const t = setup();
    try {
      await withMock({ rereadNoSendAt: true, rereadStatus: "completed" }, async (url, hits) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const kt = t.readKt();
        assert.equal(kt.last_send_run.lots_created, 1);
        assert.equal(kt.last_send_run.lots_failed, 0);
        const lot = Object.values(kt.lots as Record<string, { status: string }>)[0]!;
        assert.equal(lot.status, "completed");
        assert.ok(!hits.some((h) => h.startsWith("DELETE")), "broadcast já enviado nunca é apagado");
        assert.ok(JSON.parse(readFileSync(t.storePath, "utf8")).entries["501"].email1_sent_at, "envio gravado — não volta ao plano");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("#9367 item 2 (executor): DELETE 422 'already been sent' → lote completed, rodada seguinte NÃO recria (e-mail 1 não sai em dobro)", async () => {
    const t = setup();
    try {
      await withMock(
        { rereadNoSendAt: true, deleteHttpStatus: 422, deleteErrorBody: { errors: ["Broadcast has already been sent."] } },
        async (url, hits) => {
          const r = await runExecutor(t.args, url);
          assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
          const kt = t.readKt();
          const lot = Object.values(kt.lots as Record<string, { status: string; schedule_failed?: boolean }>)[0]!;
          assert.equal(lot.status, "completed");
          assert.equal(lot.schedule_failed, undefined);
          assert.equal(kt.last_send_run.lots_created, 1);
          assert.equal(kt.last_send_run.lots_failed, 0);
          const r2 = await runExecutor(t.args, url);
          assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
          assert.equal(hits.filter((h) => h === "POST /broadcasts").length, 1, "nenhum 2º broadcast de e-mail 1");
        },
      );
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("#9367 item 1: lote `unverified` é relido no INÍCIO do --send seguinte — agendado no Kit → grava o envio, não recria, streak zera", async () => {
    const t = setup();
    try {
      const opts: MockOpts = { rereadHttpStatus: 401 };
      await withMock(opts, async (url, hits) => {
        const r1 = await runExecutor(t.args, url);
        assert.equal(r1.status, 0, `stdout: ${r1.stdout} stderr: ${r1.stderr}`);
        assert.equal(t.readKt().last_send_run.lots_unverified, 1);
        assert.equal(t.readKt().consecutive_failed_send_runs, 1);
        assert.equal(JSON.parse(readFileSync(t.storePath, "utf8")).entries["501"].email1_sent_at, null);

        // A rede volta: SEM nenhum --reconcile agendado, o próprio --send relê.
        opts.rereadHttpStatus = undefined;
        const r2 = await runExecutor(t.args, url);
        assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
        const summary = JSON.parse(r2.stdout);
        assert.equal(summary.reconciled_before_send?.[0]?.recovered, "scheduled", r2.stdout);
        const kt = t.readKt();
        const lot = Object.values(kt.lots as Record<string, { status: string }>)[0]!;
        assert.equal(lot.status, "scheduled");
        assert.equal(Object.keys(kt.lots).length, 1, "nenhum lote novo");
        assert.equal(hits.filter((h) => h === "POST /broadcasts").length, 1, "nenhum 2º broadcast");
        assert.ok(JSON.parse(readFileSync(t.storePath, "utf8")).entries["501"].email1_sent_at, "régua ancora: email1_sent_at gravado");
        assert.equal(kt.last_send_run.lots_unverified, 0);
        assert.equal(kt.consecutive_failed_send_runs, 0);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("#9367 item 1: lote `unverified` que CONTINUA ilegível no --send seguinte conta de novo (streak não zera em silêncio)", async () => {
    const t = setup();
    try {
      await withMock({ rereadHttpStatus: 401 }, async (url, hits) => {
        await runExecutor(t.args, url);
        const r2 = await runExecutor(t.args, url);
        assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
        const kt = t.readKt();
        assert.equal(kt.last_send_run.lots_unverified, 1, "o lote preso segue contando");
        assert.equal(kt.consecutive_failed_send_runs, 2, "a streak cresce em vez de zerar");
        assert.equal(hits.filter((h) => h === "POST /broadcasts").length, 1, "sem leitura, nunca recria");
        assert.ok(!hits.some((h) => h.startsWith("DELETE")), "sem leitura, nunca apaga");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("#9367 item 1: lote `unverified` que o Kit mostra RASCUNHO no --send seguinte → apagado + cancelado, entrada replanejada no mesmo --send", async () => {
    const t = setup();
    try {
      const opts: MockOpts = { rereadHttpStatus: 401 };
      await withMock(opts, async (url, hits) => {
        await runExecutor(t.args, url);
        opts.rereadHttpStatus = undefined;
        opts.rereadNoSendAt = true;
        opts.rereadNoSendAtFirstBroadcastOnly = true;
        const r2 = await runExecutor(t.args, url);
        assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
        assert.ok(hits.includes("DELETE /broadcasts/4242"), "rascunho órfão apagado");
        const kt = t.readKt();
        const lots = Object.values(kt.lots as Record<string, { status: string; broadcast_id: number }>);
        assert.equal(lots.find((l) => l.broadcast_id === 4242)?.status, "cancelled");
        assert.equal(lots.find((l) => l.broadcast_id !== 4242)?.status, "scheduled", "entrada volta ao plano e sai num lote novo");
        assert.equal(kt.last_send_run.lots_created, 1);
        assert.ok(JSON.parse(readFileSync(t.storePath, "utf8")).entries["501"].email1_sent_at);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("#9367 item 1: dry-run relê os lotes abertos SEM escrever (nem no Kit, nem no store)", async () => {
    const t = setup();
    try {
      const opts: MockOpts = { rereadHttpStatus: 401 };
      await withMock(opts, async (url, hits) => {
        await runExecutor(t.args, url);
        const before = readFileSync(t.storePath, "utf8");
        opts.rereadHttpStatus = undefined;
        opts.rereadNoSendAt = true;
        const dry = await runExecutor(t.args.filter((a) => a !== "--send"), url);
        assert.equal(dry.status, 0, `stdout: ${dry.stdout} stderr: ${dry.stderr}`);
        assert.equal(readFileSync(t.storePath, "utf8"), before, "dry-run não grava o store");
        assert.ok(!hits.some((h) => h.startsWith("DELETE")), "dry-run nunca apaga no Kit");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("#9367 item 4: blocked_concurrent num kind + lote criado em outro → streak ZERA (entrega provada)", () => {
    const kt = { consecutive_failed_send_runs: 3 };
    const base = { at: new Date().toISOString(), lots_failed: 0, lots_unverified: 0, refresh_candidates: 0, refresh_failed: 0, content_skipped: 0 };
    recordKitSendRun(kt, { ...base, lots_created: 1, blocked_concurrent: 1 });
    assert.equal(kt.consecutive_failed_send_runs, 0);
    const kt2 = { consecutive_failed_send_runs: 3 };
    recordKitSendRun(kt2, { ...base, lots_created: 0, blocked_concurrent: 1 });
    assert.equal(kt2.consecutive_failed_send_runs, 3, "só blocked_concurrent, nada entregue → neutra");
  });

  it("store real de produção intocado", () => {
    assert.equal(fingerprintRealStore(), realBefore);
  });
});
