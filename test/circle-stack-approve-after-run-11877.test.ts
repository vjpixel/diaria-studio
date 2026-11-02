/**
 * Regressão #11877: na segunda X, a task das 06:00 roda (Publicado ou "Não
 * enviado") e o timer não roda de novo. `/diaria-stack` às 10h dessa segunda
 * caía na própria segunda e o `--approve` passava no guard do #11868 (que só
 * recusava segunda anterior a hoje): a aprovação ficava gravada sem
 * consumidor e o editor achava que o post sairia. Hora fixada em todos os
 * casos (relógio local, o mesmo de `formatAAMMDD`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCircleStackCycle, resolveCyclePaths, runScheduledCircleStack } from "../scripts/publish-circle-stack-scheduled.ts";
import { resolveSkillDefaultMonday } from "../scripts/publish-circle-stack.ts";
import { isCircleStackScheduledRunPast } from "../scripts/lib/circle-stack-schedule.ts";
import { resolveWeeklyLinkedinCycle } from "../scripts/lib/weekly-linkedin-cycle.ts";

const MONDAY = "261109";
const mondayAt = (h: number, m = 0) => () => new Date(2026, 10, 9, h, m, 0);

function setupCycle(dataRoot: string, publishMonday: string) {
  const paths = resolveCyclePaths(dataRoot, publishMonday);
  mkdirSync(join(paths.selectionPath, ".."), { recursive: true });
  writeFileSync(
    paths.selectionPath,
    JSON.stringify({
      cycle: resolveWeeklyLinkedinCycle(publishMonday)!.cycle,
      contentWindow: [],
      weeklyEditions: [],
      destaques: [],
      lancamentos: [],
      useMelhor: [],
      radar: [
        {
          editionDate: "261104",
          url: "https://exemplo.com.br/noticia",
          title: "Novo modelo chega para todos os usuários",
          body: "corpo",
          why: "porque",
        },
      ],
    }),
  );
  return paths;
}

describe("Stack: aprovação na segunda depois do envio das 06:00 (#11877)", () => {
  it("isCircleStackScheduledRunPast: só a partir das 06:00 da própria segunda", () => {
    assert.equal(isCircleStackScheduledRunPast(mondayAt(5, 59)(), MONDAY), false);
    assert.equal(isCircleStackScheduledRunPast(mondayAt(6, 0)(), MONDAY), true);
    assert.equal(isCircleStackScheduledRunPast(new Date(2026, 10, 8, 23, 0), MONDAY), false); // domingo
    assert.equal(isCircleStackScheduledRunPast(new Date(2026, 10, 10, 1, 0), MONDAY), true); // terça
  });

  it("approveCircleStackCycle recusa a segunda de hoje às 10:00, aponta o envio manual e não grava aprovação", () => {
    const paths = setupCycle(mkdtempSync(join(tmpdir(), "circle-stack-11877-")), MONDAY);
    assert.throws(() => approveCircleStackCycle(paths, mondayAt(10)()), /já rodou[\s\S]*--publish-monday 261109 --publish/);
    assert.equal(existsSync(paths.approvalPath), false);
  });

  it("--approve sem data às 10:00 da segunda (mira a própria segunda) sai com erro", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-11877-"));
    const paths = setupCycle(dataRoot, MONDAY);
    await assert.rejects(
      runScheduledCircleStack(["--approve", "--data-root", dataRoot], { rootDir: dataRoot, platformConfig: {}, env: {}, now: mondayAt(10) }),
      /já rodou/,
    );
    assert.equal(existsSync(paths.approvalPath), false);
  });

  it("às 05:59 da segunda a aprovação ainda é aceita (a execução das 06:00 vai consumi-la)", () => {
    const paths = setupCycle(mkdtempSync(join(tmpdir(), "circle-stack-11877-")), MONDAY);
    approveCircleStackCycle(paths, mondayAt(5, 59)());
    assert.equal(existsSync(paths.approvalPath), true);
  });

  it("data padrão da skill às 10:00 da segunda marca scheduledRunPast e diz que só --publish envia", () => {
    const r = resolveSkillDefaultMonday(mondayAt(10)(), () => "draft");
    assert.equal(r.publishMonday, MONDAY);
    assert.equal(r.scheduledRunPast, true);
    assert.match(r.banner, /já rodou[\s\S]*--publish/);
  });

  it("data padrão da skill antes das 06:00 da segunda segue aprovável (scheduledRunPast false)", () => {
    const r = resolveSkillDefaultMonday(mondayAt(5)(), () => "draft");
    assert.equal(r.publishMonday, MONDAY);
    assert.equal(r.scheduledRunPast, false);
    assert.doesNotMatch(r.banner, /já rodou/);
  });

  it("no fim de semana a data avançada nunca vem com scheduledRunPast", () => {
    const r = resolveSkillDefaultMonday(new Date(2026, 10, 7, 15), () => "draft");
    assert.equal(r.publishMonday, MONDAY);
    assert.equal(r.scheduledRunPast, false);
  });
});
