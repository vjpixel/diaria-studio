/**
 * test/check-continuo-session-registration.test.ts (#7890)
 *
 * Integração ponta-a-ponta do CLI: lê sidecars de tick sintéticos +
 * registros de sessão sintéticos de diretórios temporários, confirma que o
 * veredito (`status`) reflete o caso central da issue — um tick que rodou
 * (tem sidecar) sem `session-registry.ts register --kind continuo`
 * correspondente vira `"alarm"`, nunca silêncio.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../scripts/check-continuo-session-registration.ts";

const NOW = "2026-09-10T06:00:00.000Z";

let dir: string;
let sidecarDir: string;
let sessionsDir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "continuo-session-check-"));
  sidecarDir = join(dir, "tick-sidecars");
  sessionsDir = join(dir, "sessions");
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSidecar(name: string, sessionId: string, firstAt: string, lastAt: string): void {
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    join(sidecarDir, `${name}.json`),
    JSON.stringify({ sessionId, firstAt, lastAt, toolCallCount: 3, toolCalls: [], capturedAt: NOW }),
    "utf8",
  );
}

function writeSession(
  name: string,
  kind: string,
  sessionId: string,
  startedAt: string,
  lastHeartbeat: string | null,
): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${name}.json`),
    JSON.stringify({ kind, sessionId, startedAt, lastHeartbeat }),
    "utf8",
  );
}

describe("check-continuo-session-registration CLI", () => {
  it("diretório de sidecars ausente → indeterminate (checkout fresco, #7814 nunca rodou ali)", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "continuo-session-check-fresh-"));
    try {
      const result = runCheck(join(freshDir, "no-sidecars"), join(freshDir, "sessions"), NOW);
      assert.equal(result.status, "indeterminate");
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("sidecars existem mas data/sessions/ ausente → indeterminate, nunca 'alarm' precipitado", () => {
    const soloSidecarDir = join(dir, "solo-sidecar");
    mkdirSync(soloSidecarDir, { recursive: true });
    writeFileSync(
      join(soloSidecarDir, "cron_x_20260909_100000.json"),
      JSON.stringify({
        sessionId: "cron_x_20260909_100000",
        firstAt: "2026-09-09T10:00:00.000Z",
        lastAt: "2026-09-09T10:25:00.000Z",
        toolCallCount: 1,
        toolCalls: [],
        capturedAt: NOW,
      }),
      "utf8",
    );
    const result = runCheck(soloSidecarDir, join(dir, "no-sessions-dir"), NOW);
    assert.equal(result.status, "indeterminate");
  });

  it("tick recente com sidecar e SEM sessão continuo correspondente → alarm (o achado do #7641)", () => {
    writeSidecar(
      "cron_x_20260909_140000",
      "cron_x_20260909_140000",
      "2026-09-09T14:00:00.000Z",
      "2026-09-09T14:25:00.000Z",
    );
    // Sessão de um tick BEM anterior — não deveria correlacionar (é o modo
    // de falha que fez `latest_continuo_session` escolher errado no #7641).
    writeSession(
      "continuo-machine-uuid-old",
      "continuo",
      "uuid-old",
      "2026-09-08T08:00:00.000Z",
      "2026-09-08T08:20:00.000Z",
    );
    const result = runCheck(sidecarDir, sessionsDir, NOW);
    assert.equal(result.status, "alarm");
    assert.ok(result.unregisteredTicks.some((t) => t.sessionId === "cron_x_20260909_140000"));
  });

  it("tick recente com sessão continuo registrada na janela → ok", () => {
    const okDir = mkdtempSync(join(tmpdir(), "continuo-session-check-ok-"));
    try {
      const okSidecarDir = join(okDir, "tick-sidecars");
      const okSessionsDir = join(okDir, "sessions");
      mkdirSync(okSidecarDir, { recursive: true });
      mkdirSync(okSessionsDir, { recursive: true });
      writeFileSync(
        join(okSidecarDir, "cron_x_20260909_150000.json"),
        JSON.stringify({
          sessionId: "cron_x_20260909_150000",
          firstAt: "2026-09-09T15:00:00.000Z",
          lastAt: "2026-09-09T15:25:00.000Z",
          toolCallCount: 2,
          toolCalls: [],
          capturedAt: NOW,
        }),
        "utf8",
      );
      writeFileSync(
        join(okSessionsDir, "continuo-machine-uuid-new.json"),
        JSON.stringify({
          kind: "continuo",
          sessionId: "uuid-new",
          startedAt: "2026-09-09T15:03:00.000Z",
          lastHeartbeat: "2026-09-09T15:20:00.000Z",
        }),
        "utf8",
      );
      const result = runCheck(okSidecarDir, okSessionsDir, NOW);
      assert.equal(result.status, "ok");
      assert.equal(result.unregisteredTicks.length, 0);
    } finally {
      rmSync(okDir, { recursive: true, force: true });
    }
  });

  it("sessão kind=continuo-review NÃO conta como registro do contínuo (achado #7890 — colisão de prefixo de nome de arquivo)", () => {
    const collDir = mkdtempSync(join(tmpdir(), "continuo-session-check-coll-"));
    try {
      const collSidecarDir = join(collDir, "tick-sidecars");
      const collSessionsDir = join(collDir, "sessions");
      mkdirSync(collSidecarDir, { recursive: true });
      mkdirSync(collSessionsDir, { recursive: true });
      writeFileSync(
        join(collSidecarDir, "cron_x_20260909_160000.json"),
        JSON.stringify({
          sessionId: "cron_x_20260909_160000",
          firstAt: "2026-09-09T16:00:00.000Z",
          lastAt: "2026-09-09T16:25:00.000Z",
          toolCallCount: 1,
          toolCalls: [],
          capturedAt: NOW,
        }),
        "utf8",
      );
      // Nome de arquivo começa com "continuo-" mas o kind real é
      // "continuo-review" (5º kind, continuo-pr-review.sh) — um filtro por
      // PREFIXO DE NOME casaria isto erroneamente; o filtro correto lê o
      // campo `kind` do JSON.
      writeFileSync(
        join(collSessionsDir, "continuo-review-machine-uuid-rev.json"),
        JSON.stringify({
          kind: "continuo-review",
          sessionId: "uuid-rev",
          startedAt: "2026-09-09T16:05:00.000Z",
          lastHeartbeat: "2026-09-09T16:20:00.000Z",
        }),
        "utf8",
      );
      const result = runCheck(collSidecarDir, collSessionsDir, NOW);
      assert.equal(result.status, "alarm");
    } finally {
      rmSync(collDir, { recursive: true, force: true });
    }
  });

  // ─── #8378 — sessão que registrou, deu heartbeat e ENCERROU LIMPO dentro
  // da janela do tick some de `data/sessions/` (`endSession` faz `rmSync`) —
  // sem o log de ciclo de vida (`data/session-lifecycle.jsonl`, #6624) como
  // 2ª fonte, o checker alarma sobre um tick que na verdade registrou
  // corretamente. Esta é a reprodução do modo de falha real por trás do
  // "17 de 17" da issue.
  describe("#8378 — sessão encerrada limpo é lida de data/session-lifecycle.jsonl", () => {
    function writeLifecycleEvent(
      lifecycleDir: string,
      event: { event: "ended" | "gc-removed-without-end"; kind: string; sessionId: string; startedAt: string; lastHeartbeat: string | null; ts: string },
    ): void {
      mkdirSync(lifecycleDir, { recursive: true });
      writeFileSync(join(lifecycleDir, "session-lifecycle.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    }

    it("tick cuja sessão continuo já terminou (arquivo removido) ainda conta como registrada via lifecycle log", () => {
      const root = mkdtempSync(join(tmpdir(), "continuo-session-check-8378-"));
      try {
        const rootSidecarDir = join(root, "tick-sidecars");
        const rootSessionsDir = join(root, "sessions"); // propositalmente SEM nenhum arquivo — sessão já terminou e foi removida
        mkdirSync(rootSidecarDir, { recursive: true });
        mkdirSync(rootSessionsDir, { recursive: true });
        writeFileSync(
          join(rootSidecarDir, "cron_x_20260917_161543.json"),
          JSON.stringify({
            sessionId: "cron_x_20260917_161543",
            firstAt: "2026-09-17T19:15:54.453Z",
            lastAt: "2026-09-17T19:22:03.387Z",
            toolCallCount: 5,
            toolCalls: [],
            capturedAt: "2026-09-17T20:30:00.000Z",
          }),
          "utf8",
        );
        // Sem lifecycle log ainda: deve alarmar (comportamento pré-fix preservado).
        const before = runCheck(rootSidecarDir, rootSessionsDir, "2026-09-17T20:30:00.000Z");
        assert.equal(before.status, "alarm");

        // Sessão registrou, deu heartbeat e encerrou LIMPO dentro da janela
        // do tick (com folga) — `endSession` apagou o arquivo real, mas
        // gravou o evento "ended" com startedAt/lastHeartbeat capturados
        // antes da remoção.
        writeLifecycleEvent(root, {
          event: "ended",
          kind: "continuo",
          sessionId: "uuid-real-8378",
          startedAt: "2026-09-17T19:16:10.000Z",
          lastHeartbeat: "2026-09-17T19:21:50.000Z",
          ts: "2026-09-17T19:22:05.000Z",
        });

        const after = runCheck(rootSidecarDir, rootSessionsDir, "2026-09-17T20:30:00.000Z");
        assert.equal(after.status, "ok", after.reason);
        assert.equal(after.unregisteredTicks.length, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("evento gc-removed-without-end também conta como registro (o register RODOU, só não chamou end)", () => {
      const root = mkdtempSync(join(tmpdir(), "continuo-session-check-8378-gc-"));
      try {
        const rootSidecarDir = join(root, "tick-sidecars");
        const rootSessionsDir = join(root, "sessions");
        mkdirSync(rootSidecarDir, { recursive: true });
        mkdirSync(rootSessionsDir, { recursive: true });
        writeFileSync(
          join(rootSidecarDir, "cron_x_20260918_010536.json"),
          JSON.stringify({
            sessionId: "cron_x_20260918_010536",
            firstAt: "2026-09-18T04:05:46.765Z",
            lastAt: "2026-09-18T04:21:57.847Z",
            toolCallCount: 4,
            toolCalls: [],
            capturedAt: "2026-09-18T05:00:00.000Z",
          }),
          "utf8",
        );
        writeLifecycleEvent(root, {
          event: "gc-removed-without-end",
          kind: "continuo",
          sessionId: "uuid-gc-8378",
          startedAt: "2026-09-18T04:06:00.000Z",
          lastHeartbeat: "2026-09-18T04:20:00.000Z",
          ts: "2026-09-18T06:00:00.000Z",
        });
        const result = runCheck(rootSidecarDir, rootSessionsDir, "2026-09-18T05:00:00.000Z");
        assert.equal(result.status, "ok", result.reason);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("evento de OUTRO kind (overnight/develop) no lifecycle log nunca conta pro correlacionador do contínuo", () => {
      const root = mkdtempSync(join(tmpdir(), "continuo-session-check-8378-otherkind-"));
      try {
        const rootSidecarDir = join(root, "tick-sidecars");
        const rootSessionsDir = join(root, "sessions");
        mkdirSync(rootSidecarDir, { recursive: true });
        mkdirSync(rootSessionsDir, { recursive: true });
        writeFileSync(
          join(rootSidecarDir, "cron_x_20260918_022237.json"),
          JSON.stringify({
            sessionId: "cron_x_20260918_022237",
            firstAt: "2026-09-18T05:22:44.162Z",
            lastAt: "2026-09-18T05:24:57.765Z",
            toolCallCount: 2,
            toolCalls: [],
            capturedAt: "2026-09-18T06:00:00.000Z",
          }),
          "utf8",
        );
        writeLifecycleEvent(root, {
          event: "ended",
          kind: "overnight",
          sessionId: "uuid-overnight-8378",
          startedAt: "2026-09-18T05:23:00.000Z",
          lastHeartbeat: "2026-09-18T05:24:30.000Z",
          ts: "2026-09-18T05:25:00.000Z",
        });
        const result = runCheck(rootSidecarDir, rootSessionsDir, "2026-09-18T06:00:00.000Z");
        assert.equal(result.status, "alarm");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("--lifecycle-log-path explícito sobrescreve o default derivado de sessions-dir", () => {
      const root = mkdtempSync(join(tmpdir(), "continuo-session-check-8378-explicit-"));
      try {
        const rootSidecarDir = join(root, "tick-sidecars");
        const rootSessionsDir = join(root, "sessions");
        const otherLifecycleDir = join(root, "elsewhere");
        mkdirSync(rootSidecarDir, { recursive: true });
        mkdirSync(rootSessionsDir, { recursive: true });
        mkdirSync(otherLifecycleDir, { recursive: true });
        writeFileSync(
          join(rootSidecarDir, "cron_x_20260918_032538.json"),
          JSON.stringify({
            sessionId: "cron_x_20260918_032538",
            firstAt: "2026-09-18T06:25:57.483Z",
            lastAt: "2026-09-18T06:44:10.920Z",
            toolCallCount: 3,
            toolCalls: [],
            capturedAt: "2026-09-18T07:00:00.000Z",
          }),
          "utf8",
        );
        writeFileSync(
          join(otherLifecycleDir, "custom-lifecycle.jsonl"),
          `${JSON.stringify({
            event: "ended",
            kind: "continuo",
            sessionId: "uuid-explicit-8378",
            startedAt: "2026-09-18T06:26:10.000Z",
            lastHeartbeat: "2026-09-18T06:43:00.000Z",
            ts: "2026-09-18T06:44:15.000Z",
          })}\n`,
          "utf8",
        );
        const result = runCheck(rootSidecarDir, rootSessionsDir, "2026-09-18T07:00:00.000Z", {
          lifecycleLogPath: join(otherLifecycleDir, "custom-lifecycle.jsonl"),
        });
        assert.equal(result.status, "ok", result.reason);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("sidecar corrompido (JSON inválido) é ignorado, não derruba a checagem inteira", () => {
    const corruptDir = mkdtempSync(join(tmpdir(), "continuo-session-check-corrupt-"));
    try {
      const corruptSidecarDir = join(corruptDir, "tick-sidecars");
      mkdirSync(corruptSidecarDir, { recursive: true });
      writeFileSync(join(corruptSidecarDir, "broken.json"), "{ not valid json", "utf8");
      const result = runCheck(corruptSidecarDir, join(corruptDir, "sessions-missing"), NOW);
      // sessions dir ainda ausente -> indeterminate; o ponto do teste é que
      // ler o sidecar corrompido não lança.
      assert.equal(result.status, "indeterminate");
      assert.ok(result.readErrors.some((e) => e.includes("broken.json")));
    } finally {
      rmSync(corruptDir, { recursive: true, force: true });
    }
  });
});
