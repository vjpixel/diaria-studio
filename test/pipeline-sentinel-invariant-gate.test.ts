/**
 * test/pipeline-sentinel-invariant-gate.test.ts (#6009)
 *
 * Regressão: `pipeline-sentinel.ts write --step N` gravava o sentinel de
 * conclusão de um stage mesmo com `check-invariants --stage N` reportando
 * violações de severity=error — achado ao vivo na edição 260824, execução
 * caótica multi-máquina do Stage 2: o sentinel `.step-2-done.json` foi
 * gravado como concluído com `humanizer-ran` falhando pra newsletter E
 * social (humanizador nunca rodou), porque `check-invariants --stage 2` só
 * existia como PROSA no playbook do orchestrator — nada impedia
 * mecanicamente o `write` de rodar sem essa checagem antes.
 *
 * Fix: `checkStageInvariantsForWrite` (exportada de `pipeline-sentinel.ts`)
 * roda as mesmas regras do registry (`getRulesForStage`) direto no `write`,
 * e o subcomando CLI recusa gravar (exit 1) quando há violação de erro —
 * a menos que `--bypass-reason` seja passado explicitamente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStageInvariantsForWrite } from "../scripts/pipeline-sentinel.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sentinelCli = join(repoRoot, "scripts", "pipeline-sentinel.ts");

describe("checkStageInvariantsForWrite (#6009) — unit", () => {
  it("Stage 2 com 02-reviewed.md/03-social.md mas sem snapshot pré-humanizador → falha (humanizer-ran)", () => {
    // Mesmo estado do incidente 260824: os arquivos finais existem (o
    // writer/social-writer rodaram), mas o humanizador nunca tocou neles —
    // sem _internal/02-humanized.md nem _internal/03-social-pre-humanizador.md.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-invariant-gate-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), "conteúdo qualquer\n");
      writeFileSync(join(dir, "03-social.md"), "# Social\n## d1\ntexto\n");
      const result = checkStageInvariantsForWrite(dir, 2);
      assert.equal(result.passed, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors.some((v) => v.rule === "humanizer-ran"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Stage 2 sem 02-reviewed.md/03-social.md → falha (arquivo ausente é violação de erro)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-invariant-gate-empty-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const result = checkStageInvariantsForWrite(dir, 2);
      assert.equal(result.passed, false);
      assert.ok(result.errors.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#6009 anti-deadlock: Stage 6 nunca inclui step-6-sentinel-exists (checaria o próprio sentinel que este write está prestes a criar)", () => {
    // checkStep6Sentinel não é postDispatchOnly — sem o filtro explícito por
    // id, o write --step 6 bloquearia SEMPRE (o sentinel nunca existe antes
    // de ser escrito). Dir vazio: outras regras do Stage 6 vão falhar (isso é
    // esperado), mas a causa NUNCA pode ser o próprio sentinel do stage 6.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-invariant-gate-s6-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const result = checkStageInvariantsForWrite(dir, 6);
      assert.ok(
        !result.errors.some((v) => v.rule === "step-6-sentinel-exists"),
        "step-6-sentinel-exists nunca deveria aparecer nas violações do write do próprio stage 6",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#6009 anti-deadlock: Stage 5 exclui regras postDispatchOnly (step-5-sentinel-exists, stage-usage-captured, ...)", () => {
    // Mesma lógica do Stage 6 acima, mas via o filtro de fase (--phase
    // pre-dispatch) — essas regras só marcam severity=error porque o
    // próprio write (+ capture-stage-usage.ts, que roda DEPOIS dele) ainda
    // não aconteceu. Incluir postDispatchOnly aqui bloquearia Stage 5 pra
    // sempre, do mesmo jeito que o Stage 6 sem o filtro por id.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-invariant-gate-s5-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const result = checkStageInvariantsForWrite(dir, 5);
      const postDispatchRuleIds = [
        "step-5-sentinel-exists",
        "stage-usage-captured",
        "social-published-complete",
        "consent-binding",
      ];
      for (const ruleId of postDispatchRuleIds) {
        assert.ok(
          !result.errors.some((v) => v.rule === ruleId),
          `${ruleId} (postDispatchOnly) não deveria aparecer nas violações do write do stage 5`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("step fora do range 0-6 → sempre passa (no-op, mesmo comportamento pré-fix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-invariant-gate-range-"));
    try {
      const result = checkStageInvariantsForWrite(dir, 7);
      assert.equal(result.passed, true);
      assert.deepEqual(result.errors, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Roda `pipeline-sentinel.ts write` como subprocesso real (exercita o CLI,
 * não só a lib). `cwd` fica fixo em `repoRoot` (não num tmpdir isolado) —
 * `--import tsx` precisa resolver o pacote `tsx` a partir de um `cwd` com
 * `node_modules`, e este worktree não tem `data/` real (junction OneDrive
 * ausente em worktree novo — ver CLAUDE.md), então escrever sob
 * `repoRoot/data/editions/{aamm}/{aammdd}` com um AAMMDD exclusivo do teste
 * é seguro e não risca dado de produção.
 */
function runWrite(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", sentinelCli, "write", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("pipeline-sentinel write — gate mecânico de invariantes (#6009) — CLI", () => {
  it("Stage 2 com invariantes falhando (humanizer não rodou) → write recusado, sentinel NÃO gravado", () => {
    const aammdd = "919011";
    const editionDir = join(repoRoot, "data", "editions", aammdd.slice(0, 4), aammdd);
    try {
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      // Simula a edição real: 02-reviewed.md e 03-social.md existem mas o
      // humanizador nunca rodou (sem snapshot pré-humanizador) — mesmo
      // estado do incidente 260824.
      writeFileSync(join(editionDir, "02-reviewed.md"), "conteúdo qualquer\n");
      writeFileSync(join(editionDir, "03-social.md"), "# Social\n## d1\ntexto\n");

      const { status, stderr } = runWrite([
        "--edition",
        aammdd,
        "--step",
        "2",
        "--outputs",
        "02-reviewed.md,03-social.md",
      ]);

      assert.equal(status, 1);
      assert.match(stderr, /check-invariants --stage 2/);
      assert.match(stderr, /humanizer-ran|reviewed-passes-all-lints|social-passes-lints/);
      assert.equal(
        existsSync(join(editionDir, "_internal", ".step-2-done.json")),
        false,
        "sentinel não deve ser gravado quando invariantes falham",
      );
    } finally {
      rmSync(editionDir, { recursive: true, force: true });
    }
  });

  it("Stage 2 com --bypass-reason → grava o sentinel mesmo com invariantes falhando (warn, não bloqueia)", () => {
    const aammdd = "919012";
    const editionDir = join(repoRoot, "data", "editions", aammdd.slice(0, 4), aammdd);
    try {
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(join(editionDir, "02-reviewed.md"), "conteúdo qualquer\n");
      writeFileSync(join(editionDir, "03-social.md"), "# Social\n## d1\ntexto\n");

      const { status, stderr } = runWrite([
        "--edition",
        aammdd,
        "--step",
        "2",
        "--outputs",
        "02-reviewed.md,03-social.md",
        "--bypass-reason",
        "teste de regressão #6009",
      ]);

      assert.equal(status, 0);
      assert.match(stderr, /bypass-reason/);
      assert.equal(
        existsSync(join(editionDir, "_internal", ".step-2-done.json")),
        true,
        "--bypass-reason deve permitir o write mesmo com invariantes falhando",
      );
    } finally {
      rmSync(editionDir, { recursive: true, force: true });
    }
  });

  it("edição fora do formato AAMMDD (ex: pipeline mensal via --dir) não é coberta pelo gate — comportamento preservado", () => {
    const root = mkdtempSync(join(tmpdir(), "sentinel-invariant-monthly-"));
    try {
      const monthlyDir = join(root, "data", "monthly", "2608-09");
      mkdirSync(join(monthlyDir, "_internal"), { recursive: true });

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          sentinelCli,
          "write",
          "--edition",
          "2608-09",
          "--step",
          "2",
          "--outputs",
          "draft.md",
          "--dir",
          monthlyDir,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );

      // Sem 02-reviewed.md/03-social.md o registry da diária falharia se
      // rodasse aqui — mas o gate é pulado (--dir presente), então o write
      // segue o comportamento pré-#6009 (sempre grava).
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(monthlyDir, "_internal", ".step-2-done.json")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
