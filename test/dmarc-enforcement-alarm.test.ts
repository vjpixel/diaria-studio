/**
 * test/dmarc-enforcement-alarm.test.ts (#6442)
 *
 * Cobre `scripts/lib/dmarc-enforcement-alarm.ts` — a tradução do relatório
 * do motor (`DmarcEnforcementReport`) pra `AlarmFinding[]`, e a casca
 * fail-soft de leitura (`resolveDmarcEnforcementReport`). Não repete a
 * lógica de `decideDmarcEnforcement` (já coberta em
 * `test/dmarc-enforcement-policy.test.ts`) — aqui o foco é a reconciliação
 * de alarme: escalate/consider-rollback produzem 1 finding, hold produz
 * nenhum, e falha de leitura nunca produz achado (nunca "sem dado" vira
 * "situação ruim, abra issue").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DMARC_ENFORCEMENT_CHECK,
  dmarcEnforcementFingerprint,
  resolveDmarcEnforcementReport,
  toAlarmFindings,
} from "../scripts/lib/dmarc-enforcement-alarm.ts";
import type { DmarcEnforcementReport } from "../scripts/dmarc-enforcement-engine.ts";
import type { DmarcEnforcementDecision } from "../scripts/lib/dmarc-enforcement-policy.ts";

const DOMAIN = "news.diar.ia.br";

function decision(over: Partial<DmarcEnforcementDecision> = {}): DmarcEnforcementDecision {
  return {
    level: "healthy",
    recommendation: "hold",
    nextPolicy: null,
    bounceRatePct: 0.5,
    complaintRatePct: 0.1,
    reasons: ["sinal limpo, domínio maduro"],
    ...over,
  };
}

function report(over: Partial<DmarcEnforcementReport> = {}): DmarcEnforcementReport {
  return {
    domain: DOMAIN,
    currentPolicy: "none",
    currentPolicyRaw: "v=DMARC1; p=none;",
    signals: { totalConsidered: 200, bouncedCount: 1, complainedCount: 0, daysSinceFirstSend: 20 },
    decision: decision(),
    ...over,
  };
}

describe("toAlarmFindings — hold nunca gera achado (#6442)", () => {
  it("recommendation hold => [] (issue existente, se houver, fecha sozinha)", () => {
    const r = report({ decision: decision({ level: "healthy-immature", recommendation: "hold", nextPolicy: null }) });
    assert.deepEqual(toAlarmFindings(r), []);
  });

  it("insufficient-volume também é hold => []", () => {
    const r = report({ decision: decision({ level: "insufficient-volume", recommendation: "hold", nextPolicy: null }) });
    assert.deepEqual(toAlarmFindings(r), []);
  });
});

describe("toAlarmFindings — escalate gera 1 finding (#6442)", () => {
  it("healthy/escalate => 1 finding, fingerprint fixo por domínio, nunca por nível/política", () => {
    const r = report({
      currentPolicy: "none",
      decision: decision({ level: "healthy", recommendation: "escalate", nextPolicy: "quarantine" }),
    });
    const findings = toAlarmFindings(r);
    assert.equal(findings.length, 1);
    const f = findings[0]!;
    assert.equal(f.check, DMARC_ENFORCEMENT_CHECK);
    assert.equal(f.fingerprint, dmarcEnforcementFingerprint(DOMAIN));
    assert.equal(f.fingerprint, "dmarc-enforcement:news.diar.ia.br");
    assert.equal(f.family, "estado");
    assert.match(f.title, /escalar none/);
    assert.match(f.body, /READ-ONLY/);
    assert.match(f.body, /MANUAL do editor/);
    assert.match(f.body, /quarantine/);
  });

  it("contentSignature muda quando a política-alvo muda, fingerprint NÃO muda", () => {
    const escalateToQuarantine = toAlarmFindings(
      report({ currentPolicy: "none", decision: decision({ level: "healthy", recommendation: "escalate", nextPolicy: "quarantine" }) }),
    )[0]!;
    const escalateToReject = toAlarmFindings(
      report({ currentPolicy: "quarantine", decision: decision({ level: "healthy", recommendation: "escalate", nextPolicy: "reject" }) }),
    )[0]!;
    assert.equal(escalateToQuarantine.fingerprint, escalateToReject.fingerprint);
    assert.notEqual(escalateToQuarantine.contentSignature, escalateToReject.contentSignature);
  });
});

describe("toAlarmFindings — consider-rollback também gera 1 finding (#6442)", () => {
  it("unhealthy com política já escalada => finding pedindo rollback manual, nextPolicy null", () => {
    const r = report({
      currentPolicy: "quarantine",
      decision: decision({
        level: "unhealthy",
        recommendation: "consider-rollback",
        nextPolicy: null,
        bounceRatePct: 3.5,
        reasons: ["bounce acima do limiar"],
      }),
    });
    const findings = toAlarmFindings(r);
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.title, /rollback/);
    assert.match(findings[0]!.body, /ROLLBACK/);
  });
});

describe("resolveDmarcEnforcementReport — falha de leitura nunca vira finding (#6442)", () => {
  it("buildFn resolve => ok:true com o report", async () => {
    const fakeReport = report();
    const outcome = await resolveDmarcEnforcementReport(async () => fakeReport, DOMAIN, new Date());
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.report, fakeReport);
  });

  it("buildFn rejeita (rede/DNS/Kit indisponível) => ok:false, nunca lança", async () => {
    const outcome = await resolveDmarcEnforcementReport(
      async () => {
        throw new Error("ECONNRESET");
      },
      DOMAIN,
      new Date(),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.error, /ECONNRESET/);
  });

  it("read failure => nenhum finding possível (não há report pra alimentar toAlarmFindings)", async () => {
    const outcome = await resolveDmarcEnforcementReport(
      async () => {
        throw new Error("KIT_API_KEY não definida");
      },
      DOMAIN,
      new Date(),
    );
    assert.equal(outcome.ok, false);
    // Contrato do caller (scripts/dmarc-enforcement-alarm.ts main()): outcome
    // não-ok nunca chama toAlarmFindings — o achado desta suíte é o próprio
    // tipo (union discriminada) impedir a chamada em tempo de compilação, não
    // um assert em runtime.
  });
});
