/**
 * test/continuo-session-registration-check.test.ts (#7890)
 *
 * Regressão: `session-registry.ts register --kind continuo` é hoje um passo
 * em PROSA no SKILL.md do contínuo — se um tick falhar cedo (ex: falha de
 * credencial logo no início, o caso concreto do #7641), o registro nunca
 * acontece e nada de fora percebia, até esta checagem existir. O caso
 * central destes testes é exatamente esse: um sidecar de tick (#7814,
 * tick "encerrado" de fato rodou) SEM nenhuma sessão `kind=continuo`
 * cuja janela se sobreponha → `status: "alarm"`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CORRELATION_BUFFER_MINUTES,
  DEFAULT_LOOKBACK_HOURS,
  evaluateSessionRegistration,
  findUnregisteredTicks,
  isWithinLookback,
  windowsOverlap,
  type RegisteredSessionWindow,
  type TickWindow,
} from "../scripts/lib/continuo-session-registration-check.ts";

const NOW = "2026-09-10T06:00:00.000Z";

function tick(sessionId: string, firstAt: string, lastAt: string): TickWindow {
  return { sessionId, firstAt, lastAt };
}

function session(sessionId: string, startedAt: string, lastHeartbeat: string | null): RegisteredSessionWindow {
  return { sessionId, startedAt, lastHeartbeat };
}

describe("isWithinLookback", () => {
  it("dentro da janela → true", () => {
    assert.equal(isWithinLookback("2026-09-09T10:00:00.000Z", NOW, DEFAULT_LOOKBACK_HOURS), true);
  });
  it("fora da janela (velho demais) → false", () => {
    assert.equal(isWithinLookback("2026-09-01T00:00:00.000Z", NOW, DEFAULT_LOOKBACK_HOURS), false);
  });
  it("timestamp no futuro (clock skew) → false, nunca 'recente'", () => {
    assert.equal(isWithinLookback("2026-09-11T00:00:00.000Z", NOW, DEFAULT_LOOKBACK_HOURS), false);
  });
  it("timestamp ilegível → false, nunca finge relevância", () => {
    assert.equal(isWithinLookback("não-é-data", NOW, DEFAULT_LOOKBACK_HOURS), false);
    assert.equal(isWithinLookback("2026-09-09T10:00:00.000Z", "não-é-data", DEFAULT_LOOKBACK_HOURS), false);
  });
});

describe("windowsOverlap", () => {
  it("tick e sessão exatamente coincidentes → true", () => {
    const t = tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z");
    const s = session("uuid-1", "2026-09-09T10:00:30.000Z", "2026-09-09T10:24:00.000Z");
    assert.equal(windowsOverlap(t, s), true);
  });

  it("sessão registrada um pouco depois do início do tick, dentro da folga (#7890 caso normal) → true", () => {
    // Registro roda no passo 1.3 (depois do sync + guard de colisão) — não
    // é instantâneo ao início do tick. 10min de atraso, folga default 15min.
    const t = tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z");
    const s = session("uuid-1", "2026-09-09T10:10:00.000Z", "2026-09-09T10:24:00.000Z");
    assert.equal(windowsOverlap(t, s), true);
  });

  it("sessão de um tick completamente diferente (sem sobreposição, fora da folga) → false", () => {
    const t = tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z");
    const s = session("uuid-2", "2026-09-08T09:00:00.000Z", "2026-09-08T09:20:00.000Z");
    assert.equal(windowsOverlap(t, s), false);
  });

  it("sessão sem heartbeat (só startedAt) dentro da janela do tick → true", () => {
    const t = tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z");
    const s = session("uuid-3", "2026-09-09T10:05:00.000Z", null);
    assert.equal(windowsOverlap(t, s), true);
  });

  it("timestamp ilegível em qualquer lado → false (nunca afirma sobreposição sobre dado corrompido)", () => {
    const t = tick("cron_x_20260909_100000", "não-é-data", "2026-09-09T10:25:00.000Z");
    const s = session("uuid-4", "2026-09-09T10:05:00.000Z", "2026-09-09T10:10:00.000Z");
    assert.equal(windowsOverlap(t, s), false);
  });

  it("buffer customizado reduz a folga o suficiente pra deixar de casar", () => {
    const t = tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z");
    const s = session("uuid-5", "2026-09-09T10:40:00.000Z", "2026-09-09T10:50:00.000Z");
    // 15min de folga (default): tickEnd = 10:40 -> ainda toca sessStart 10:40 (limite igual conta).
    assert.equal(windowsOverlap(t, s, DEFAULT_CORRELATION_BUFFER_MINUTES), true);
    // 5min de folga: tickEnd = 10:30 -> não alcança 10:40.
    assert.equal(windowsOverlap(t, s, 5), false);
  });
});

describe("findUnregisteredTicks — o caso central do #7890/#7641", () => {
  it("tick sem NENHUMA sessão continuo na janela → aparece como não-registrado", () => {
    const ticks = [tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z")];
    // Só existe a sessão de um tick anterior, bem distante no tempo — o
    // bug reproduzido no #7641: `latest_continuo_session` pegaria esta
    // sessão por ser "a mais recente", mesmo não sendo deste tick.
    const sessions = [session("uuid-old", "2026-09-08T08:00:00.000Z", "2026-09-08T08:20:00.000Z")];
    const result = findUnregisteredTicks(ticks, sessions, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.sessionId, "cron_x_20260909_100000");
  });

  it("tick com sessão registrada na janela → não aparece", () => {
    const ticks = [tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z")];
    const sessions = [session("uuid-1", "2026-09-09T10:05:00.000Z", "2026-09-09T10:20:00.000Z")];
    assert.deepEqual(findUnregisteredTicks(ticks, sessions, NOW), []);
  });

  it("tick fora da janela de lookback nunca aparece, mesmo sem sessão nenhuma", () => {
    const ticks = [tick("cron_x_20260801_100000", "2026-08-01T10:00:00.000Z", "2026-08-01T10:25:00.000Z")];
    const result = findUnregisteredTicks(ticks, [], NOW);
    assert.deepEqual(result, []);
  });

  it("múltiplos ticks recentes: só o sem sessão aparece", () => {
    const ticks = [
      tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z"),
      // Separado por horas (não só minutos) do 1º tick — fora do alcance
      // da folga de correlação, então não pode casar por acidente com a
      // sessão do 1º tick.
      tick("cron_x_20260909_140000", "2026-09-09T14:00:00.000Z", "2026-09-09T14:25:00.000Z"),
    ];
    const sessions = [session("uuid-1", "2026-09-09T10:05:00.000Z", "2026-09-09T10:20:00.000Z")];
    const result = findUnregisteredTicks(ticks, sessions, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.sessionId, "cron_x_20260909_140000");
  });
});

describe("evaluateSessionRegistration", () => {
  it("sem sidecars recentes → ok, checkedTickCount 0 (nada a correlacionar)", () => {
    const result = evaluateSessionRegistration([], [], NOW);
    assert.equal(result.status, "ok");
    assert.equal(result.checkedTickCount, 0);
    assert.deepEqual(result.unregisteredTicks, []);
  });

  it("todos os ticks recentes registrados → ok", () => {
    const ticks = [tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z")];
    const sessions = [session("uuid-1", "2026-09-09T10:05:00.000Z", "2026-09-09T10:20:00.000Z")];
    const result = evaluateSessionRegistration(ticks, sessions, NOW);
    assert.equal(result.status, "ok");
    assert.equal(result.checkedTickCount, 1);
  });

  it("tick recente sem sessão → alarm, com o tick faltante listado", () => {
    const ticks = [tick("cron_x_20260909_100000", "2026-09-09T10:00:00.000Z", "2026-09-09T10:25:00.000Z")];
    const result = evaluateSessionRegistration(ticks, [], NOW);
    assert.equal(result.status, "alarm");
    assert.equal(result.unregisteredTicks.length, 1);
    assert.equal(result.unregisteredTicks[0]?.sessionId, "cron_x_20260909_100000");
    assert.match(result.reason, /sem sessão continuo registrada/);
  });
});
