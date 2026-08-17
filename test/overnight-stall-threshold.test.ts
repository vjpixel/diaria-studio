/**
 * test/overnight-stall-threshold.test.ts (#5568, regressão #633)
 *
 * O limiar de stall do overnight era o literal `60` repetido em três
 * consumidores independentes — watchdog externo (#2688), fallback wake do
 * coordenador (#2896) e a prosa da SKILL. O bug que este arquivo previne é
 * o SILENCIOSO: encurtar o limiar num consumidor e esquecer o outro, deixando
 * as camadas de detecção discordarem entre si sem nenhum erro visível (o
 * watchdog acusando stall que o coordenador ainda trata como progresso
 * normal, ou o inverso). Nenhum teste travava essa coerência antes.
 *
 * Também trava o PISO: o limiar não pode descer até o timeout de espera de
 * CI da SKILL do overnight (30 min), senão toda espera de CI saudável — em
 * que o coordenador fica legitimamente sem escrever em plan.json/run-log —
 * vira halt banner + e-mail de alerta. Ver rationale completo em
 * `scripts/lib/overnight-stall-threshold.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { OVERNIGHT_STALL_THRESHOLD_MIN } from "../scripts/lib/overnight-stall-threshold.ts";
import { detectStall } from "../scripts/overnight-watchdog.ts";
import { shouldWakeCheck } from "../scripts/lib/overnight-fallback-wake.ts";

/** Timeout de espera de CI declarado na SKILL do overnight (minutos). */
const CI_WAIT_TIMEOUT_MIN = 30;

const REPO_ROOT = resolve(import.meta.dirname, "..");

describe("OVERNIGHT_STALL_THRESHOLD_MIN", () => {
  it("vale 45 min (decisão do editor 17/08/2026 — era 60)", () => {
    assert.equal(OVERNIGHT_STALL_THRESHOLD_MIN, 45);
  });

  it("fica estritamente acima do timeout de espera de CI (piso anti-falso-positivo)", () => {
    assert.ok(
      OVERNIGHT_STALL_THRESHOLD_MIN > CI_WAIT_TIMEOUT_MIN,
      `limiar (${OVERNIGHT_STALL_THRESHOLD_MIN} min) precisa ser > timeout de CI ` +
        `(${CI_WAIT_TIMEOUT_MIN} min), senão toda espera de CI saudável dispara alarme. ` +
        `Pra baixar mais, o timeout de CI da SKILL tem que cair junto.`,
    );
  });

  it("continua maior que a cadência do watchdog (10 min) e que o fallback wake (20 min)", () => {
    // Se o limiar descesse abaixo da cadência de quem olha, a detecção
    // deixaria de ser pontual — o alarme só sairia no ciclo seguinte.
    assert.ok(OVERNIGHT_STALL_THRESHOLD_MIN > 10);
    assert.ok(OVERNIGHT_STALL_THRESHOLD_MIN > 20);
  });
});

describe("coerência entre as camadas de detecção de stall", () => {
  it("detectStall (watchdog #2688) usa a constante como default", () => {
    const nowMs = Date.parse("2026-08-17T12:00:00Z");
    const justUnder = nowMs - (OVERNIGHT_STALL_THRESHOLD_MIN - 1) * 60_000;
    const exact = nowMs - OVERNIGHT_STALL_THRESHOLD_MIN * 60_000;

    assert.equal(detectStall(justUnder, nowMs), false);
    assert.equal(detectStall(exact, nowMs), true); // borda inclusiva
  });

  it("shouldWakeCheck (fallback wake #2896) usa a MESMA constante como default", () => {
    const dispatch = "2026-08-17T12:00:00Z";
    const dispatchMs = Date.parse(dispatch);
    const justUnder = new Date(
      dispatchMs + (OVERNIGHT_STALL_THRESHOLD_MIN - 1) * 60_000,
    ).toISOString();
    const exact = new Date(
      dispatchMs + OVERNIGHT_STALL_THRESHOLD_MIN * 60_000,
    ).toISOString();

    assert.equal(shouldWakeCheck(dispatch, justUnder), false);
    assert.equal(shouldWakeCheck(dispatch, exact), true);
  });

  it("as duas camadas concordam na MESMA borda (o bug que este arquivo previne)", () => {
    const nowMs = Date.parse("2026-08-17T12:00:00Z");
    for (const offsetMin of [1, 10, 29, 30, 44, 45, 46, 90]) {
      const dispatchMs = nowMs - offsetMin * 60_000;
      const watchdogSaysStall = detectStall(dispatchMs, nowMs);
      const coordinatorSaysStall = shouldWakeCheck(
        new Date(dispatchMs).toISOString(),
        new Date(nowMs).toISOString(),
      );
      assert.equal(
        watchdogSaysStall,
        coordinatorSaysStall,
        `divergência aos ${offsetMin} min: watchdog=${watchdogSaysStall}, ` +
          `coordenador=${coordinatorSaysStall} — os dois defaults saíram de sincronia.`,
      );
    }
  });
});

describe("prosa da SKILL/docs em sincronia com a constante", () => {
  /**
   * A camada (i) do stall passivo é executada pelo COORDENADOR lendo a
   * SKILL — não há código pra travar esse número, só o texto. Um limiar
   * mudado no código e esquecido na prosa faz o coordenador seguir usando o
   * valor antigo, que é exatamente a divergência silenciosa que motivou
   * este arquivo.
   */
  const files = [
    ".claude/skills/diaria-overnight/SKILL.md",
    "docs/overnight-watchdog-setup.md",
  ];

  for (const rel of files) {
    it(`${rel} não cita o limiar antigo de 60 min`, () => {
      const text = readFileSync(resolve(REPO_ROOT, rel), "utf-8");
      const stale = text.match(/>\s*60 min sem progresso|inatividade > 60 min|estourado 60 min/g);
      assert.equal(
        stale,
        null,
        `${rel} ainda cita 60 min como limiar de stall; a constante hoje é ` +
          `${OVERNIGHT_STALL_THRESHOLD_MIN} min.`,
      );
    });

    it(`${rel} cita o limiar atual (${OVERNIGHT_STALL_THRESHOLD_MIN} min)`, () => {
      const text = readFileSync(resolve(REPO_ROOT, rel), "utf-8");
      assert.ok(
        text.includes(`${OVERNIGHT_STALL_THRESHOLD_MIN} min`),
        `${rel} não menciona o limiar atual de ${OVERNIGHT_STALL_THRESHOLD_MIN} min.`,
      );
    });
  }
});
