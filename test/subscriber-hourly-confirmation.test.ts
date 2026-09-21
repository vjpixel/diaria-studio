import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildReportOutput, loadHourlyObservations } from "../scripts/subscriber-confirmation-report.ts";
import {
  buildHourlyConfirmationReport,
  hourlyObservationFileName,
  parseHourlyObservationFileName,
  filterRecent,
  type HourlyObservation,
} from "../scripts/lib/subscriber-hourly-confirmation.ts";

const T0 = Date.parse("2026-09-21T10:00:00Z");
const at = (h: number) => new Date(T0 + h * 3_600_000);
const created = (minAfterT0: number) => new Date(T0 + minAfterT0 * 60_000).toISOString();

describe("hourly confirmation (#8552 b)", () => {
  it("file name roundtrip", () => {
    const d = new Date("2026-09-21T14:05:33Z");
    const n = hourlyObservationFileName(d);
    assert.equal(n, "2026-09-21T1405Z.jsonl");
    assert.equal(parseHourlyObservationFileName(n)?.toISOString(), "2026-09-21T14:05:00.000Z");
    assert.equal(parseHourlyObservationFileName("x.jsonl"), null);
  });

  it("filterRecent mantém só created_at dentro do lookback", () => {
    const now = at(100);
    const out = filterRecent(
      [
        { id: 1, state: "inactive", created_at: at(99).toISOString() },
        { id: 2, state: "inactive", created_at: at(10).toISOString() },
      ],
      now,
      48,
    );
    assert.deepEqual(out.map((r) => r.id), [1]);
  });

  it("taxa 1h/6h e p50 a partir de observações horárias", () => {
    // a: confirma na obs de +2h; b: nunca; c: já active na 1ª obs (fora).
    const mk = (state: (id: string) => string): HourlyObservation["records"] => [
      { id: 1, state: state("a"), created_at: created(0) },
      { id: 2, state: state("b"), created_at: created(0) },
      { id: 3, state: "active", created_at: created(0) },
    ];
    const obs: HourlyObservation[] = [
      { at: at(0.5), records: mk(() => "inactive") },
      { at: at(1.5), records: mk(() => "inactive") },
      { at: at(2.5), records: mk((k) => (k === "a" ? "active" : "inactive")) },
      { at: at(7), records: mk((k) => (k === "a" ? "active" : "inactive")) },
    ];
    const r = buildHourlyConfirmationReport(obs);
    assert.equal(r.membros, 2);
    assert.equal(r.fora_de_escopo, 1);
    const w1 = r.janelas.find((w) => w.horas === 1)!;
    // 1ª obs >= created+1h é a de 1.5h: ninguém active ainda.
    assert.equal(w1.maduros, 2);
    assert.equal(w1.confirmados, 0);
    const w6 = r.janelas.find((w) => w.horas === 6)!;
    assert.equal(w6.confirmados, 1);
    assert.equal(w6.taxa, 0.5);
    const w24 = r.janelas.find((w) => w.horas === 24)!;
    assert.equal(w24.maduros, 0);
    assert.equal(w24.taxa, null);
    assert.equal(r.horas_ate_confirmar.confirmados, 1);
    assert.equal(r.horas_ate_confirmar.p50, 2.5);
  });

  it("1ª observação tardia demais tira o membro do escopo; sem observações avisa", () => {
    const r = buildHourlyConfirmationReport([
      { at: at(10), records: [{ id: 1, state: "inactive", created_at: created(0) }] },
      { at: at(11), records: [{ id: 1, state: "active", created_at: created(0) }] },
    ]);
    assert.equal(r.membros, 0);
    assert.equal(r.fora_de_escopo, 1);
    assert.match(buildHourlyConfirmationReport([]).avisos[0], /nenhuma observação/);
  });
});

describe("piso horário e CLI do relatório (#8552 b)", () => {
  it("confirmação entre a última obs <= W e o limite NÃO conta (piso, sem viés pra cima)", () => {
    // ativa só na obs de +1.5h; janela 1h => última obs <= 1h é a de +0.5h (inactive).
    const r = buildHourlyConfirmationReport([
      { at: at(0.5), records: [{ id: 1, state: "inactive", created_at: created(0) }] },
      { at: at(1.5), records: [{ id: 1, state: "active", created_at: created(0) }] },
    ]);
    const w1 = r.janelas.find((w) => w.horas === 1)!;
    assert.equal(w1.maduros, 1);
    assert.equal(w1.confirmados, 0);
    assert.match(r.avisos.join(" "), /PISO/);
  });

  it("buildReportOutput lê kit-recent/*.jsonl e renderiza a seção horária (text e json)", () => {
    const base = mkdtempSync(resolve(tmpdir(), "hourly-cli-"));
    const daily = resolve(base, "kit");
    const recent = resolve(base, "kit-recent");
    mkdirSync(daily, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const line = (state: string) => JSON.stringify({ id: 1, state, created_at: created(0) }) + String.fromCharCode(10);
    writeFileSync(resolve(recent, hourlyObservationFileName(at(0.5))), line("inactive"));
    writeFileSync(resolve(recent, hourlyObservationFileName(at(2.5))), line("active"));
    writeFileSync(resolve(recent, "lixo.txt"), "x");
    assert.equal(loadHourlyObservations(recent).length, 2);
    const text = buildReportOutput(daily, recent, { format: "text" });
    assert.match(text, /Confirmação em horas/);
    assert.match(text, /observações: 2, membros: 1/);
    const json = JSON.parse(buildReportOutput(daily, recent, { format: "json" }));
    assert.equal(json.horario.membros, 1);
    assert.equal(loadHourlyObservations(resolve(base, "nao-existe")).length, 0);
  });
});
