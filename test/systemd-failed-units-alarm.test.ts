/**
 * test/systemd-failed-units-alarm.test.ts (#5563)
 *
 * Lógica pura de `scripts/lib/systemd-failed-units-alarm.ts` + `toAlarmFinding`
 * de `scripts/systemd-failed-units-alarm.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSystemctlListUnitsFailedOutput,
  evaluateSystemdFailedUnits,
  isAlarmingVerdict,
  shouldSendSystemdFailedUnitsAlarm,
  markSystemdFailedUnitsAlarmed,
  emptySystemdFailedUnitsAlarmState,
  buildSystemdFailedUnitsAlarmEmail,
  parseSystemctlShowOutput,
  explainSystemdResult,
  formatUnitDiagnostics,
  buildFailedUnitIssueBody,
  UNIT_DIAGNOSTIC_PROPERTIES,
} from "../scripts/lib/systemd-failed-units-alarm.ts";
import { toAlarmFinding, collectUnitDiagnostics } from "../scripts/systemd-failed-units-alarm.ts";
import type { execFileSync } from "node:child_process";

describe("toAlarmFinding — family obrigatório (#5553/#5557)", () => {
  it("family é sempre 'estado' (condição re-checável a cada sweep — some quando o operador conserta)", () => {
    assert.equal(toAlarmFinding("diaria-edicao-diaria.service").family, "estado");
  });

  it("fingerprint é o nome exato da unit — 1 finding por unit, não agregado", () => {
    const f = toAlarmFinding("diaria-edicao-diaria.service");
    assert.equal(f.check, "systemd-failed-units");
    assert.equal(f.fingerprint, "diaria-edicao-diaria.service");
    assert.equal(f.priority, "P1");
  });
});

describe("parseSystemctlListUnitsFailedOutput", () => {
  it("cenário real do #5563: 1 unit failed, --plain --no-legend", () => {
    const stdout = "diaria-edicao-diaria.service loaded failed failed edicao diaria agendada\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });

  it("múltiplas units failed, cada uma numa linha", () => {
    const stdout =
      "diaria-edicao-diaria.service loaded failed failed edicao\n" +
      "diaria-cursos-error-alarm.service loaded failed failed alarme\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), [
      "diaria-edicao-diaria.service",
      "diaria-cursos-error-alarm.service",
    ]);
  });

  it("saída vazia (--no-legend, nenhuma unit failed) → array vazio", () => {
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(""), []);
  });

  it("tolera glyph de árvore residual como 1º token (fallback se --plain não for honrado)", () => {
    const stdout = "● diaria-edicao-diaria.service loaded failed failed edicao\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });

  it("ignora linhas em branco", () => {
    const stdout = "\n\ndiaria-edicao-diaria.service loaded failed failed edicao\n\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });
});

describe("evaluateSystemdFailedUnits", () => {
  it("lista vazia → ok", () => {
    assert.deepEqual(evaluateSystemdFailedUnits([]), { verdict: "ok", failedUnits: [] });
  });

  it("1+ units failed → alarm-failed-units, lista ORDENADA independente da ordem de entrada", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-z.service", "diaria-a.service"]);
    assert.equal(ev.verdict, "alarm-failed-units");
    assert.deepEqual(ev.failedUnits, ["diaria-a.service", "diaria-z.service"]);
  });
});

describe("isAlarmingVerdict", () => {
  it("ok → false, alarm-failed-units → true", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("alarm-failed-units"), true);
  });
});

describe("shouldSendSystemdFailedUnitsAlarm — idempotência por CONJUNTO", () => {
  it("verdict ok nunca alarma", () => {
    assert.equal(
      shouldSendSystemdFailedUnitsAlarm({ verdict: "ok", failedUnits: [] }, emptySystemdFailedUnitsAlarmState()),
      false,
    );
  });

  it("1ª detecção (state vazio) alarma", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, emptySystemdFailedUnitsAlarmState()), true);
  });

  it("mesmo conjunto já alarmado não reenvia", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service", "diaria-b.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-b.service", "diaria-a.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), false);
  });

  it("conjunto MUDOU (unit nova falhou) reenvia mesmo com sobreposição parcial", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service", "diaria-c.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service", "diaria-b.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), true);
  });

  it("conjunto encolheu (uma unit consertada, outra ainda falha) reenvia", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service", "diaria-b.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), true);
  });
});

describe("buildSystemdFailedUnitsAlarmEmail", () => {
  it("lista as units no assunto e no corpo", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-edicao-diaria.service"]);
    const { subject, body } = buildSystemdFailedUnitsAlarmEmail(ev, "");
    assert.match(subject, /diaria-edicao-diaria\.service/);
    assert.match(body, /diaria-edicao-diaria\.service/);
    assert.match(body, /journalctl --user -u/);
  });

  it("inclui issueLines quando fornecido", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const { body } = buildSystemdFailedUnitsAlarmEmail(ev, "\n\nIssues:\n  - #999 (https://x)");
    assert.match(body, /#999/);
  });
});

// ---------------------------------------------------------------------------
// Diagnóstico da unit falha (#5943)
//
// Regressão do buraco concreto: a #5943 (`diaria-seo-weekly.service`) foi
// aberta, investigada e encerrada com "Verificado: não há código para
// corrigir" sem que a issue jamais tivesse carregado UM dado sobre a falha —
// o corpo só mandava rodar `journalctl` numa máquina que o leitor não tinha.
// ---------------------------------------------------------------------------

/** Saída real de `systemctl --user show` pro cenário da #5943. */
const SHOW_5943 = [
  "Result=exit-code",
  "ExecMainStatus=1",
  "NRestarts=0",
  "ActiveEnterTimestamp=Sun 2026-08-23 04:10:12 -03",
  "InactiveEnterTimestamp=Sun 2026-08-23 04:12:47 -03",
  "InvocationID=9f2c1ab74e5d43c0b8e6a1d70f3c2b58",
  "",
].join("\n");

describe("parseSystemctlShowOutput (#5943)", () => {
  it("cenário #5943: extrai os campos estruturados da unit falha", () => {
    const d = parseSystemctlShowOutput(SHOW_5943);
    assert.equal(d.Result, "exit-code");
    assert.equal(d.ExecMainStatus, "1");
    assert.equal(d.NRestarts, "0");
    assert.equal(d.InvocationID, "9f2c1ab74e5d43c0b8e6a1d70f3c2b58");
    assert.equal(d.ActiveEnterTimestamp, "Sun 2026-08-23 04:10:12 -03");
  });

  it("GUARD DE LEAK: chave fora da allowlist é descartada (repo é público)", () => {
    const d = parseSystemctlShowOutput(
      "Result=exit-code\n" +
        "ExecStart={ path=/usr/bin/npx ; argv[]=npx tsx scripts/seo-pull.ts --token SEGREDO }\n" +
        "Environment=BREVO_CLARICE_API_KEY=xkeysib-vazamento\n",
    );
    assert.deepEqual(Object.keys(d), ["Result"]);
    const body = buildFailedUnitIssueBody("diaria-seo-weekly.service", d, 2);
    assert.ok(!body.includes("SEGREDO"));
    assert.ok(!body.includes("xkeysib-vazamento"));
  });

  it("GUARD DE LEAK: valor da allowlist fora da forma esperada é descartado", () => {
    // Se algum systemd devolvesse texto livre num campo esperado como enum, ele
    // NÃO pode chegar a uma issue pública.
    const d = parseSystemctlShowOutput("Result=falhou lendo /home/pixel/.credentials.json\nExecMainStatus=nan\n");
    assert.deepEqual(d, {});
  });

  it("valor vazio (propriedade não setada) é descartado", () => {
    assert.deepEqual(parseSystemctlShowOutput("Result=\nNRestarts=\n"), {});
  });

  it("só o PRIMEIRO '=' separa chave de valor", () => {
    // Nenhum campo da allowlist contém '=' hoje, mas o parser não pode partir
    // no separador errado se isso mudar.
    assert.deepEqual(parseSystemctlShowOutput("InvocationID=abc=def\n"), {});
  });

  it("linha sem '=' e lixo não quebram o parser", () => {
    const d = parseSystemctlShowOutput("\nlixo sem igual\nResult=timeout\n");
    assert.deepEqual(d, { Result: "timeout" });
  });

  it("a allowlist não contém nenhum campo de texto livre conhecido", () => {
    for (const proibido of ["ExecStart", "ExecStartPre", "Environment", "EnvironmentFile", "Description"]) {
      assert.ok(!(UNIT_DIAGNOSTIC_PROPERTIES as readonly string[]).includes(proibido), proibido);
    }
  });
});

describe("explainSystemdResult (#5943)", () => {
  it("distingue as causas que têm correções diferentes", () => {
    assert.match(explainSystemdResult("exit-code") ?? "", /exit != 0/);
    assert.match(explainSystemdResult("timeout") ?? "", /timeout/);
    assert.match(explainSystemdResult("oom-kill") ?? "", /mem[óo]ria/);
    assert.match(explainSystemdResult("start-limit-hit") ?? "", /StartLimitBurst/);
  });

  it("'success' aponta o caso não-óbvio: falhou fora do ExecStart", () => {
    assert.match(explainSystemdResult("success") ?? "", /ExecStartPre/);
  });

  it("enum desconhecido devolve null em vez de inventar explicação", () => {
    assert.equal(explainSystemdResult("resultado-que-nao-existe"), null);
  });
});

describe("formatUnitDiagnostics (#5943)", () => {
  it("sem diagnóstico devolve [] — o caller degrada pro texto pré-#5943", () => {
    assert.deepEqual(formatUnitDiagnostics({}), []);
  });

  it("renderiza os campos capturados + a tradução do Result", () => {
    const lines = formatUnitDiagnostics(parseSystemctlShowOutput(SHOW_5943)).join("\n");
    assert.match(lines, /`Result`: `exit-code`/);
    assert.match(lines, /`ExecMainStatus`: `1`/);
    assert.match(lines, /exit != 0/);
  });

  it("Result desconhecido lista o campo mas não anexa explicação inventada", () => {
    const lines = formatUnitDiagnostics({ Result: "coisa-nova" }).join("\n");
    assert.match(lines, /`Result`: `coisa-nova`/);
    assert.ok(!lines.includes("`Result=coisa-nova`:"));
  });
});

describe("buildFailedUnitIssueBody (#5943)", () => {
  it("REGRESSÃO: o corpo carrega o diagnóstico, não só a ordem de ir rodar journalctl", () => {
    const body = buildFailedUnitIssueBody("diaria-seo-weekly.service", parseSystemctlShowOutput(SHOW_5943), 2);
    assert.match(body, /Diagnóstico capturado no momento do achado/);
    assert.match(body, /`Result`: `exit-code`/);
  });

  it("com InvocationID o journalctl aponta pra EXECUÇÃO que falhou, não pra última", () => {
    const body = buildFailedUnitIssueBody("diaria-seo-weekly.service", parseSystemctlShowOutput(SHOW_5943), 2);
    assert.match(body, /_SYSTEMD_INVOCATION_ID=9f2c1ab74e5d43c0b8e6a1d70f3c2b58/);
    assert.ok(!body.includes("-n 50"));
  });

  it("sem InvocationID cai no journalctl por unit", () => {
    const body = buildFailedUnitIssueBody("diaria-seo-weekly.service", { Result: "exit-code" }, 2);
    assert.match(body, /journalctl --user -u diaria-seo-weekly\.service -n 50/);
  });

  it("máquina sem systemd (diagnóstico vazio) degrada pro corpo pré-#5943", () => {
    const body = buildFailedUnitIssueBody("diaria-seo-weekly.service", {}, 2);
    assert.ok(!body.includes("Diagnóstico capturado"));
    assert.match(body, /journalctl --user -u diaria-seo-weekly\.service -n 50/);
    assert.match(body, /Religar\/reiniciar é ação manual do editor/);
  });

  it("preserva o contrato de fechamento automático (nº de execuções)", () => {
    assert.match(buildFailedUnitIssueBody("diaria-a.service", {}, 3), /3 execuções consecutivas/);
  });

  it("explica por que o journal NÃO vem anexado", () => {
    assert.match(buildFailedUnitIssueBody("diaria-a.service", {}, 2), /repositório é público/);
  });
});

describe("toAlarmFinding com diagnóstico (#5943)", () => {
  it("o diagnóstico entra no body sem mexer em check/fingerprint/priority/family", () => {
    const f = toAlarmFinding("diaria-seo-weekly.service", parseSystemctlShowOutput(SHOW_5943));
    assert.equal(f.check, "systemd-failed-units");
    assert.equal(f.fingerprint, "diaria-seo-weekly.service");
    assert.equal(f.priority, "P1");
    assert.equal(f.family, "estado");
    assert.match(f.body, /`Result`: `exit-code`/);
  });

  it("chamada sem diagnóstico segue válida (default {}) — compat com o call site antigo", () => {
    const f = toAlarmFinding("diaria-a.service");
    assert.match(f.body, /está em estado `failed`/);
    assert.ok(!f.body.includes("Diagnóstico capturado"));
  });
});

describe("collectUnitDiagnostics — fail-soft em 3 camadas (#5943)", () => {
  /** `execFileSync` injetado: nenhum teste shella `systemctl` de verdade. */
  const fakeExec = (behavior: () => string): typeof execFileSync =>
    ((() => behavior()) as unknown) as typeof execFileSync;

  it("caminho feliz: parseia a saída do systemctl show", () => {
    const d = collectUnitDiagnostics("diaria-seo-weekly.service", fakeExec(() => SHOW_5943));
    assert.equal(d.Result, "exit-code");
    assert.equal(d.InvocationID, "9f2c1ab74e5d43c0b8e6a1d70f3c2b58");
  });

  it("(a) máquina sem systemctl (ENOENT) → {} em vez de explodir o sweep", () => {
    const d = collectUnitDiagnostics(
      "diaria-a.service",
      fakeExec(() => {
        throw Object.assign(new Error("spawnSync systemctl ENOENT"), { code: "ENOENT" });
      }),
    );
    assert.deepEqual(d, {});
  });

  it("(b) exit != 0 mas com stdout → aproveita o que veio (mesmo padrão de list-units)", () => {
    const d = collectUnitDiagnostics(
      "diaria-a.service",
      fakeExec(() => {
        throw Object.assign(new Error("exit 1"), { status: 1, stdout: "Result=timeout\n" });
      }),
    );
    assert.deepEqual(d, { Result: "timeout" });
  });

  it("(c) erro sem stdout nenhum → {}", () => {
    const d = collectUnitDiagnostics(
      "diaria-a.service",
      fakeExec(() => {
        throw Object.assign(new Error("timeout"), { status: null });
      }),
    );
    assert.deepEqual(d, {});
  });
});
