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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStageInvariantsForWrite } from "../scripts/pipeline-sentinel.ts";
import { writeSentinel } from "../scripts/check-humanizer-social.ts"; // #6305

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sentinelCli = join(repoRoot, "scripts", "pipeline-sentinel.ts");

/**
 * #6194 — Cria um diretório temporário isolado com `node_modules` linkado do
 * repo raiz, para que `--import tsx` resolva sem nunca tocar o `data/` real
 * (junction OneDrive) do checkout principal.
 *
 * Antes deste helper, `runWrite` usava `cwd: repoRoot` fixo — em um worktree
 * novo (sem `data/` junction) isso era "seguro", mas no checkout principal
 * (onde `data/` É o OneDrive) o teste gravava edições sintéticas em disco
 * real e disparava e-mails de gate falsos (edição 919011, #6194).
 */
function setupIsolatedCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-cli-"));
  // Symlink node_modules pra que --import tsx resolva (Node sobe a árvore de
  // node_modules do cwd; sem o link, falha com "Cannot find package 'tsx'").
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  return dir;
}

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
 * não só a lib). Usa um `cwd` isolado (temp dir com `node_modules` linkado
 * do repo) — #6194: `cwd: repoRoot` fixo escrevia em `data/editions/9190/`
 * no checkout principal, onde `data/` é a junction OneDrive real.
 */
function runWrite(args: string[], cwd: string): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", sentinelCli, "write", ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("pipeline-sentinel write — gate mecânico de invariantes (#6009) — CLI", () => {
  it("Stage 2 com invariantes falhando (humanizer não rodou) → write recusado, sentinel NÃO gravado", () => {
    const aammdd = "919011";
    const isolatedCwd = setupIsolatedCwd();
    const editionDir = join(isolatedCwd, "data", "editions", aammdd.slice(0, 4), aammdd);
    try {
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      // Simula a edição real: 02-reviewed.md e 03-social.md existem mas o
      // humanizador nunca rodou (sem snapshot pré-humanizador) — mesmo
      // estado do incidente 260824.
      writeFileSync(join(editionDir, "02-reviewed.md"), "conteúdo qualquer\n");
      writeFileSync(join(editionDir, "03-social.md"), "# Social\n## d1\ntexto\n");

      const { status, stderr } = runWrite(
        ["--edition", aammdd, "--step", "2", "--outputs", "02-reviewed.md,03-social.md"],
        isolatedCwd,
      );

      assert.equal(status, 1);
      assert.match(stderr, /check-invariants --stage 2/);
      assert.match(stderr, /humanizer-ran|reviewed-passes-all-lints|social-passes-lints/);
      assert.equal(
        existsSync(join(editionDir, "_internal", ".step-2-done.json")),
        false,
        "sentinel não deve ser gravado quando invariantes falham",
      );
    } finally {
      // #6194: cleanup do diretório inteiro, garantindo que nada vaze pro
      // checkout principal (temp dir, não repoRoot/data/).
      rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it("Stage 2 com --bypass-reason → grava o sentinel mesmo com invariantes falhando (warn, não bloqueia)", () => {
    const aammdd = "919012";
    const isolatedCwd = setupIsolatedCwd();
    const editionDir = join(isolatedCwd, "data", "editions", aammdd.slice(0, 4), aammdd);
    try {
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(join(editionDir, "02-reviewed.md"), "conteúdo qualquer\n");
      writeFileSync(join(editionDir, "03-social.md"), "# Social\n## d1\ntexto\n");

      const { status, stderr } = runWrite(
        [
          "--edition", aammdd, "--step", "2",
          "--outputs", "02-reviewed.md,03-social.md",
          "--bypass-reason", "teste de regressão #6009",
        ],
        isolatedCwd,
      );

      assert.equal(status, 0);
      assert.match(stderr, /bypass-reason/);
      assert.equal(
        existsSync(join(editionDir, "_internal", ".step-2-done.json")),
        true,
        "--bypass-reason deve permitir o write mesmo com invariantes falhando",
      );
    } finally {
      rmSync(isolatedCwd, { recursive: true, force: true });
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

/**
 * #6305 — Regressão: `humanizer-ran` (assertHumanized, snapshot-based) prova
 * que a skill `humanizador` foi invocada — não prova que o passo SEGUINTE e
 * independente do playbook (`check-humanizer-social.ts --write`, que grava
 * `_internal/.humanizer-social-done.json`) de fato rodou. Cenário real da
 * edição 260827: o snapshot `03-social-pre-humanizador.md` existia (humanizer
 * rodou, humanizer-ran passava), mas o `--write` nunca aconteceu — o Stage 2
 * seguiu pra Etapa 3 sem o sentinel, e só o gate do Stage 4
 * (`check-humanizer-social.ts --check`) descobriu isso depois, exit 1.
 *
 * A nova regra `social-humanizer-sentinel-written` fecha essa lacuna
 * bloqueando `pipeline-sentinel.ts write --step 2` mecanicamente — sem
 * depender do passo em prosa do playbook ser lembrado.
 */
describe("social-humanizer-sentinel-written (#6305)", () => {
  it("humanizer rodou (snapshot presente) mas sentinel --write nunca aconteceu → write recusado, e humanizer-ran sozinho NÃO capturaria isso", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-social-6305-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      // Mesmo estado real da edição 260827: 03-social.md existe, o snapshot
      // pré-humanizador existe (prova que a skill rodou) — mas
      // `.humanizer-social-done.json` nunca foi gravado.
      writeFileSync(join(dir, "03-social.md"), "# Social\n## d1\ntexto humanizado\n");
      writeFileSync(join(dir, "_internal", "03-social-pre-humanizador.md"), "# Social\n## d1\ntexto pré-humanizador\n");

      const result = checkStageInvariantsForWrite(dir, 2);

      assert.equal(result.passed, false);
      assert.ok(
        result.errors.some((v) => v.rule === "social-humanizer-sentinel-written"),
        "esperava violação social-humanizer-sentinel-written quando o sentinel nunca foi gravado",
      );
      // A prova do gap real do #6305: o guard PRÉ-EXISTENTE (humanizer-ran)
      // não acusa nada aqui — o snapshot está presente e não-stale, então
      // ele passa silenciosamente. Sem a nova regra, nada bloquearia o write.
      assert.ok(
        !result.errors.some((v) => v.rule === "humanizer-ran"),
        "humanizer-ran não deveria acusar nada aqui — é exatamente o gap que o #6305 fecha",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sentinel gravado via check-humanizer-social.ts --write (writeSentinel) → violação desaparece", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-social-6305-ok-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "03-social.md"), "# Social\n## d1\ntexto humanizado\n");
      writeFileSync(join(dir, "_internal", "03-social-pre-humanizador.md"), "# Social\n## d1\ntexto pré-humanizador\n");

      // Passo que faltou na sessão real da issue #6305 — rodá-lo aqui fecha o loop.
      writeSentinel(dir);

      const result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        !result.errors.some((v) => v.rule === "social-humanizer-sentinel-written"),
        "sentinel gravado e hash bate com 03-social.md atual — não deveria mais violar",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("03-social.md ausente (Stage 2 ainda não produziu) → sem violação (outro check captura)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-social-6305-missing-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        !result.errors.some((v) => v.rule === "social-humanizer-sentinel-written"),
        "sem 03-social.md ainda, este check não deveria disparar (arquivo ausente é responsabilidade de outro check)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * #6305 finding 1 do self-review — o caso hash_mismatch dispara num fluxo LEGÍTIMO (editor
   * edita 03-social.md no gate humano de §2d, e nada re-hashava até o
   * orchestrator-stage-2.md ganhar o passo dedicado que roda
   * check-humanizer-social.ts --write de novo pós-gate). Uma mensagem que só
   * diz "hash diverge" sem nomear a ação concreta custa uma sessão inteira de
   * investigação — a mensagem precisa nomear o comando a rodar.
   */
  it("sentinel gravado mas 03-social.md mudou depois (hash_mismatch) → mensagem nomeia a ação concreta", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-social-6305-hash-mismatch-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "03-social.md"), "# Social\n## d1\ntexto humanizado\n");
      writeFileSync(join(dir, "_internal", "03-social-pre-humanizador.md"), "# Social\n## d1\ntexto pré-humanizador\n");
      writeSentinel(dir);

      // Simula o gate humano de §2d editando 03-social.md DEPOIS do --write
      // (sem re-rodar o sentinel) — o cenário legítimo que o PR do #6305 corrige.
      writeFileSync(join(dir, "03-social.md"), "# Social\n## d1\ntexto humanizado E editado no gate\n");

      const result = checkStageInvariantsForWrite(dir, 2);
      const violation = result.errors.find((v) => v.rule === "social-humanizer-sentinel-written");
      assert.ok(violation, "esperava violação social-humanizer-sentinel-written com hash divergente");
      assert.match(
        violation!.message,
        /check-humanizer-social\.ts --write/,
        "mensagem precisa nomear o comando concreto a rodar, não só dizer que o hash diverge",
      );
      assert.match(
        violation!.message,
        /mudou depois do último registro do sentinel/,
        "mensagem precisa nomear a CAUSA (texto mudou após o último registro) junto da ação",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * #6337 — Regressão: `check-stage2-invariants.ts` (#1072/#1073) implementa 5
 * checks (humanizador newsletter, Clarice, render-erro-intencional,
 * intentional-error.json exists, reveal com prefixo temporal), mas até aqui
 * eles só rodavam como PASSO EM PROSA no playbook (`orchestrator-stage-2.md`
 * ~L375-380) — nenhum estava registrado em `STAGE_2_RULES`, então
 * `pipeline-sentinel.ts write --step 2` (#6009) não os cobria. Mesma classe
 * de gap que o #6305 fechou para o sentinel do humanizador social: uma
 * sessão que pulasse o passo em prosa passava pelo gate mecânico sem
 * detecção. Cada teste abaixo prova que o registry agora recusa `write
 * --step 2` quando o check correspondente falha, e para de recusar quando o
 * estado em disco é corrigido — ou seja, remover a regra do registry faria
 * este teste falhar.
 */
describe("5 checks de check-stage2-invariants.ts entram em STAGE_2_RULES (#6337)", () => {
  function mkEditionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-6337-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("newsletter-humanizador-diff-ran: 02-normalized.md byte-idêntico a 02-humanized.md → violação; diverge → some", () => {
    const dir = mkEditionDir();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "texto cru do writer\n");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "texto cru do writer\n"); // idêntico = humanizer no-op/pulado

      let result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        result.errors.some((v) => v.rule === "newsletter-humanizador-diff-ran"),
        "esperava violação newsletter-humanizador-diff-ran quando os 2 arquivos são byte-idênticos",
      );

      writeFileSync(join(dir, "_internal", "02-humanized.md"), "texto humanizado, sem gerúndio em cascata\n");
      result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        !result.errors.some((v) => v.rule === "newsletter-humanizador-diff-ran"),
        "diferindo do normalized, o check deveria passar",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clarice-ran: 02-reviewed.md sem _internal/02-pre-clarice.md → violação; com snapshot + suggestions.json → some", () => {
    const dir = mkEditionDir();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "# Newsletter\ntexto\n");

      let result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        result.errors.some((v) => v.rule === "clarice-ran"),
        "esperava violação clarice-ran sem o snapshot pré-Clarice",
      );

      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "# Newsletter\ntexto\n");
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        !result.errors.some((v) => v.rule === "clarice-ran"),
        "com snapshot + suggestions.json (mesmo array vazio, #1402) o check deveria passar",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("erro-intencional-rendered: placeholder literal remanescente em 02-reviewed.md → violação; renderizado → some", () => {
    const dir = mkEditionDir();
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "# Newsletter\n{placeholder, script render-erro-intencional.ts substitui pós-Clarice}\n",
      );

      let result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        result.errors.some((v) => v.rule === "erro-intencional-rendered"),
        "esperava violação erro-intencional-rendered com o placeholder literal ainda no MD",
      );

      writeFileSync(join(dir, "02-reviewed.md"), "# Newsletter\nNa última edição, escrevi X onde o correto é Y.\n");
      result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        !result.errors.some((v) => v.rule === "erro-intencional-rendered"),
        "sem o placeholder literal, o check deveria passar",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("intentional-error-json-exists: 02-reviewed.md presente sem _internal/intentional-error.json → violação; arquivo presente → some", () => {
    const dir = mkEditionDir();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "# Newsletter\ntexto\n");

      let result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        result.errors.some((v) => v.rule === "intentional-error-json-exists"),
        "esperava violação intentional-error-json-exists sem o arquivo",
      );

      writeFileSync(
        join(dir, "_internal", "intentional-error.json"),
        JSON.stringify({ description: "{PREENCHER}" }, null, 2),
      );
      result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        !result.errors.some((v) => v.rule === "intentional-error-json-exists"),
        "com o arquivo presente (mesmo com placeholder {PREENCHER}) o check deveria passar",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reveal-temporal-prefix: reveal sem prefixo temporal (#6139) → violação; com 'Na última edição' → some", () => {
    const dir = mkEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "intentional-error.json"),
        JSON.stringify(
          {
            description: "teste",
            location: "DESTAQUE 1",
            category: "factual",
            correct_value: "valor correto",
            reveal: "Nesta edição, escrevi X onde o correto é Y.", // #6139: prefixo da declaração CORRENTE, não do reveal
          },
          null,
          2,
        ),
      );

      let result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        result.errors.some((v) => v.rule === "reveal-temporal-prefix"),
        "esperava violação reveal-temporal-prefix quando reveal começa com 'Nesta edição'",
      );

      writeFileSync(
        join(dir, "_internal", "intentional-error.json"),
        JSON.stringify(
          {
            description: "teste",
            location: "DESTAQUE 1",
            category: "factual",
            correct_value: "valor correto",
            reveal: "Na última edição, escrevi X onde o correto é Y.",
          },
          null,
          2,
        ),
      );
      result = checkStageInvariantsForWrite(dir, 2);
      assert.ok(
        !result.errors.some((v) => v.rule === "reveal-temporal-prefix"),
        "com o prefixo temporal correto, o check deveria passar",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
