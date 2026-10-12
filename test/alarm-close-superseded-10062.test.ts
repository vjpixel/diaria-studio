/**
 * test/alarm-close-superseded-10062.test.ts (#10062 itens 3 e 5)
 *
 * Regressão: alarmes de fingerprint-de-conjunto que chamam `notifyEditor`
 * direto nunca fechavam a própria issue — #9555 (on-hold-vencimento) ficou
 * 6 dias aberta depois de cumprida porque o caminho "nenhum achado" dava
 * `return` sem tocar o GitHub; #10034 (saúde de aquisição) só abria.
 * `gh` sempre mockado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  alarmFindingMarker,
  closeSupersededAlarmIssues,
  extractAlarmFingerprintForCheck,
  type GhRunFn,
} from "../scripts/lib/alarm-issues.ts";
import { closeSupersededAcquisitionAlarms } from "../scripts/check-acquisition-health.ts";
import { onHoldAlarmFingerprint } from "../scripts/on-hold-vencimento-alarm.ts";

const ON_HOLD = "on-hold-vencimento-alarm";
// Fingerprint real da #9555.
const FP_9555 =
  "8157:vencimento-line-missing:,9100:vencimento-line-missing:,9111:vencimento-line-missing:,9167:vencimento-line-missing:";

function fakeGh(openIssues: { number: number; body: string }[], closeStatus = 0) {
  const calls: string[][] = [];
  const run: GhRunFn = (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify(openIssues), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "close") return { status: closeStatus, stdout: "", stderr: "x" };
    return { status: 1, stdout: "", stderr: "inesperado" };
  };
  return { run, calls };
}

describe("extractAlarmFingerprintForCheck", () => {
  it("extrai o fingerprint do marcador deste check", () => {
    assert.equal(extractAlarmFingerprintForCheck(`corpo\n\n${alarmFindingMarker(ON_HOLD, FP_9555)}\n`, ON_HOLD), FP_9555);
  });
  it("não casa check que só compartilha prefixo", () => {
    assert.equal(extractAlarmFingerprintForCheck(alarmFindingMarker("on-hold-vencimento-alarm-x", "a"), ON_HOLD), null);
    assert.equal(extractAlarmFingerprintForCheck("sem marcador", ON_HOLD), null);
  });
});

describe("closeSupersededAlarmIssues (#10062)", () => {
  it("cenário real #9555: nenhum achado → fecha a issue aberta do alarme", () => {
    const { run, calls } = fakeGh([{ number: 9555, body: `x\n${alarmFindingMarker(ON_HOLD, FP_9555)}\n` }]);
    const res = closeSupersededAlarmIssues(ON_HOLD, null, ".", run);
    assert.deepEqual(res, { closed: [9555], failed: [], listed: true });
    const close = calls.find((a) => a[1] === "close")!;
    assert.equal(close[2], "9555");
    assert.ok(close.includes("not planned"));
  });

  it("conjunto inalterado → não fecha; conjunto mudou → fecha só o antigo", () => {
    const issues = [
      { number: 1, body: alarmFindingMarker(ON_HOLD, "old") },
      { number: 2, body: alarmFindingMarker(ON_HOLD, "new") },
      { number: 3, body: alarmFindingMarker("outro-check", "old") },
      { number: 4, body: "issue comum" },
    ];
    const { run } = fakeGh(issues);
    assert.deepEqual(closeSupersededAlarmIssues(ON_HOLD, "new", ".", run).closed, [1]);
  });

  it("falha do gh: listagem → listed=false; close → failed (sem lançar)", () => {
    const failing: GhRunFn = () => ({ status: 1, stdout: "", stderr: "offline" });
    assert.deepEqual(closeSupersededAlarmIssues(ON_HOLD, null, ".", failing), { closed: [], failed: [], listed: false });
    const { run } = fakeGh([{ number: 7, body: alarmFindingMarker(ON_HOLD, "a") }], 1);
    assert.deepEqual(closeSupersededAlarmIssues(ON_HOLD, null, ".", run), { closed: [], failed: [7], listed: true });
  });

  it("lista só issues ABERTAS com a label alarm", () => {
    const { run, calls } = fakeGh([]);
    closeSupersededAlarmIssues(ON_HOLD, null, ".", run);
    const list = calls[0]!;
    assert.deepEqual(list.slice(0, 2), ["issue", "list"]);
    assert.ok(list.includes("--label") && list.includes("alarm"));
    assert.equal(list[list.indexOf("--state") + 1], "open");
  });
});

describe("wiring nos alarmes (#10062 itens 3 e 5)", () => {
  it("check-acquisition-health: cenário #10034 — rodada sem achado fecha a issue do canal_desconhecido", () => {
    const fp = "canal_desconhecido:facebook|canal_desconhecido:instagram|canal_desconhecido:linkedin";
    const { run, calls } = fakeGh([{ number: 10034, body: alarmFindingMarker("check-acquisition-health", fp) }]);
    closeSupersededAcquisitionAlarms(null, ".", run);
    assert.ok(calls.some((a) => a[1] === "close" && a[2] === "10034"));
  });

  it("onHoldAlarmFingerprint reproduz o fingerprint persistido da #9555 (fecha o que já existe)", () => {
    const findings = [9167, 8157, 9111, 9100].map((number) => ({ number, reason: "vencimento-line-missing", vencimento: null }));
    assert.equal(onHoldAlarmFingerprint(findings), FP_9555);
  });

  for (const [file, emptyGuard] of [
    ["scripts/on-hold-vencimento-alarm.ts", "shouldSendOnHoldVencimentoAlarm(findings)"],
    ["scripts/route-marker-staleness-alarm.ts", "if (!mustReport)"],
  ] as const) {
    it(`${file}: caminho "nenhum achado" chama o fechamento antes do return`, () => {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const start = src.indexOf(emptyGuard);
      assert.ok(start > -1);
      const block = src.slice(start, src.indexOf("return;", start));
      assert.match(block, /closeSuperseded\(null\)/);
    });
  }

  it("check-acquisition-health: os 2 caminhos de avaliação fecham antes de gravar o state", () => {
    const src = readFileSync(new URL("../scripts/check-acquisition-health.ts", import.meta.url), "utf8");
    assert.equal(src.match(/closeSupersededAcquisitionAlarms\(fingerprint\);\n\n\s+const nextState/g)?.length, 2);
  });
});
