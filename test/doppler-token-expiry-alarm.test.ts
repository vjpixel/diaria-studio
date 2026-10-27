import { it } from "node:test";
import assert from "node:assert/strict";
import { evaluateDopplerExpiries, readDopplerExpiries } from "../scripts/doppler-token-expiry-alarm.ts";
import { planAlarmReconciliation, alarmIssueStateKey, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";
const now = new Date("2026-11-01T12:00:00Z");
const key = "THREADS_PERSONAL_TOKEN_EXPIRES_AT";
const at = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
it("#11077: vencimento no Doppler alarma mesmo sem access token local", () => {
  let args: string[] = [];
  const vault = readDopplerExpiries((a) => { args = a; return `${key}=${at(2)}\nUNRELATED_SECRET=sentinel-secret`; });
  const findings = evaluateDopplerExpiries(vault, now);
  assert.equal(findings[0].priority, "P1");
  assert.equal(findings[0].fingerprint, key);
  assert.ok(args.includes("--no-file"));
  assert.ok(args.includes("diaria-studio"));
  assert.ok(!JSON.stringify(findings).includes("sentinel-secret"));
  assert.ok(!JSON.stringify(findings).includes(at(2)));
});
it("faixas de 14/3 dias, vencido, ilegível, vazio e renovado", () => {
  for (const [value, priority] of [[at(15), undefined], [at(14), "P2"], [at(3), "P1"], [at(0), "P1"], [at(-1), "P1"], ["sentinel-secret", "P2"], ["", "P2"]] as const) {
    const findings = evaluateDopplerExpiries({ [key]: value }, now);
    assert.equal(findings[0]?.priority, priority);
    assert.ok(!JSON.stringify(findings).includes("sentinel-secret"));
  }
});
it("outros EXPIRES_AT e metadata ausente de token configurado são cobertos", () => {
  const findings = evaluateDopplerExpiries({ LINKEDIN_PERSONAL_ACCESS_TOKEN: "sentinel-secret", OTHER_TOKEN_EXPIRES_AT: at(10) }, now);
  assert.equal(findings.length, 2);
  assert.ok(findings.some((f) => f.fingerprint === "LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT" && f.contentSignature === "unknown"));
  assert.deepEqual(evaluateDopplerExpiries({}, now), [], "Threads nunca configurado não alarma antes da #10772");
});
it("erros/vault vazio abortam sem expor conteúdo nem reconciliar", () => {
  for (const runner of [() => { throw new Error("sentinel-secret"); }, () => "", () => "invalid snapshot"]) {
    assert.throws(() => readDopplerExpiries(runner), (e: Error) => !e.message.includes("sentinel-secret") && e.message.includes("alarmes preservados"));
  }
});
it("renovação no Doppler fecha o alarme com fingerprint estável", () => {
  const finding = evaluateDopplerExpiries({ [key]: at(2) }, now)[0];
  const state: AlarmIssuesState = { [alarmIssueStateKey(finding.check, finding.fingerprint)]: { issueNumber: 123, url: "https://github.com/x/y/issues/123", missingStreak: 0, closedAt: null, family: "estado" } };
  assert.deepEqual(planAlarmReconciliation(evaluateDopplerExpiries({ [key]: at(60) }, now), state, 1).map((a) => a.kind), ["close"]);
});
