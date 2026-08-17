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
 * CI (`CI_WAIT_TIMEOUT_MIN`), senão toda espera de CI saudável — em que o
 * coordenador fica legitimamente sem escrever em plan.json/run-log — vira
 * halt banner + e-mail de alerta. Ver rationale completo em
 * `scripts/lib/overnight-stall-threshold.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CI_WAIT_TIMEOUT_MIN,
  OVERNIGHT_STALL_THRESHOLD_MIN,
} from "../scripts/lib/overnight-stall-threshold.ts";
import { detectStall, parseArgs } from "../scripts/overnight-watchdog.ts";
import { shouldWakeCheck } from "../scripts/lib/overnight-fallback-wake.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OVERNIGHT_SKILL = ".claude/skills/diaria-overnight/SKILL.md";

const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf-8");

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

  /**
   * `CI_WAIT_TIMEOUT_MIN` é uma CÓPIA em código de um valor cuja fonte viva é
   * a prosa da SKILL — a regra de timeout de CI é executada pelo coordenador
   * lendo o texto, não por código. Sem este teste, mudar o timeout na SKILL
   * deixaria o piso comparando contra um número congelado e o guard acima
   * passaria verde contra a regra ERRADA: a mesma classe de divergência
   * silenciosa que esta issue existe pra eliminar, só que uma camada acima
   * (achado do review do #5568).
   */
  it("CI_WAIT_TIMEOUT_MIN bate com o timeout declarado na prosa da SKILL", () => {
    const skill = read(OVERNIGHT_SKILL);
    const m = skill.match(/Timeout por espera de CI = \*\*(\d+) min\*\*/);
    assert.ok(m, `não achei "Timeout por espera de CI = **N min**" em ${OVERNIGHT_SKILL}`);
    assert.equal(
      Number(m[1]),
      CI_WAIT_TIMEOUT_MIN,
      `a SKILL declara timeout de CI de ${m[1]} min, mas CI_WAIT_TIMEOUT_MIN é ` +
        `${CI_WAIT_TIMEOUT_MIN}. Atualize scripts/lib/overnight-stall-threshold.ts — ` +
        `e reveja se OVERNIGHT_STALL_THRESHOLD_MIN ainda fica acima do piso novo.`,
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

/**
 * `parseArgs` é o consumidor que MAIS importa e o que estava sem nenhuma
 * cobertura (achado do review do #5568, provado por mutação: reverter esta
 * função pro literal `"60"` passava a suíte inteira sem uma falha). É ela —
 * não o default de parâmetro de `detectStall` — que resolve o limiar usado
 * de fato quando o systemd timer roda o watchdog: `detectStall` é sempre
 * chamado com o valor explícito que sai daqui.
 */
describe("parseArgs: resolução do limiar (env, flag, default)", () => {
  /** Coletor de avisos, no lugar do stderr real. */
  const collect = (): { warns: string[]; warn: (m: string) => void } => {
    const warns: string[] = [];
    return { warns, warn: (m) => void warns.push(m) };
  };

  it("sem env e sem flag → OVERNIGHT_STALL_THRESHOLD_MIN, sem avisos", () => {
    const { warns, warn } = collect();
    const { thresholdMin, dryRun } = parseArgs([], {}, warn);
    assert.equal(thresholdMin, OVERNIGHT_STALL_THRESHOLD_MIN);
    assert.equal(dryRun, false);
    assert.deepEqual(warns, []);
  });

  it("env válida é respeitada", () => {
    const { warns, warn } = collect();
    const { thresholdMin } = parseArgs([], { OVERNIGHT_WATCHDOG_STALL_MIN: "90" }, warn);
    assert.equal(thresholdMin, 90);
    assert.deepEqual(warns, []);
  });

  it("--threshold tem precedência sobre a env", () => {
    const { thresholdMin } = parseArgs(
      ["--threshold", "120"],
      { OVERNIGHT_WATCHDOG_STALL_MIN: "90" },
      () => {},
    );
    assert.equal(thresholdMin, 120);
  });

  it("--dry-run é reconhecido junto com o resto", () => {
    const { dryRun, thresholdMin } = parseArgs(["--dry-run", "--threshold", "90"], {}, () => {});
    assert.equal(dryRun, true);
    assert.equal(thresholdMin, 90);
  });

  for (const bad of ["", "abc", "0", "-5"]) {
    it(`env inválida (${JSON.stringify(bad)}) → default COM aviso, nunca descarte silencioso`, () => {
      const { warns, warn } = collect();
      const { thresholdMin } = parseArgs([], { OVERNIGHT_WATCHDOG_STALL_MIN: bad }, warn);
      assert.equal(thresholdMin, OVERNIGHT_STALL_THRESHOLD_MIN);
      assert.equal(warns.length, 1, "entrada inválida precisa avisar em stderr");
      assert.match(warns[0], /OVERNIGHT_WATCHDOG_STALL_MIN/);
    });
  }

  for (const bad of ["abc", "0", "-1"]) {
    it(`--threshold inválido (${JSON.stringify(bad)}) → mantém o anterior COM aviso`, () => {
      const { warns, warn } = collect();
      const { thresholdMin } = parseArgs(
        ["--threshold", bad],
        { OVERNIGHT_WATCHDOG_STALL_MIN: "90" },
        warn,
      );
      assert.equal(thresholdMin, 90, "flag inválida não pode derrubar a env válida");
      assert.equal(warns.length, 1);
      assert.match(warns[0], /--threshold/);
    });
  }

  it("--threshold sem valor seguinte → aviso, mantém o default", () => {
    const { warns, warn } = collect();
    const { thresholdMin } = parseArgs(["--threshold"], {}, warn);
    assert.equal(thresholdMin, OVERNIGHT_STALL_THRESHOLD_MIN);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /sem valor/);
  });

  it("limiar no piso ou abaixo dele avisa, mas OBEDECE (override intencional continua possível)", () => {
    const { warns, warn } = collect();
    const { thresholdMin } = parseArgs(["--threshold", String(CI_WAIT_TIMEOUT_MIN)], {}, warn);
    assert.equal(thresholdMin, CI_WAIT_TIMEOUT_MIN, "o guard de piso avisa, não recusa");
    assert.equal(warns.length, 1);
    assert.match(warns[0], /piso/);
  });
});

describe("prosa em sincronia com a constante", () => {
  /**
   * A camada (i) do stall passivo é executada pelo COORDENADOR lendo a
   * SKILL — não há código pra travar esse número, só o texto. Um limiar
   * mudado no código e esquecido na prosa faz o coordenador seguir usando o
   * valor antigo, que é exatamente a divergência silenciosa que motivou
   * este arquivo.
   *
   * A 1ª versão deste guard casava 3 FRASES literais (`>60 min sem
   * progresso` etc). O review do #5568 demonstrou o furo: uma reformulação
   * plausível ("atividade parada há 60 minutos") passava batida, e os `.ts`
   * ficavam de fora — foi assim que um comentário stale sobreviveu dentro do
   * próprio arquivo que a issue reescreveu. Agora a regra é genérica
   * (qualquer menção a "60 min"/"60 minutos" nos arquivos que falam do
   * limiar) e a lista de arquivos inclui os consumidores `.ts`.
   */
  const SCANNED = [
    OVERNIGHT_SKILL,
    "docs/overnight-watchdog-setup.md",
    "scripts/overnight-watchdog.ts",
    "scripts/lib/overnight-fallback-wake.ts",
    "scripts/lib/overnight-stall-threshold.ts",
  ];

  /**
   * Menções LEGÍTIMAS ao valor antigo: notas históricas que datam a mudança
   * de propósito ("era 60 até…", "60 min à época desta decisão"). Casar por
   * trecho da linha, não por número de linha — linha se desloca a cada edit.
   */
  const HISTORICAL = [
    "era 60 até 17/08/2026",
    "60 min à época desta decisão",
    "60 min quando o",
    "60 min quando esta constante foi escolhida",
    "45 min desde",
  ];

  for (const rel of SCANNED) {
    it(`${rel} não cita o limiar antigo fora de nota histórica`, () => {
      const offenders = read(rel)
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\b60\s*min(uto)?s?\b/i.test(line))
        .filter(({ line }) => !HISTORICAL.some((h) => line.includes(h)));

      assert.deepEqual(
        offenders.map(({ n, line }) => `L${n}: ${line.trim()}`),
        [],
        `${rel} cita 60 min como se fosse o limiar atual (hoje ${OVERNIGHT_STALL_THRESHOLD_MIN} min). ` +
          `Se for nota histórica legítima, deixe explícito e adicione o trecho a HISTORICAL.`,
      );
    });
  }

  for (const rel of [OVERNIGHT_SKILL, "docs/overnight-watchdog-setup.md"]) {
    it(`${rel} cita o limiar atual (${OVERNIGHT_STALL_THRESHOLD_MIN} min)`, () => {
      assert.ok(
        read(rel).includes(`${OVERNIGHT_STALL_THRESHOLD_MIN} min`),
        `${rel} não menciona o limiar atual de ${OVERNIGHT_STALL_THRESHOLD_MIN} min.`,
      );
    });
  }
});
