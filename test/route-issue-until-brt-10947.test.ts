/**
 * test/route-issue-until-brt-10947.test.ts (#10947)
 *
 * `route-issue.ts --track agendada --until AAAA-MM-DD` e o marcador
 * `aguardando-ate:` passam a usar o calendário de Brasília (America/Sao_Paulo).
 * Cenário real da issue: às 22:33 BRT de 22/10 (01:33Z de 23/10) já era 23/10
 * em UTC, e `--until 2026-10-23` era recusado — não dava pra agendar à noite
 * uma checagem de "amanhã cedo".
 *
 * Relógio sempre injetado (`now`), `gh` sempre stub em memória.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExecTrack,
  parseWaitUntil,
  waitUntilDayStartMs,
  waitUntilYmdAt,
} from "../scripts/lib/issue-exec-track.ts";
import { computeWaitUntilMarkerDate } from "../scripts/lib/wait-until-sync.ts";
import { routeIssue, routeIssueForCreate, validateUntilForAgendada, type GhRunFn } from "../scripts/route-issue.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

interface FakeState {
  labels: string[];
  body: string;
  comments: string[];
}

function fakeGh(initial: { labels: string[]; body: string }): { run: GhRunFn; state: FakeState; calls: string[][] } {
  const state: FakeState = { labels: [...initial.labels], body: initial.body, comments: [] };
  const calls: string[][] = [];
  const run: GhRunFn = (args): GhSpawnResult => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("-q") && args.includes(".body")) return { status: 0, stdout: `${state.body}\n`, stderr: "" };
      return {
        status: 0,
        stdout: JSON.stringify({
          labels: state.labels.map((name) => ({ name })),
          body: state.body,
          state: "OPEN",
          comments: state.comments.map((body) => ({ body })),
        }),
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const addIdx = args.indexOf("--add-label");
      if (addIdx !== -1) for (const l of args[addIdx + 1].split(",")) if (!state.labels.includes(l)) state.labels.push(l);
      const removeIdx = args.indexOf("--remove-label");
      if (removeIdx !== -1) {
        const rm = new Set(args[removeIdx + 1].split(","));
        state.labels = state.labels.filter((l) => !rm.has(l));
      }
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx !== -1) state.body = args[bodyIdx + 1];
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      state.comments.push(args[args.indexOf("--body") + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  return { run, state, calls };
}

// 22/10/2026 22:33 BRT — já é 23/10 em UTC.
const NOITE_22_BRT = new Date("2026-10-23T01:33:00Z");

describe("#10947 — marcador aguardando-ate é dia de Brasília", () => {
  it("parseWaitUntil devolve a meia-noite BRT (03:00Z)", () => {
    assert.equal(parseWaitUntil("<!-- aguardando-ate: 2026-10-23 -->")?.toISOString(), "2026-10-23T03:00:00.000Z");
  });

  it("classifyExecTrack: agendada até 02:59Z de 23/10, volta à fila às 03:00Z (meia-noite BRT)", () => {
    const body = "<!-- aguardando-ate: 2026-10-23 -->";
    assert.equal(classifyExecTrack({ labels: [], body, now: NOITE_22_BRT }), "agendada");
    assert.equal(classifyExecTrack({ labels: [], body, now: new Date("2026-10-23T02:59:59Z") }), "agendada");
    assert.equal(classifyExecTrack({ labels: [], body, now: new Date("2026-10-23T03:00:00Z") }), "overnight");
  });

  it("waitUntilYmdAt usa o dia BRT, não o UTC", () => {
    assert.equal(waitUntilYmdAt(NOITE_22_BRT.getTime()), "2026-10-22");
    assert.equal(waitUntilYmdAt(Date.parse("2026-10-23T03:00:00Z")), "2026-10-23");
  });

  it("waitUntilDayStartMs rejeita data inexistente (rollover do Date)", () => {
    assert.equal(waitUntilDayStartMs("2026-02-30"), null);
    assert.equal(waitUntilDayStartMs("2026-13-01"), null);
    assert.equal(waitUntilDayStartMs("amanhã"), null);
  });

  it("virada de ano: 01/01 começa às 03:00Z de 01/01", () => {
    assert.equal(waitUntilDayStartMs("2027-01-01"), Date.parse("2027-01-01T03:00:00Z"));
  });
});

describe("#10947 — computeWaitUntilMarkerDate arredonda pelo dia BRT", () => {
  it("só-data vira o marcador sem conversão", () => {
    assert.equal(computeWaitUntilMarkerDate("2026-10-23"), "2026-10-23");
  });

  it("só-data inexistente lança em vez de gerar marcador que seria ignorado", () => {
    assert.throws(() => computeWaitUntilMarkerDate("2026-02-30"), /data inexistente/);
  });

  it("instante à noite em BRT (já dia seguinte em UTC) arredonda pro dia BRT seguinte, não 2 dias à frente", () => {
    // 22/10 22:00 BRT → dia BRT seguinte = 23/10. Com UTC dava 24/10.
    assert.equal(computeWaitUntilMarkerDate("2026-10-23T01:00:00Z"), "2026-10-23");
  });

  it("meia-noite BRT exata usa o próprio dia; 1ms depois sobe", () => {
    assert.equal(computeWaitUntilMarkerDate("2026-10-23T03:00:00.000Z"), "2026-10-23");
    assert.equal(computeWaitUntilMarkerDate("2026-10-23T03:00:00.001Z"), "2026-10-24");
  });
});

describe("#10947 — route-issue --track agendada à noite (cenário da issue)", () => {
  it("--until {amanhã BRT} às 22:33 BRT é aceito, grava o marcador e valida agendada", () => {
    const gh = fakeGh({ labels: [], body: "corpo" });
    const result = routeIssue({
      issue: 10659,
      track: "agendada",
      until: "2026-10-23",
      reason: "conferir se o 1º vídeo enviado pela API virou público",
      cwd: "/tmp",
      ghRun: gh.run,
      now: NOITE_22_BRT,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.resolvedTrack, "agendada");
    assert.match(gh.state.body, /^<!-- aguardando-ate: 2026-10-23 -->/);
  });

  it("--until de um dia que já começou em BRT é recusado antes de qualquer gh, com a causa real", () => {
    const gh = fakeGh({ labels: [], body: "" });
    const result = routeIssue({
      issue: 10659,
      track: "agendada",
      until: "2026-10-22",
      reason: "conferir se o 1º vídeo enviado pela API virou público",
      cwd: "/tmp",
      ghRun: gh.run,
      now: NOITE_22_BRT,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /já começou em BRT/);
    assert.match(result.error ?? "", /America\/Sao_Paulo/);
    assert.equal(gh.calls.length, 0);
  });

  it("--until inválido é recusado antes de qualquer gh (antes lançava exceção crua)", () => {
    const gh = fakeGh({ labels: [], body: "" });
    const result = routeIssue({
      issue: 1,
      track: "agendada",
      until: "2026-02-30",
      reason: "conferir resultado do envio",
      cwd: "/tmp",
      ghRun: gh.run,
      now: NOITE_22_BRT,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /--until inválido/);
    assert.equal(gh.calls.length, 0);
  });

  it("com decisao-registrada na issue (combinação da #10659), a data futura em BRT vence e o roteamento passa", () => {
    // Na #10659 a recusa citava a precedência de `decisao-registrada` só
    // porque o marcador (em UTC) já não era futuro — com o dia BRT, o
    // marcador vence a 2ª checagem de fora-de-rodada, como documentado.
    const gh = fakeGh({ labels: ["decisao-registrada"], body: "" });
    const result = routeIssue({
      issue: 10659,
      track: "agendada",
      until: "2026-10-23",
      reason: "conferir se o 1º vídeo enviado pela API virou público",
      cwd: "/tmp",
      ghRun: gh.run,
      now: NOITE_22_BRT,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.resolvedTrack, "agendada");
  });

  it("recusa do dry-run nomeia a label que venceu", () => {
    const gh = fakeGh({ labels: [], body: "" });
    const result = routeIssue({
      issue: 54,
      track: "agendada",
      until: "2026-10-30",
      motivo: "epica",
      reason: "issue e uma epica; sub-issues em andamento",
      cwd: "/tmp",
      ghRun: gh.run,
      now: NOITE_22_BRT,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /dry-run pré-escrita/);
    assert.match(result.error ?? "", /Regra que venceu: label `epic-guarda-chuva`/);
    assert.equal(gh.state.comments.length, 0);
  });

  it("validateUntilForAgendada: último instante aceito é 02:59:59Z da véspera-UTC", () => {
    assert.equal(validateUntilForAgendada("2026-10-23", new Date("2026-10-23T02:59:59Z")), null);
    assert.match(validateUntilForAgendada("2026-10-23", new Date("2026-10-23T03:00:00Z")) ?? "", /já começou/);
  });

  it("routeIssueForCreate grava o mesmo dia pedido", () => {
    const result = routeIssueForCreate({ track: "agendada", until: "2026-10-23", body: "x" });
    assert.equal(result.ok, true);
    assert.match(result.body, /aguardando-ate: 2026-10-23/);
  });
});
