/**
 * #13908 — resume do Stage 4 da Clarice (`clarice-pending.ts resume`) com o
 * espelho É IA? de `02-reviewed.md` no placeholder do stitch e o `01-eia.md`
 * real. Desde o #13886 o `sync-eia-block` (sentido 02→01) recusa com exit 4
 * nesse caso, e o resume tratava qualquer exit ≠ 0 de passo que conserta
 * sozinho como falha dura: terminava em exit 9 e o editor rodava `--from 01`
 * à mão. Agora o resume roda o `--from 01` sozinho e só falha se ele falhar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyPostSteps,
  postResumeSteps,
  runPostResumeSteps,
  SYNC_EIA_REFUSED_EXIT,
} from "../scripts/lib/diaria/clarice-pending.ts";
import { resumedStderrLines, runTsx } from "../scripts/clarice-pending.ts";

const PLACEHOLDER_POS_STRIP = "É IA?\n\n[É IA? ainda processando, bloco será inserido na Etapa 3]";
const CREDITO_REAL = "Foto do farol de Peggy's Cove, [Author](https://commons.wikimedia.org/wiki/User:X) / CC BY-SA 4.0.";
const RESULTADO = "Resultado da última edição: 88% das pessoas acertaram.";
const EIA_REAL = `---\neia_answer:\n  A: real\n  B: ia\n---\n\n**É IA?**\n\n${CREDITO_REAL}\n\n${RESULTADO}\n`;

function reviewedWith(eiaBlock: string): string {
  return [
    "**DESTAQUE 1 | MERCADO**",
    "",
    "**[Título do D1](https://x.com/d1)**",
    "",
    "Corpo do D1.",
    "",
    "---",
    "",
    eiaBlock,
    "",
    "---",
    "",
    "**LANÇAMENTOS**",
    "",
    "**[Um lançamento](https://x.com/l1)**",
    "Descrição do lançamento.",
  ].join("\n");
}

const isSync = (args: string[]): boolean => args[0] === "scripts/sync-eia-block.ts";
const isFrom01 = (args: string[]): boolean => args.includes("--from") && args[args.indexOf("--from") + 1] === "01";

describe("#13908 — resume da Clarice com sync-eia-block recusando (exit 4)", () => {
  it("postResumeSteps: sync-eia-block declara o --from 01 como resposta ao exit 4", () => {
    const sync = postResumeSteps("/ed/261124").find((s) => s.name === "sync-eia-block")!;
    assert.equal(sync.onRefusal?.exit, SYNC_EIA_REFUSED_EXIT);
    assert.deepEqual(sync.onRefusal?.args, ["scripts/sync-eia-block.ts", "--edition-dir", "/ed/261124", "--from", "01"]);
    assert.ok(!isFrom01(sync.args), "o 1º passo continua no sentido default 02→01");
  });

  it("exit 4 seguido de --from 01 exit 0 → recovered, sem falha dura", () => {
    const calls: string[][] = [];
    const steps = runPostResumeSteps(postResumeSteps("/ed/261124"), (args) => {
      calls.push(args);
      if (isSync(args)) return isFrom01(args) ? 0 : 4;
      return 0;
    });
    const { hardFailures, attention, recovered } = classifyPostSteps(steps);
    assert.deepEqual(hardFailures, []);
    assert.deepEqual(attention, []);
    assert.deepEqual(recovered.map((s) => s.name), ["sync-eia-block"]);
    assert.equal(calls.filter(isSync).length, 2, "default e depois --from 01");
    const lines = resumedStderrLines([], attention, hardFailures, recovered);
    assert.ok(lines.some((l) => l.includes("sync-eia-block recusou (exit 4)") && l.includes("--from 01")));
    assert.ok(!lines.some((l) => l.includes("rodar à mão")));
  });

  it("--from 01 também falhando (ou crashando) segue falha dura", () => {
    for (const fallback of [3, { exitCode: -1, stdout: "", crashed: "morto por signal SIGKILL" }] as const) {
      const steps = runPostResumeSteps(postResumeSteps("/ed/261124"), (args) =>
        isSync(args) ? (isFrom01(args) ? fallback : 4) : 0,
      );
      const { hardFailures, recovered } = classifyPostSteps(steps);
      assert.deepEqual(hardFailures.map((s) => s.name), ["sync-eia-block"]);
      assert.deepEqual(recovered, []);
      const [line] = resumedStderrLines([], [], hardFailures).filter((l) => l.includes("sync-eia-block"));
      assert.match(line, /exit 4; fallback/);
    }
  });

  it("exit ≠ 4 do sync (ex.: 3) não dispara o --from 01 e é falha dura", () => {
    const calls: string[][] = [];
    const steps = runPostResumeSteps(postResumeSteps("/ed/261124"), (args) => {
      calls.push(args);
      return isSync(args) ? 3 : 0;
    });
    assert.equal(calls.filter(isFrom01).length, 0);
    assert.deepEqual(classifyPostSteps(steps).hardFailures.map((s) => s.name), ["sync-eia-block"]);
  });

  it("cenário real (261124): placeholder no espelho + 01-eia.md real → espelho recebe o 01, 01 intacto", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-13908-"));
    try {
      writeFileSync(join(dir, "01-eia.md"), EIA_REAL, "utf8");
      const reviewed = reviewedWith(PLACEHOLDER_POS_STRIP);
      writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
      // Só o sync roda de verdade (subprocesso do script real); os demais passos são stub.
      const steps = runPostResumeSteps(postResumeSteps(dir), (args) => (isSync(args) ? runTsx(args) : 0));
      const sync = steps.find((s) => s.name === "sync-eia-block")!;
      assert.equal(sync.exit, 4, "o sentido default recusa, como no #13886");
      assert.equal(sync.fallback?.exit, 0);
      const { hardFailures, recovered } = classifyPostSteps(steps);
      assert.deepEqual(hardFailures, []);
      assert.deepEqual(recovered.map((s) => s.name), ["sync-eia-block"]);
      assert.equal(readFileSync(join(dir, "01-eia.md"), "utf8"), EIA_REAL, "01-eia.md intacto");
      assert.equal(
        readFileSync(join(dir, "02-reviewed.md"), "utf8"),
        reviewed.replace(PLACEHOLDER_POS_STRIP, `**É IA?**\n\n${CREDITO_REAL}\n\n${RESULTADO}`),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
