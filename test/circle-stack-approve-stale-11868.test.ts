/**
 * Regressão #11868: na semana X a task de segunda manda "Não enviado" (sem
 * aprovação) e o ciclo fica `draft`. No sábado seguinte, `/diaria-stack` sem
 * data caía na segunda X (já vencida) e o Passo 6 gravava a aprovação com
 * sucesso; na segunda X+7 a task procurava o ciclo X+7, não achava aprovação e
 * mandava "Não enviado" de novo. O editor achava que tinha aprovado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCircleStackCycle, resolveCyclePaths, runScheduledCircleStack } from "../scripts/publish-circle-stack-scheduled.ts";
import { resolveSkillDefaultMonday } from "../scripts/publish-circle-stack.ts";
import { resolveWeeklyLinkedinCycle } from "../scripts/lib/weekly-linkedin-cycle.ts";

const WEEK_X = "261102"; // segunda X: a task mandou "Não enviado", ciclo ficou draft
const WEEK_X7 = "261109";
const saturdayAfterX = () => new Date(2026, 10, 7, 15, 0, 0);

function selectionFor(publishMonday: string): string {
  const cycle = resolveWeeklyLinkedinCycle(publishMonday)!.cycle;
  return JSON.stringify({
    cycle,
    contentWindow: [],
    weeklyEditions: [],
    destaques: [],
    lancamentos: [],
    useMelhor: [],
    radar: [
      {
        editionDate: "261103",
        url: "https://exemplo.com.br/noticia",
        title: "Novo modelo chega para todos os usuários",
        body: "corpo",
        why: "porque",
      },
    ],
  });
}

function setupCycle(dataRoot: string, publishMonday: string) {
  const paths = resolveCyclePaths(dataRoot, publishMonday);
  mkdirSync(join(paths.selectionPath, ".."), { recursive: true });
  writeFileSync(paths.selectionPath, selectionFor(publishMonday));
  return paths;
}

describe("Stack: aprovação de ciclo vencido no fim de semana (#11868)", () => {
  it("sábado depois da semana X sem envio: a data padrão da skill é X+7, não X", () => {
    const r = resolveSkillDefaultMonday(saturdayAfterX(), () => "draft");
    assert.equal(r.baseMonday, WEEK_X);
    assert.equal(r.publishMonday, WEEK_X7);
    assert.equal(r.advanced, true);
  });

  it("approveCircleStackCycle recusa a segunda X já passada e não grava aprovação", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-11868-"));
    const paths = setupCycle(dataRoot, WEEK_X);
    assert.throws(() => approveCircleStackCycle(paths, saturdayAfterX()), /já passou/);
    assert.equal(existsSync(paths.approvalPath), false);
  });

  it("--approve --publish-monday X explícito no sábado sai com erro, sem aprovação gravada", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-11868-"));
    const paths = setupCycle(dataRoot, WEEK_X);
    await assert.rejects(
      runScheduledCircleStack(["--approve", "--publish-monday", WEEK_X, "--data-root", dataRoot], {
        rootDir: dataRoot,
        platformConfig: {},
        env: {},
        now: saturdayAfterX,
      }),
      new RegExp(WEEK_X7),
    );
    assert.equal(existsSync(paths.approvalPath), false);
  });

  it("a segunda X+7 continua aprovável no mesmo sábado", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-11868-"));
    const paths = setupCycle(dataRoot, WEEK_X7);
    approveCircleStackCycle(paths, saturdayAfterX());
    assert.equal(existsSync(paths.approvalPath), true);
  });

  it("na própria segunda (antes do envio) a segunda de hoje segue aprovável", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-11868-"));
    const paths = setupCycle(dataRoot, WEEK_X7);
    approveCircleStackCycle(paths, new Date(2026, 10, 9, 5, 0, 0));
    assert.equal(existsSync(paths.approvalPath), true);
  });
});
