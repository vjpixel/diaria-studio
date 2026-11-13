/**
 * test/publica-phase-upload-no-cross-host-expiry-12966.test.ts (#12966)
 *
 * Regressão de dois defeitos do #12883:
 *
 * 1. `upload/horizontal` de outra máquina virava `orphaned` depois de 3 h e
 *    liberava `registry:05-youtube-published`, com o upload ainda subindo
 *    (o upload do YouTube não tem timeout nem heartbeat). Agora o `upload`
 *    não expira pelo relógio.
 * 2. A regra 3 (retry exige releitura do registro) aceitava uma releitura
 *    feita ENQUANTO a tentativa órfã ainda rodava, porque o corte da órfã sem
 *    `end` era o `start`. Agora o corte é a expiração (outra máquina) ou o
 *    último evento (esta máquina).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CROSS_HOST_STALE_MS,
  NO_CROSS_HOST_EXPIRY_PHASES,
  buildPhaseEvent,
  checkPhaseStart,
  deriveTasks,
  retryCutoffMs,
  type PhaseEvent,
  type PhaseEventKind,
} from "../scripts/lib/diaria/publica-phases.ts";
import { currentHost } from "../scripts/lib/diaria/video-publish-authorization.ts";

const ED = "261114";
const T0 = new Date("2026-11-13T22:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const HOST = currentHost();
const OTHER = `${HOST}-outra-maquina`;
const STALE_MIN = CROSS_HOST_STALE_MS / 60_000;

function ev(phase: string, part: string, event: PhaseEventKind, min: number, over: Partial<Parameters<typeof buildPhaseEvent>[0]> = {}): PhaseEvent {
  return buildPhaseEvent({ edition: ED, phase, part, event, at: at(min), attempt: 1, sessionId: "S1", ...over });
}

function remoteRun(phase: string, part: string, min: number): PhaseEvent {
  return ev(phase, part, "start", min, { background: true, taskId: "pid-77", pid: 77, host: OTHER });
}

const opts = (min: number) => ({ isPidAlive: () => true, host: HOST, now: at(min).getTime() });

describe("#12966 upload de outra máquina não expira pelo relógio", () => {
  it("upload/horizontal segue running muito depois das 3 h e segura o registro", () => {
    assert.ok(NO_CROSS_HOST_EXPIRY_PHASES.has("upload"));
    const events = [remoteRun("upload", "horizontal", 0)];
    const t = deriveTasks(events, opts(10 * STALE_MIN))[0];
    assert.equal(t.status, "running");
    assert.equal(t.orphan_reason, undefined);

    // 2ª tentativa na máquina B: recusada por recurso ocupado, e a recusa não promete expiração.
    const retry = ev("upload", "horizontal", "start", 10 * STALE_MIN, { attempt: 2 });
    const problems = checkPhaseStart({ events, candidate: retry, deriveOptions: opts(10 * STALE_MIN) }).join("\n");
    assert.match(problems, /recurso ocupado: .*registry:05-youtube-published/);
    assert.match(problems, /não expira pelo relógio/);
    assert.doesNotMatch(problems, /expira sozinha em/);
  });

  it("controle: vertical-api de outra máquina continua expirando (comportamento do #12883)", () => {
    const t = deriveTasks([remoteRun("vertical-api", "vertical", 0)], opts(STALE_MIN + 1))[0];
    assert.equal(t.status, "orphaned");
    assert.equal(t.orphan_reason, "cross-host-stale");
  });
});

describe("#12966 regra 3: releitura precisa ser posterior à expiração, não ao start", () => {
  it("releitura feita enquanto a tentativa de outra máquina ainda rodava não cobre o retry", () => {
    const events = [remoteRun("vertical-api", "vertical", 0)];
    const retry = ev("vertical-api", "vertical", "start", STALE_MIN + 10, { attempt: 2 });
    // Releitura no minuto 30: a tentativa 1 ainda rodava (antes do bug, at >= start bastava).
    const early = [{ at: at(30).toISOString(), since: at(0).toISOString(), verdict: "nothing-since" }];
    const refused = checkPhaseStart({ events, candidate: retry, deriveOptions: opts(STALE_MIN + 10), registryChecks: early });
    assert.match(refused.join(), /releia o registro/);

    // Releitura depois da expiração: cobre.
    const late = [{ at: at(STALE_MIN + 5).toISOString(), since: at(0).toISOString(), verdict: "nothing-since" }];
    const ok = checkPhaseStart({ events, candidate: retry, deriveOptions: opts(STALE_MIN + 10), registryChecks: late });
    assert.deepEqual(ok, []);
  });

  it("órfã desta máquina (pid morto): o corte é o último evento (spawned), não o start", () => {
    const events = [
      ev("vertical-api", "vertical", "start", 0, { background: true, taskId: "pid-5", pid: 5, host: HOST }),
      ev("vertical-api", "vertical", "spawned", 20, { background: true, taskId: "pid-5", childPid: 6, host: HOST }),
    ];
    const dead = { isPidAlive: () => false, host: HOST, now: at(40).getTime() };
    const t = deriveTasks(events, dead)[0];
    assert.equal(t.orphan_reason, "pid-dead");
    assert.equal(retryCutoffMs(t, dead), at(20).getTime());

    const retry = ev("vertical-api", "vertical", "start", 40, { attempt: 2 });
    const early = [{ at: at(10).toISOString(), since: at(0).toISOString(), verdict: "nothing-since" }];
    assert.match(checkPhaseStart({ events, candidate: retry, deriveOptions: dead, registryChecks: early }).join(), /releia o registro/);
  });

  it("tentativa com fim gravado: o corte continua sendo o fim", () => {
    const t = { start: at(0).toISOString(), end: at(5).toISOString(), status: "error" as const, last_event_at: at(5).toISOString() };
    assert.equal(retryCutoffMs(t), at(5).getTime());
  });
});
