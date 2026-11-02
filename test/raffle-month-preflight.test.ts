/**
 * test/raffle-month-preflight.test.ts (#11896)
 *
 * Regressão: na 261103 (1ª edição de novembro) o Stage 3 parou porque
 * `raffle.sorteio_do_mes.mes` ainda era "2026-10". O preflight do Stage 0
 * tem que (a) reconhecer exatamente esse caso e (b) avisar dias antes da
 * virada, nas últimas edições do mês anterior.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assessRaffleMonth, describeRaffleMonthVerdict } from "../scripts/lib/raffle-month-preflight.ts";

const raffle = (mes: string) => ({ sorteio_do_mes: { mes, dia: 4 } });

describe("assessRaffleMonth (#11896)", () => {
  it("cenário real da 261103: 1ª edição de novembro com mes=2026-10 → current-month-stale", () => {
    const v = assessRaffleMonth({ edition: "261103", raffle: raffle("2026-10"), isFirstOfMonth: true });
    assert.equal(v.kind, "current-month-stale");
    assert.match(describeRaffleMonthVerdict(v) ?? "", /"mes": "2026-11"/);
  });

  it("1ª edição do mês com o mês certo → ok", () => {
    const v = assessRaffleMonth({ edition: "261103", raffle: raffle("2026-11"), isFirstOfMonth: true });
    assert.equal(v.kind, "ok");
    assert.equal(describeRaffleMonthVerdict(v), null);
  });

  it("últimos dias de outubro com mes=2026-10 → upcoming-month-stale apontando 2026-11", () => {
    const v = assessRaffleMonth({ edition: "261030", raffle: raffle("2026-10"), isFirstOfMonth: false });
    assert.equal(v.kind, "upcoming-month-stale");
    if (v.kind !== "upcoming-month-stale") return;
    assert.equal(v.nextMes, "2026-11");
    assert.equal(v.daysUntilNextMonth, 2);
  });

  it("janela default de 5 dias cobre a sexta antes de uma virada numa segunda (261127 → dez)", () => {
    const v = assessRaffleMonth({ edition: "261127", raffle: raffle("2026-11"), isFirstOfMonth: false });
    assert.equal(v.kind, "upcoming-month-stale");
  });

  it("fora da janela → ok mesmo com o mês corrente", () => {
    const v = assessRaffleMonth({ edition: "261015", raffle: raffle("2026-10"), isFirstOfMonth: false });
    assert.equal(v.kind, "ok");
  });

  it("editor já atualizou para o mês seguinte → ok", () => {
    const v = assessRaffleMonth({ edition: "261030", raffle: raffle("2026-11"), isFirstOfMonth: false });
    assert.equal(v.kind, "ok");
  });

  it("virada de ano: dezembro → janeiro do ano seguinte", () => {
    const v = assessRaffleMonth({ edition: "261230", raffle: raffle("2026-12"), isFirstOfMonth: false });
    assert.equal(v.kind, "upcoming-month-stale");
    if (v.kind === "upcoming-month-stale") assert.equal(v.nextMes, "2027-01");
  });

  it("leadDays custom estreita a janela", () => {
    const v = assessRaffleMonth({ edition: "261127", raffle: raffle("2026-11"), isFirstOfMonth: false, leadDays: 3 });
    assert.equal(v.kind, "ok");
  });

  it("sem bloco raffle → no-raffle-config; edição inválida → invalid-edition", () => {
    assert.equal(assessRaffleMonth({ edition: "261103", raffle: undefined, isFirstOfMonth: true }).kind, "no-raffle-config");
    assert.equal(assessRaffleMonth({ edition: "261399", raffle: raffle("2026-11"), isFirstOfMonth: true }).kind, "invalid-edition");
  });

  it("sorteio_do_mes ausente na 1ª edição → current-month-stale", () => {
    const v = assessRaffleMonth({ edition: "261103", raffle: {}, isFirstOfMonth: true });
    assert.equal(v.kind, "current-month-stale");
  });
});

describe("check-raffle-month.ts CLI (#11896)", () => {
  const root = resolve(import.meta.dirname, "..");
  function run(edition: string, mes: string, published: string[]): Record<string, unknown> {
    const dir = mkdtempSync(join(tmpdir(), "raffle-month-"));
    const cfg = join(dir, "platform.config.json");
    const past = join(dir, "past.json");
    writeFileSync(cfg, JSON.stringify({ raffle: raffle(mes) }));
    writeFileSync(past, JSON.stringify(published.map((p) => ({ published_at: p }))));
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", join(root, "scripts", "check-raffle-month.ts"), "--edition", edition, "--platform-config", cfg, "--past-editions", past],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out.trim()) as Record<string, unknown>;
  }

  it("261103 sem edição de novembro publicada e mes=2026-10 → current-month-stale", () => {
    const v = run("261103", "2026-10", ["2026-10-30T09:00:00Z"]);
    assert.equal(v.kind, "current-month-stale");
  });

  it("edição de novembro já publicada antes → não é a 1ª do mês, fora da janela → ok", () => {
    const v = run("261110", "2026-10", ["2026-11-03T09:00:00Z"]);
    assert.equal(v.kind, "ok");
  });
});
