/**
 * test/doi-confirmacao-1h-canal-8548.test.ts — regressão #8548 (decisão do
 * editor 28/10/2026: medir a confirmação DOI por coorte e por canal em
 * 1h/24h/7d/30d).
 *
 * Dois buracos fechados:
 * 1. A task horária `Diaria-Subscriber-State-Snapshot-Recent` estava
 *    `enabled: false` desde o #8552 b. `setup-systemd-timers.ts` filtra por
 *    `enabled !== false`, então ela nunca gerou unit, `kit-recent/` nunca
 *    existiu e a janela de 1h do relatório saía `n/d` para sempre.
 * 2. A seção horária do relatório só tinha o total: nem canal pago nem
 *    coorte, as duas dimensões que o editor pediu.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getScheduledTaskByName, type ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";
import { generateSystemdUnits } from "../scripts/setup-systemd-timers.ts";
import {
  buildHourlyConfirmationReport,
  renderHourlyConfirmationText,
  type HourlyObservation,
} from "../scripts/lib/subscriber-hourly-confirmation.ts";
import { resolveCanalPago } from "../scripts/lib/subscriber-confirmation-report.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TASK = "Diaria-Subscriber-State-Snapshot-Recent";

describe("#8548 — observação horária armada", () => {
  it("a task horária existe e NÃO está desarmada", () => {
    const t = getScheduledTaskByName(TASK);
    assert.ok(t, `${TASK} sumiu do registro`);
    assert.notEqual(t.enabled, false, `${TASK} voltou a enabled:false — a janela de 1h volta a n/d para sempre (#8548)`);
    assert.deepEqual(t.schedule, { kind: "interval", hours: 1 });
    assert.deepEqual(t.steps.map((s) => [s.script, s.args]), [["scripts/subscriber-state-snapshot.ts", ["--recent"]]]);
  });

  it("gera de fato o par .service/.timer — o filtro de enabled deixa ela passar", () => {
    const t = getScheduledTaskByName(TASK);
    assert.ok(t);
    const out = mkdtempSync(join(tmpdir(), "diaria-8548-units-"));
    try {
      const armadas = [t].filter((x: ScheduledTaskDefinition) => x.enabled !== false);
      const written = generateSystemdUnits(armadas, ROOT, out);
      assert.equal(written.length, 2, "esperava 1 .service + 1 .timer");
      assert.deepEqual(readdirSync(out).sort(), [
        "diaria-subscriber-state-snapshot-recent.service",
        "diaria-subscriber-state-snapshot-recent.timer",
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

const T0 = Date.parse("2026-10-28T13:00:00Z"); // 10:00 BRT
const at = (h: number) => new Date(T0 + h * 3_600_000);
const iso = (h: number) => at(h).toISOString();

describe("#8548 — confirmação em horas por canal pago e por coorte", () => {
  // 1 google (confirma em ~1,5h), 1 meta (nunca), 1 com utm vazio no
  // nascimento (orgânico, confirma em ~0,5h), 1 sem utm no record mas no
  // store como meta-ads (confirma em ~2,5h), 1 de outro dia BRT (orgânico).
  const rec = (id: number, state: string, createdH: number, utm?: string) =>
    utm === undefined ? { id, state, created_at: iso(createdH) } : { id, state, created_at: iso(createdH), utm_source: utm };
  const snap = (h: number, active: Set<number>) => ({
    at: at(h),
    records: [
      rec(1, active.has(1) ? "active" : "inactive", 0, "google-ads"),
      rec(2, active.has(2) ? "active" : "inactive", 0, "meta-ads"),
      rec(3, active.has(3) ? "active" : "inactive", 0, ""),
      rec(4, active.has(4) ? "active" : "inactive", 0),
      rec(5, "inactive", 14, ""), // 14h depois de 10:00 BRT = 00:00 BRT do dia seguinte
    ].filter((r) => Date.parse(r.created_at) <= at(h).getTime()),
  });
  const obs: HourlyObservation[] = [
    snap(0.25, new Set()),
    snap(1, new Set([3])),
    snap(2, new Set([1, 3])),
    snap(3, new Set([1, 3, 4])),
    snap(14.5, new Set([1, 3, 4])),
    snap(30, new Set([1, 3, 4])),
    snap(40, new Set([1, 3, 4])),
  ];
  const store = new Map<number, string | null>([[4, "meta-ads"]]);

  it("separa por canal pago com a precedência do relatório diário (store preenche quem não tem utm no record)", () => {
    const r = buildHourlyConfirmationReport(obs, { utmSourceByKitId: store });
    assert.equal(r.membros, 5);
    assert.deepEqual(Object.keys(r.por_canal_pago).sort(), ["google-ads", "meta-ads", "orgânico"]);
    const meta = r.por_canal_pago["meta-ads"];
    assert.equal(meta.membros, 2);
    const meta6 = meta.janelas.find((w) => w.horas === 6)!;
    assert.deepEqual([meta6.confirmados, meta6.maduros], [1, 2]);
    const g1 = r.por_canal_pago["google-ads"].janelas.find((w) => w.horas === 1)!;
    assert.deepEqual([g1.confirmados, g1.maduros], [0, 1], "google confirmou depois de 1h");
    const org1 = r.por_canal_pago["orgânico"].janelas.find((w) => w.horas === 1)!;
    assert.deepEqual([org1.confirmados, org1.maduros], [1, 2], "id 3 confirmou em 1h, id 5 não");
    assert.equal(r.por_canal_pago["google-ads"].horas_ate_confirmar.p50, 2);
  });

  it("sem store, quem não tem utm em nenhuma fonte vai pra desconhecido, nunca orgânico", () => {
    const r = buildHourlyConfirmationReport(obs);
    assert.ok(r.por_canal_pago["(utm_source desconhecido)"]);
    assert.equal(r.por_canal_pago["(utm_source desconhecido)"].membros, 1);
    assert.equal(r.por_canal_pago["orgânico"].membros, 2);
  });

  it("separa por coorte de cadastro em dia BRT", () => {
    const r = buildHourlyConfirmationReport(obs, { utmSourceByKitId: store });
    assert.deepEqual(Object.keys(r.por_coorte), ["2026-10-28", "2026-10-29"]);
    assert.equal(r.por_coorte["2026-10-28"].membros, 4);
    assert.equal(r.por_coorte["2026-10-29"].membros, 1);
    const d1 = r.por_coorte["2026-10-28"].janelas.find((w) => w.horas === 1)!;
    assert.deepEqual([d1.confirmados, d1.maduros], [1, 4]);
  });

  it("total continua igual à soma dos grupos", () => {
    const r = buildHourlyConfirmationReport(obs, { utmSourceByKitId: store });
    for (const h of [1, 6, 24]) {
      const tot = r.janelas.find((w) => w.horas === h)!;
      const soma = Object.values(r.por_canal_pago).reduce((a, g) => a + g.janelas.find((w) => w.horas === h)!.maduros, 0);
      assert.equal(soma, tot.maduros, `maduros em ${h}h`);
    }
  });

  it("o texto lista os grupos; sem observações, nenhum grupo aparece", () => {
    const text = renderHourlyConfirmationText(buildHourlyConfirmationReport(obs, { utmSourceByKitId: store }));
    assert.match(text, /por canal pago \(utm_source, #8548\):/);
    assert.match(text, /meta-ads\s+membros=2/);
    assert.match(text, /por coorte de cadastro \(dia BRT\):/);
    const vazio = renderHourlyConfirmationText(buildHourlyConfirmationReport([]));
    assert.doesNotMatch(vazio, /por canal pago/);
  });
});

describe("#8548 — resolveCanalPago (fonte única diário/horário)", () => {
  const src = (utmAtBirth: string | null, utmBirthEmpty: boolean, utmLater: string | null) => ({
    utmAtBirth,
    utmBirthEmpty,
    utmLater,
  });
  it("nascimento > store > posterior > nascimento vazio > desconhecido", () => {
    const store = new Map<number, string | null>([[1, "meta-ads"]]);
    assert.deepEqual(resolveCanalPago(1, src("google-ads", false, null), store), { canal: "google-ads", fonte: "snapshot" });
    assert.deepEqual(resolveCanalPago(1, src(null, true, "google-ads"), store), { canal: "meta-ads", fonte: "store" });
    assert.deepEqual(resolveCanalPago(2, src(null, true, "google-ads"), store), { canal: "google-ads", fonte: "snapshot" });
    assert.deepEqual(resolveCanalPago(2, src(null, true, null), store), { canal: "orgânico", fonte: "snapshot" });
    assert.deepEqual(resolveCanalPago(2, src(null, false, null), store), {
      canal: "(utm_source desconhecido)",
      fonte: "desconhecido",
    });
  });
});
