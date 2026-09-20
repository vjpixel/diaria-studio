import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  addDays,
  diffDays,
  buildConfirmationReport,
  renderConfirmationReportText,
  CONFIRMOU_VIA_NONE_LABEL,
  CANAL_UNKNOWN_LABEL,
} from "../scripts/lib/subscriber-confirmation-report.ts";
import {
  parseSubscriberStateJsonl,
  serializeSubscriberStateRecords,
  snapshotJsonlPath,
  type SubscriberStateRecord,
} from "../scripts/lib/subscriber-state-snapshot.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

/** created_at ao meio-dia BRT do dia (UTC-3) — nunca vira o dia por fuso. */
const at = (day: string): string => `${day}T15:00:00.000Z`;

function snap(entries: Array<[string, SubscriberStateRecord[]]>): Map<string, SubscriberStateRecord[]> {
  return new Map(entries);
}

describe("aritmética de datas", () => {
  it("addDays/diffDays atravessam mês e ano", () => {
    assert.equal(addDays("2026-09-30", 1), "2026-10-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(diffDays("2026-09-01", "2026-10-01"), 30);
  });
});

describe("buildConfirmationReport — coorte e janelas", () => {
  // Coorte 2026-09-01: 4 inactive. #1 confirma em D+1, #2 em D+5, #3 em D+20, #4 nunca.
  const c = (id: number, state: string, extra: Partial<SubscriberStateRecord> = {}): SubscriberStateRecord => ({
    id,
    state,
    created_at: at("2026-09-01"),
    ...extra,
  });
  const snapshots = snap([
    ["2026-09-01", [c(1, "inactive"), c(2, "inactive"), c(3, "inactive"), c(4, "inactive")]],
    ["2026-09-02", [c(1, "active"), c(2, "inactive"), c(3, "inactive"), c(4, "inactive")]],
    ["2026-09-06", [c(1, "active"), c(2, "active"), c(3, "inactive"), c(4, "inactive")]],
    ["2026-09-21", [c(1, "active"), c(2, "active"), c(3, "active"), c(4, "inactive")]],
    ["2026-10-01", [c(1, "active"), c(2, "active"), c(3, "active"), c(4, "inactive")]],
  ]);

  it("calcula taxa 24h/7d/30d sobre a coorte madura", () => {
    const r = buildConfirmationReport(snapshots);
    assert.equal(r.as_of, "2026-10-01");
    assert.equal(r.total.n, 4);
    assert.deepEqual(
      [r.total.janelas["24h"].confirmados, r.total.janelas["24h"].maduros, r.total.janelas["24h"].taxa],
      [1, 4, 0.25],
    );
    assert.equal(r.total.janelas["7d"].confirmados, 2);
    assert.equal(r.total.janelas["7d"].taxa, 0.5);
    assert.equal(r.total.janelas["30d"].confirmados, 3);
    assert.equal(r.total.janelas["30d"].taxa, 0.75);
  });

  it("janela 1h nunca é resolvível (granularidade diária) e não inventa número", () => {
    const r = buildConfirmationReport(snapshots);
    const w = r.total.janelas["1h"];
    assert.equal(w.resolvivel, false);
    assert.equal(w.taxa, null);
    assert.match(w.motivo!, /diários/);
  });

  it("distribuição de tempo até confirmar + percentis", () => {
    const t = buildConfirmationReport(snapshots).total.tempo_ate_confirmar;
    // #1 -> 1d, #2 -> 5d, #3 -> 20d
    assert.equal(t.confirmados, 3);
    assert.deepEqual(t.buckets, { "1d": 1, "2d": 0, "3-7d": 1, "8-30d": 1, ">30d": 0 });
    assert.equal(t.p50_dias, 5);
    assert.equal(t.p90_dias, 20);
  });

  it("coorte imatura não entra no denominador da janela ainda aberta", () => {
    // as_of = 2026-09-06: 30d e 7d ainda não maturaram pra coorte de 09-01 (7d matura em 09-08).
    const parcial = snap([...snapshots].filter(([d]) => d <= "2026-09-06"));
    const r = buildConfirmationReport(parcial);
    assert.equal(r.total.janelas["24h"].maduros, 4);
    assert.equal(r.total.janelas["7d"].maduros, 0);
    assert.equal(r.total.janelas["7d"].taxa, null);
    assert.equal(r.total.janelas["30d"].maduros, 0);
  });
});

describe("buildConfirmationReport — ambíguos e fora de escopo", () => {
  it("quem já aparece active no 1º snapshot é ambíguo, fora de toda taxa", () => {
    const r = buildConfirmationReport(
      snap([
        ["2026-09-01", [
          { id: 1, state: "inactive", created_at: at("2026-09-01") },
          { id: 2, state: "active", created_at: at("2026-09-01") },
        ]],
        ["2026-09-03", [
          { id: 1, state: "active", created_at: at("2026-09-01") },
          { id: 2, state: "active", created_at: at("2026-09-01") },
        ]],
      ]),
    );
    assert.equal(r.total.n, 1);
    assert.equal(r.ambiguos, 1);
    assert.ok(r.avisos.some((a) => /active no 1º snapshot/.test(a)));
  });

  it("assinante anterior ao 1º snapshot da série fica fora de escopo (estado de criação inobservável)", () => {
    const r = buildConfirmationReport(
      snap([
        ["2026-09-10", [{ id: 1, state: "inactive", created_at: at("2026-08-01") }]],
        ["2026-09-11", [{ id: 1, state: "active", created_at: at("2026-08-01") }]],
      ]),
    );
    assert.equal(r.total.n, 0);
    assert.equal(r.fora_de_escopo, 1);
  });

  it("--since/--until filtram por dia de cadastro (BRT)", () => {
    const s = snap([
      ["2026-09-01", [{ id: 1, state: "inactive", created_at: at("2026-09-01") }]],
      ["2026-09-02", [
        { id: 1, state: "active", created_at: at("2026-09-01") },
        { id: 2, state: "inactive", created_at: at("2026-09-02") },
      ]],
      ["2026-09-04", [
        { id: 1, state: "active", created_at: at("2026-09-01") },
        { id: 2, state: "active", created_at: at("2026-09-02") },
      ]],
    ]);
    assert.equal(buildConfirmationReport(s, { since: "2026-09-02" }).total.n, 1);
    assert.equal(buildConfirmationReport(s, { until: "2026-09-01" }).total.n, 1);
    assert.equal(buildConfirmationReport(s).total.n, 2);
  });

  it("created_at às 23:30 BRT usa o dia BRT, não o dia UTC", () => {
    const s = snap([
      // 2026-09-02T02:30Z == 2026-09-01 23:30 BRT
      ["2026-09-01", [{ id: 1, state: "inactive", created_at: "2026-09-02T02:30:00.000Z" }]],
      ["2026-09-03", [{ id: 1, state: "active", created_at: "2026-09-02T02:30:00.000Z" }]],
    ]);
    const r = buildConfirmationReport(s);
    assert.deepEqual(Object.keys(r.por_coorte), ["2026-09-01"]);
  });

  it("sem snapshots: relatório vazio com aviso, sem lançar", () => {
    const r = buildConfirmationReport(new Map());
    assert.equal(r.as_of, null);
    assert.equal(r.total.n, 0);
    assert.ok(r.avisos.length > 0);
  });
});

describe("buildConfirmationReport — separação por confirmou_via e canal", () => {
  const mk = (id: number, state: string, extra: Partial<SubscriberStateRecord> = {}): SubscriberStateRecord => ({
    id,
    state,
    created_at: at("2026-09-01"),
    ...extra,
  });

  it("separa Kit (sem via) de Brevo (brevo-reativar) e por origem_cadastro", () => {
    const s = snap([
      ["2026-09-01", [mk(1, "inactive"), mk(2, "inactive"), mk(3, "inactive"), mk(4, "inactive", { origem: "kit-nativo" })]],
      // confirmou_via/origem só aparecem depois do clique (lag de fields no Kit)
      ["2026-09-02", [
        mk(1, "active", { confirmou_via: "brevo-reativar", origem: "google-ads" }),
        mk(2, "active", { origem: "google-ads" }),
        mk(3, "inactive"),
        mk(4, "inactive", { origem: "kit-nativo" }),
      ]],
    ]);
    const r = buildConfirmationReport(s);
    assert.deepEqual(Object.keys(r.por_confirmou_via).sort(), [CONFIRMOU_VIA_NONE_LABEL, "Brevo (botão reativar)"].sort());
    assert.equal(r.por_confirmou_via["Brevo (botão reativar)"].n, 1);
    assert.equal(r.por_confirmou_via["Brevo (botão reativar)"].janelas["24h"].taxa, 1);
    assert.equal(r.por_confirmou_via[CONFIRMOU_VIA_NONE_LABEL].n, 3);
    assert.equal(r.por_confirmou_via[CONFIRMOU_VIA_NONE_LABEL].janelas["24h"].taxa, 1 / 3);
    assert.equal(r.por_canal["google-ads"].n, 2);
    assert.equal(r.por_canal["kit-nativo"].n, 1);
    assert.equal(r.por_canal[CANAL_UNKNOWN_LABEL].n, 1);
  });

  it("valor de confirmou_via desconhecido aparece cru, não some", () => {
    const s = snap([
      ["2026-09-01", [mk(1, "inactive")]],
      ["2026-09-02", [mk(1, "active", { confirmou_via: "outro-caminho" })]],
    ]);
    assert.deepEqual(Object.keys(buildConfirmationReport(s).por_confirmou_via), ["outro-caminho"]);
  });
});

describe("render texto", () => {
  it("imprime seções, n/d pra 1h e o aviso de ambíguos", () => {
    const s = snap([
      ["2026-09-01", [
        { id: 1, state: "inactive", created_at: at("2026-09-01") },
        { id: 2, state: "active", created_at: at("2026-09-01") },
      ]],
      ["2026-09-02", [
        { id: 1, state: "active", created_at: at("2026-09-01") },
        { id: 2, state: "active", created_at: at("2026-09-01") },
      ]],
    ]);
    const txt = renderConfirmationReportText(buildConfirmationReport(s));
    assert.match(txt, /POR CONFIRMOU_VIA/);
    assert.match(txt, /POR CANAL/);
    assert.match(txt, /POR COORTE/);
    assert.match(txt, /1h n\/d/);
    assert.match(txt, /AVISO: 1 assinante/);
  });
});

describe("snapshot: campos opcionais confirmou_via/origem", () => {
  it("round-trip preserva os opcionais e snapshots antigos (3 campos) continuam parseando", () => {
    const recs: SubscriberStateRecord[] = [
      { id: 1, state: "active", created_at: at("2026-09-01"), confirmou_via: "brevo-reativar", origem: "kit-nativo" },
      { id: 2, state: "inactive", created_at: at("2026-09-01") },
    ];
    const parsed = parseSubscriberStateJsonl(serializeSubscriberStateRecords(recs));
    assert.deepEqual(parsed, recs);
    assert.equal("confirmou_via" in parsed[1], false);
  });
});

describe("registro da task agendada (#8552)", () => {
  it("Diaria-Subscriber-State-Snapshot aponta pro script, diária 23:55, sem colisão de horário", () => {
    const t = SCHEDULED_TASKS.find((x) => x.name === "Diaria-Subscriber-State-Snapshot");
    assert.ok(t, "task ausente do registro");
    assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/subscriber-state-snapshot.ts"]);
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 23, minute: 55 });
    assert.equal(t!.issue, "#8552");
    const colisoes = SCHEDULED_TASKS.filter(
      (x) => x.name !== t!.name && x.schedule.kind === "daily" && x.schedule.hour === 23 && x.schedule.minute === 55,
    );
    assert.deepEqual(colisoes, []);
  });
});

describe("CLI scripts/subscriber-confirmation-report.ts", () => {
  const cli = resolve(import.meta.dirname, "..", "scripts", "subscriber-confirmation-report.ts");
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8" });

  function writeSnap(root: string, date: string, recs: SubscriberStateRecord[]): void {
    mkdirSync(resolve(root, date), { recursive: true });
    writeFileSync(snapshotJsonlPath(root, date), serializeSubscriberStateRecords(recs));
  }

  it("--format json lê snapshots do --root e emite o relatório", () => {
    const root = mkdtempSync(resolve(tmpdir(), "conf-report-"));
    writeSnap(root, "2026-09-01", [{ id: 1, state: "inactive", created_at: at("2026-09-01") }]);
    writeSnap(root, "2026-09-02", [{ id: 1, state: "active", created_at: at("2026-09-01") }]);
    const res = run(["--root", root, "--format", "json"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.total.n, 1);
    assert.equal(out.total.janelas["24h"].taxa, 1);
  });

  it("--root vazio: sai 0 com aviso; data inválida: exit 2", () => {
    const root = mkdtempSync(resolve(tmpdir(), "conf-report-empty-"));
    const ok = run(["--root", root]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /nenhum snapshot/);
    const bad = run(["--root", root, "--since", "ontem"]);
    assert.equal(bad.status, 2);
  });
});
