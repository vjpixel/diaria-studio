/**
 * test/decision-state-drift.test.ts (#10105)
 *
 * Alarme "toggle real contradiz decisão vigente do editor". Caso central é o
 * incidente: decisão "manter a rampa pausada" (30/09) gravada na #8099 e o
 * kill switch religado sem rastro em 01/10 — nada cruzava as duas coisas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDecisionStates,
  decisionDriftReportLines,
  driftsOf,
  formatDriftReportLines,
  parseIssuesJson,
  productionToggleReader,
  type ToggleReading,
} from "../scripts/lib/decision-state-drift.ts";
import {
  formatDecisionMarker,
  latestDecisionFor,
  parseDecisionMarkers,
  type IssueDecision,
} from "../scripts/lib/issue-decisions.ts";
import { parseDriftCli } from "../scripts/check-decision-state-drift.ts";

const PAUSA: IssueDecision = {
  decided_at: "2026-09-30T22:00:00.000Z",
  pergunta: "Religar a rampa Clarice?",
  resposta: "Ainda não — mantém pausada",
  sessao: "develop",
  estado_esperado: { toggle: "clarice-envio-enabled", enabled: false },
};

const LIGADO_SEM_RASTRO: ToggleReading = { enabled: true, updatedAt: "2026-10-01T15:31:21.000Z" };
const PAUSADO: ToggleReading = { enabled: false, updatedAt: "2026-10-13T14:22:28.730Z", machine: "300", reason: "pausa" };

const reader = (state: ToggleReading) => () => state;

function silenced<T>(fn: () => T): { value: T; warnings: string[] } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(String(m));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("marcador decisao-editor com estado_esperado (#10105)", () => {
  it("round-trip preserva estado_esperado", () => {
    const [d] = parseDecisionMarkers([`${formatDecisionMarker(PAUSA)}\n\nDecisão: mantém pausada.`]);
    assert.deepEqual(d.estado_esperado, { toggle: "clarice-envio-enabled", enabled: false });
  });

  it("retrocompatível: marcador sem o campo sai byte a byte igual ao formato antigo", () => {
    const { estado_esperado: _e, ...semCampo } = PAUSA;
    const legacy = `<!-- decisao-editor: ${Buffer.from(
      JSON.stringify({ decided_at: semCampo.decided_at, pergunta: semCampo.pergunta, resposta: semCampo.resposta, sessao: semCampo.sessao }),
      "utf8",
    ).toString("base64")} -->`;
    assert.equal(formatDecisionMarker(semCampo), legacy);
    const [d] = parseDecisionMarkers([legacy]);
    assert.equal(d.estado_esperado, undefined);
  });

  it("formatDecisionMarker recusa toggle fora da lista fechada", () => {
    assert.throws(
      () => formatDecisionMarker({ ...PAUSA, estado_esperado: { toggle: "inexistente" as never, enabled: false } }),
      /estado_esperado inválido/,
    );
  });

  it("estado_esperado malformado: decisão continua válida, campo some, com aviso", () => {
    const raw = { ...PAUSA, estado_esperado: { toggle: "clarice-envio-enabled", enabled: "false" } };
    const body = `<!-- decisao-editor: ${Buffer.from(JSON.stringify(raw), "utf8").toString("base64")} -->`;
    const { value, warnings } = silenced(() => parseDecisionMarkers([body]));
    assert.equal(value.length, 1);
    assert.equal(value[0].resposta, PAUSA.resposta);
    assert.equal(value[0].estado_esperado, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /estado_esperado ignorado/);
  });
});

describe("checkDecisionStates (#10105)", () => {
  it("INCIDENTE: pausa registrada na #8099 × toggle ligado sem rastro → divergência no relatório", () => {
    const checks = checkDecisionStates(
      [{ number: 8099, title: "Pausar rampa Clarice", commentBodies: [`${formatDecisionMarker(PAUSA)}\n\nmantém pausada`] }],
      reader(LIGADO_SEM_RASTRO),
    );
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    const lines = formatDriftReportLines(checks);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /DECISÃO CONTRADITA \(#8099/);
    assert.match(lines[0], /clarice-envio-enabled PAUSADO/);
    assert.match(lines[0], /toggle está LIGADO/);
    assert.match(lines[0], /SEM RASTRO/);
  });

  it("toggle bate com a decisão → check ok, nenhuma linha de aviso", () => {
    const checks = checkDecisionStates([{ number: 8099, commentBodies: [formatDecisionMarker(PAUSA)] }], reader(PAUSADO));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, true);
    assert.deepEqual(formatDriftReportLines(checks), []);
  });

  it("marcador antigo (sem estado_esperado) nunca é vigiado — nada de interpretar prosa", () => {
    const { estado_esperado: _e, ...semCampo } = PAUSA;
    const checks = checkDecisionStates(
      [{ number: 8099, commentBodies: [`${formatDecisionMarker(semCampo)}\n\nmantém pausada`] }],
      reader(LIGADO_SEM_RASTRO),
    );
    assert.deepEqual(checks, []);
  });

  it("decisão posterior sem estado_esperado substitui a de pausa (vigente = mais recente)", () => {
    const religa: IssueDecision = {
      decided_at: "2026-10-07T10:00:00.000Z",
      pergunta: "Religar?",
      resposta: "Pode religar",
      sessao: "develop",
    };
    const bodies = [formatDecisionMarker(PAUSA), formatDecisionMarker(religa)];
    assert.equal(latestDecisionFor(bodies)?.resposta, "Pode religar");
    assert.deepEqual(checkDecisionStates([{ number: 8099, commentBodies: bodies }], reader(LIGADO_SEM_RASTRO)), []);
  });

  it("lê cada toggle uma vez só, mesmo com várias issues", () => {
    let reads = 0;
    const checks = checkDecisionStates(
      [
        { number: 1, commentBodies: [formatDecisionMarker(PAUSA)] },
        { number: 2, commentBodies: [formatDecisionMarker(PAUSA)] },
      ],
      () => {
        reads++;
        return LIGADO_SEM_RASTRO;
      },
    );
    assert.equal(reads, 1);
    assert.equal(driftsOf(checks).length, 2);
  });
});

describe("parseIssuesJson — só autor confiável (#9752)", () => {
  it("marcador postado por conta sem vínculo com o repo é ignorado", () => {
    const stdout = JSON.stringify([
      {
        number: 8099,
        title: "x",
        comments: [{ authorAssociation: "NONE", body: formatDecisionMarker(PAUSA) }],
      },
    ]);
    const r = parseIssuesJson(stdout);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.issues[0].commentBodies, []);
    assert.deepEqual(checkDecisionStates(r.issues, reader(LIGADO_SEM_RASTRO)), []);
  });

  it("aceita objeto único (gh issue view) e lista (gh issue list)", () => {
    const one = { number: 8099, comments: [{ authorAssociation: "OWNER", body: formatDecisionMarker(PAUSA) }] };
    const a = parseIssuesJson(JSON.stringify(one));
    const b = parseIssuesJson(JSON.stringify([one]));
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.deepEqual(a.issues, b.issues);
  });

  it("JSON inválido ou sem comments → ok:false (nunca lista vazia que pareça 'nada a avisar')", () => {
    assert.equal(parseIssuesJson("{").ok, false);
    assert.equal(parseIssuesJson(JSON.stringify([{ number: 1 }])).ok, false);
  });
});

describe("decisionDriftReportLines — fail-soft, mas nunca mudo", () => {
  it("gh falhou → uma linha dizendo que o alarme NÃO rodou", () => {
    const lines = decisionDriftReportLines(() => ({ ok: false, error: "gh saiu 1" }), reader(LIGADO_SEM_RASTRO));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /NÃO rodou: gh saiu 1/);
  });

  it("fetch lançando também vira linha, não exceção", () => {
    const lines = decisionDriftReportLines(() => {
      throw new Error("boom");
    }, reader(LIGADO_SEM_RASTRO));
    assert.match(lines[0], /NÃO rodou: boom/);
  });
});

describe("productionToggleReader — lê o arquivo real do kill switch", () => {
  it("incidente reproduzido em disco: data/clarice-envio-enabled.json enabled:true × decisão de pausa", () => {
    const root = mkdtempSync(join(tmpdir(), "decision-drift-"));
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeFileSync(join(root, "data", "clarice-envio-enabled.json"), JSON.stringify({ enabled: true, updatedAt: "2026-10-01T15:31:21.000Z" }));
      const lines = decisionDriftReportLines(
        () => ({ ok: true, issues: [{ number: 8099, commentBodies: [formatDecisionMarker(PAUSA)] }] }),
        productionToggleReader(root),
      );
      assert.equal(lines.length, 1);
      assert.match(lines[0], /toggle está LIGADO/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clarice-novos-enabled ausente = pausado (default do irmão) — decisão de pausa satisfeita", () => {
    const root = mkdtempSync(join(tmpdir(), "decision-drift-novos-"));
    try {
      const d: IssueDecision = { ...PAUSA, estado_esperado: { toggle: "clarice-novos-enabled", enabled: false } };
      const checks = checkDecisionStates([{ number: 1, commentBodies: [formatDecisionMarker(d)] }], productionToggleReader(root));
      assert.equal(checks[0].ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseDriftCli", () => {
  const now = () => new Date("2026-10-13T12:00:00.000Z");

  it("default = check das issues abertas", () => {
    assert.deepEqual(parseDriftCli([], now), { kind: "check", issues: null, json: false });
  });

  it("--issues N,M e --json", () => {
    assert.deepEqual(parseDriftCli(["--issues", "8099,10105", "--json"], now), { kind: "check", issues: [8099, 10105], json: true });
    assert.equal(parseDriftCli(["--issues", "abc"], now).kind, "error");
    assert.equal(parseDriftCli(["--issues"], now).kind, "error");
  });

  it("--print-marker gera decisão com estado_esperado que round-trippa", () => {
    const cmd = parseDriftCli(
      ["--print-marker", "--pergunta", "Religar?", "--resposta", "Mantém pausada", "--sessao", "develop", "--toggle", "clarice-envio-enabled", "--enabled", "false"],
      now,
    );
    assert.equal(cmd.kind, "marker");
    if (cmd.kind !== "marker") return;
    assert.equal(cmd.decision.decided_at, "2026-10-13T12:00:00.000Z");
    const [d] = parseDecisionMarkers([formatDecisionMarker(cmd.decision)]);
    assert.deepEqual(d.estado_esperado, { toggle: "clarice-envio-enabled", enabled: false });
  });

  it("--print-marker recusa toggle desconhecido, enabled não-booleano e sessão inválida", () => {
    const base = ["--print-marker", "--pergunta", "p", "--resposta", "r"];
    assert.equal(parseDriftCli([...base, "--sessao", "develop", "--toggle", "x", "--enabled", "false"], now).kind, "error");
    assert.equal(parseDriftCli([...base, "--sessao", "develop", "--toggle", "clarice-envio-enabled", "--enabled", "no"], now).kind, "error");
    assert.equal(parseDriftCli([...base, "--sessao", "nada", "--toggle", "clarice-envio-enabled", "--enabled", "false"], now).kind, "error");
  });
});

describe("decisionDriftReportLines fail-soft no leitor de toggle (#10142)", () => {
  it("exceção do leitor vira linha de aviso, nunca derruba o relatório (roda antes do kill switch)", () => {
    const lines = decisionDriftReportLines(
      () => ({ ok: true, issues: [{ number: 8099, commentBodies: [formatDecisionMarker(PAUSA)] }] }),
      () => {
        throw new Error("EACCES");
      },
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /NÃO rodou: leitura do toggle falhou \(EACCES\)/);
  });
});
