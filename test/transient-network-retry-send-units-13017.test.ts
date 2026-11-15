/**
 * test/transient-network-retry-send-units-13017.test.ts (#13017)
 *
 * Decisão do editor (15/11/2026): unit que ENVIA a terceiros só ganha o retry
 * de rede (`retryOnTransientNetwork`) se a rerrodada depois de uma queda no
 * meio não reenviar nem duplicar. `Diaria-Clarice-Novos`/`-Tarde` entraram;
 * este arquivo trava o contrato que sustenta essa entrada:
 *
 *   1. Queda de rede ANTES do POST `sendNow` sai 1 com assinatura de rede, o
 *      runner converte em 105 (a unit reagenda) e o `--send-now` não roda.
 *   2. Queda no POST `sendNow` (resposta perdida, possível aceite, #9699) sai
 *      3, que é `successExitCodes` da task: nunca 105, nunca reagenda.
 *   3. A rerrodada não reseleciona quem a rodada caída já tinha pegado: o
 *      `sent-or-queued.json` é gravado na SELEÇÃO, e o orquestrador para sem
 *      importar/criar/enviar quando a seleção volta vazia.
 *
 * Se uma mudança em `clarice-novos-run.ts` quebrar qualquer um dos três, a
 * flag no registro deixa de ser segura e este teste falha.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runNovos,
  NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE,
  type ExecFn,
  type NovosRunDeps,
  type StepResult,
} from "../scripts/clarice-novos-run.ts";
import {
  appendSentOrQueuedEmails,
  excludeSentOrQueued,
  loadSentOrQueuedEmails,
} from "../scripts/clarice-build-segment.ts";
import { resolveTransientNetworkExitCode, TRANSIENT_NETWORK_EXIT_CODE } from "../scripts/lib/transient-network-failure.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const SEND_UNITS = ["Diaria-Clarice-Novos", "Diaria-Clarice-Novos-Tarde"] as const;

// Saída real do undici numa queda de DNS (mesmo formato do achado de 13/11).
const UNDICI_EAI_AGAIN =
  "TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13\n" +
  "  [cause]: Error: getaddrinfo EAI_AGAIN api.brevo.com\n      errno: -3001,\n      code: 'EAI_AGAIN',";

function json(obj: unknown, code = 0): StepResult {
  return { code, stdout: JSON.stringify(obj), stderr: "" };
}

/** exec fake: por script, uma resposta ou uma fila de respostas (uma por chamada). */
function fakeExec(handlers: Record<string, StepResult | StepResult[]>): { exec: ExecFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  const seen: Record<string, number> = {};
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const i = seen[script] ?? 0;
    seen[script] = i + 1;
    const h = handlers[script];
    if (h === undefined) throw new Error(`script inesperado: ${script} ${args.join(" ")}`);
    const r = Array.isArray(h) ? h[i] : h;
    if (!r) throw new Error(`fila esgotada para ${script} na chamada #${i}`);
    return r;
  };
  return { exec, calls };
}

function preSendHandlers(selected: number): Record<string, StepResult | StepResult[]> {
  return {
    "scripts/clarice-check-derived-stale.ts": { code: 0, stdout: "fresh", stderr: "" },
    "scripts/clarice-build-db.ts": { code: 0, stdout: "", stderr: "" },
    "scripts/clarice-stripe-delta.ts": json({ mode: "execute", since: "2026-11-13", rows: 5 }),
    "scripts/verify-emails-mv.ts": json({ mode: "since", total_verified: 5 }),
    "scripts/clarice-build-segment.ts": json({ selected, cycle: "2611-12", group: "novos" }),
    "scripts/clarice-novos-resolve-key.ts": json({ key: "novos-261114-2" }),
    "scripts/clarice-resolve-folder.ts": json({ folderId: 7, resolved: true }),
    "scripts/clarice-import-waves.ts": json({ mode: "execute", results: [{ listId: 99, wave: "novos" }] }),
    "scripts/clarice-novos-resolve-cycle.ts": json({ cycle: "2611-12", subject: "Assunto", fallback: false, checked: [] }),
    "scripts/clarice-novos-html-state.ts": json({ htmlSha256: "abc", shouldSendTest: true, previousState: null }),
  };
}

function deps(rootDir: string, exec: ExecFn): NovosRunDeps {
  return {
    rootDir,
    now: () => new Date("2026-11-14T12:00:00.000Z"), // 09:00 BRT
    exec,
    isEnabled: () => true,
    resolveEnvioCycle: () => "2611-12",
    execMode: () => "local",
  };
}

const ENV_KEYS = ["STRIPE_API_KEY", "BREVO_CLARICE_API_KEY", "MILLION_VERIFIER_API_KEY"] as const;

describe("Clarice-Novos com retry de rede: a rerrodada não reenvia (#13017)", () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;

  before(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      process.env[k] = "test-key";
    }
    root = mkdtempSync(join(tmpdir(), "novos-retry-13017-"));
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("as duas units estão com a flag e com o exit do disparo incerto em successExitCodes", () => {
    for (const name of SEND_UNITS) {
      const t = getScheduledTaskByName(name);
      assert.ok(t, `${name} existe no registro`);
      assert.equal(t.retryOnTransientNetwork, true, name);
      assert.ok((t.successExitCodes ?? []).includes(NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE), name);
    }
  });

  it("rede cai depois da campanha criada e antes do --send-now: sai 1, vira 105 no runner, --send-now não roda", async () => {
    const handlers = preSendHandlers(42);
    handlers["scripts/clarice-schedule-group.ts"] = [
      json({ key: "novos-261114-2", listId: 99, campaignId: 555, phase: "create", status: "draft" }),
      { code: 1, stdout: "", stderr: UNDICI_EAI_AGAIN }, // --send-test
    ];
    const { exec, calls } = fakeExec(handlers);
    const r = await runNovos([], deps(root, exec));
    assert.equal(r.code, 1);
    assert.ok(
      !calls.some((c) => c.script === "scripts/clarice-schedule-group.ts" && c.args.includes("--send-now")),
      "nenhum --send-now depois da queda",
    );
    // O runner classifica pela saída do processo, que leva o stderr do passo.
    const success = getScheduledTaskByName("Diaria-Clarice-Novos")?.successExitCodes ?? [];
    assert.equal(
      resolveTransientNetworkExitCode(r.code, [{ code: r.code, bestEffort: false, output: `${UNDICI_EAI_AGAIN}\n${r.reportMarkdown}` }], success),
      TRANSIENT_NETWORK_EXIT_CODE,
    );
  });

  it("rede cai no POST sendNow (possível aceite, #9699): código 3, que nunca reagenda", () => {
    for (const name of SEND_UNITS) {
      const success = getScheduledTaskByName(name)?.successExitCodes ?? [];
      const code = NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE;
      assert.equal(resolveTransientNetworkExitCode(code, [{ code, bestEffort: false, output: UNDICI_EAI_AGAIN }], success), code, name);
    }
  });

  it("a seleção da rodada caída fica gravada e a rerrodada exclui esses contatos", () => {
    const segmentsDir = join(root, "segments");
    const rodadaCaida = ["a@x.com", "B@x.com"];
    appendSentOrQueuedEmails(segmentsDir, "2611-12", "novos", rodadaCaida);
    const universo = [{ email: "a@x.com" }, { email: "b@x.com" }, { email: "novo@x.com" }];
    const restante = excludeSentOrQueued(universo, loadSentOrQueuedEmails(segmentsDir));
    assert.deepEqual(
      restante.map((r) => r.email),
      ["novo@x.com"],
    );
  });

  it("rerrodada com seleção vazia para antes de importar, criar campanha ou enviar", async () => {
    const { exec, calls } = fakeExec(preSendHandlers(0));
    const r = await runNovos([], deps(root, exec));
    assert.equal(r.code, 0);
    for (const script of ["scripts/clarice-import-waves.ts", "scripts/clarice-schedule-group.ts"]) {
      assert.ok(!calls.some((c) => c.script === script), `${script} não roda com seleção vazia`);
    }
  });
});
