/**
 * test/guard-never-invoked.test.ts (#7137, item 1 bullet 2)
 *
 * Cobre `scripts/lib/guard-never-invoked.ts` — o "guard mecânico do próprio
 * guard" pedido no escopo (1) da #7137. Fixtures isoladas em `mkdtemp` (não
 * o repo real) pras unidades de nome/corpus/exclusão; um bloco de
 * integração no fim roda contra o repo real e trava a REGRESSÃO concreta
 * desta PR — nenhum dos 16 scripts triados volta a aparecer como finding
 * cru sem exclusão registrada.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isGuardCandidateName,
  listGuardCandidates,
  buildLocalCorpusText,
  hasInvocationPoint,
  evaluateGuardNeverInvoked,
  KNOWN_INDIRECT_INVOCATIONS,
  type GuardCandidate,
} from "../scripts/lib/guard-never-invoked.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("isGuardCandidateName", () => {
  it("casa prefixo check-*.ts", () => {
    assert.equal(isGuardCandidateName("check-highlight-themes.ts"), true);
  });
  it("casa sufixo *-alarm.ts", () => {
    assert.equal(isGuardCandidateName("ads-kill-switch-alarm.ts"), true);
  });
  it("casa sufixo *-gate.ts", () => {
    assert.equal(isGuardCandidateName("check-glm-lane-gate.ts"), true);
  });
  it("casa sufixo *-drift-check.ts", () => {
    assert.equal(isGuardCandidateName("task-registry-prose-drift-check.ts"), true);
  });
  it("NÃO casa script comum sem nenhum dos padrões", () => {
    assert.equal(isGuardCandidateName("dedup.ts"), false);
  });
  it("NÃO casa 'checkfoo.ts' (sem hífen depois de check)", () => {
    assert.equal(isGuardCandidateName("checkfoo.ts"), false);
  });
  it("NÃO casa arquivo de teste, mesmo com nome que bateria no padrão", () => {
    assert.equal(isGuardCandidateName("check-highlight-themes.test.ts"), false);
  });
  it("NÃO casa arquivo não-.ts", () => {
    assert.equal(isGuardCandidateName("check-foo.md"), false);
  });
});

describe("listGuardCandidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-candidates-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("lista só os arquivos que casam os padrões, direto em scriptsDir (não-recursivo)", () => {
    writeFileSync(join(dir, "check-foo.ts"), "// foo");
    writeFileSync(join(dir, "bar-alarm.ts"), "// alarm");
    writeFileSync(join(dir, "dedup.ts"), "// não é candidato");
    writeFileSync(join(dir, "check-foo.test.ts"), "// teste, excluído");
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "check-nested.ts"), "// subpasta, não conta");

    const candidates = listGuardCandidates(dir);
    const names = candidates.map((c) => c.name).sort();
    assert.deepEqual(names, ["bar-alarm", "check-foo"]);
  });

  it("retorna [] pra diretório inexistente (fail-soft)", () => {
    assert.deepEqual(listGuardCandidates(join(dir, "nao-existe")), []);
  });
});

describe("hasInvocationPoint", () => {
  it("substring match simples", () => {
    assert.equal(hasInvocationPoint("check-foo", "algo... npx tsx scripts/check-foo.ts ...outro"), true);
  });
  it("ausência = sem invocação", () => {
    assert.equal(hasInvocationPoint("check-foo", "nada relacionado aqui"), false);
  });
});

describe("evaluateGuardNeverInvoked", () => {
  function cand(name: string): GuardCandidate {
    return { name, relPath: `${name}.ts` };
  }

  it("candidato referenciado no corpus vira armado, sem finding", () => {
    const candidates = [cand("check-foo")];
    const report = evaluateGuardNeverInvoked(candidates, "npx tsx scripts/check-foo.ts --dry-run");
    assert.deepEqual(report.findings, []);
  });

  it("candidato sem NENHUMA referência vira finding", () => {
    const candidates = [cand("check-orfao")];
    const report = evaluateGuardNeverInvoked(candidates, "nada aqui menciona esse nome");
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].name, "check-orfao");
  });

  it("irmão -gate.ts armado no corpus já cobre o check base por substring (nome do gate contém o nome base)", () => {
    // A convenção de nome é sempre "<base>-gate.ts", então o texto que arma
    // o gate ("scripts/check-decision-label-drift-gate.ts") já contém o
    // basename do check original como substring/prefixo — o candidato base
    // já sai "armado" pelo match de substring padrão de
    // `hasInvocationPoint`, sem precisar de nenhuma lógica dedicada de
    // "irmão -gate" (ver docstring de `guard-never-invoked.ts` — uma branch
    // explícita foi tentada e removida por ser inalcançável por
    // construção).
    const candidates = [cand("check-decision-label-drift"), cand("check-decision-label-drift-gate")];
    const report = evaluateGuardNeverInvoked(candidates, "npx tsx scripts/check-decision-label-drift-gate.ts");
    assert.deepEqual(report.findings, []);
  });

  it("candidato em KNOWN_INDIRECT_INVOCATIONS é excluído mesmo sem substring no corpus", () => {
    const name = Object.keys(KNOWN_INDIRECT_INVOCATIONS)[0]!;
    const candidates = [cand(name)];
    const report = evaluateGuardNeverInvoked(candidates, "corpus vazio de propósito, sem menção nenhuma");
    assert.deepEqual(report.findings, []);
    assert.equal(report.excludedByKnownIndirectInvocation.length, 1);
    assert.equal(report.excludedByKnownIndirectInvocation[0].name, name);
  });
});

describe("KNOWN_INDIRECT_INVOCATIONS — nenhuma chave vencida (#7466 fleet review, type-design)", () => {
  it("toda chave do mapa corresponde a um GuardCandidate.name real, produzido hoje por listGuardCandidates", () => {
    // Exatamente a classe de "prosa vencida" que esta PR inteira existe pra
    // pegar: uma chave obsoleta/com typo aqui ficaria pra sempre suprimindo
    // um finding de um candidato que já não existe (inofensivo) OU, pior,
    // deixando de suprimir o candidato real que a chave PRETENDIA cobrir
    // (typo silencioso — o script voltaria a aparecer como finding cru sem
    // ninguém notar a causa). As duas direções exigem que a chave bata
    // exatamente com um nome real.
    const candidateNames = new Set(listGuardCandidates(join(ROOT, "scripts")).map((c) => c.name));
    const staleKeys = Object.keys(KNOWN_INDIRECT_INVOCATIONS).filter((k) => !candidateNames.has(k));
    assert.deepEqual(
      staleKeys,
      [],
      `chave(s) de KNOWN_INDIRECT_INVOCATIONS sem GuardCandidate correspondente em scripts/: ${staleKeys.join(", ")} — renomear/remover a chave, ou o script real sumiu sem atualizar o mapa`,
    );
  });
});

describe("buildLocalCorpusText — integração com o repo real", () => {
  it("retorna texto não-vazio (corpus real do checkout tem conteúdo)", () => {
    const text = buildLocalCorpusText(ROOT);
    assert.ok(text.length > 1000, "corpus real deveria ter bastante conteúdo (.claude/skills, hermes/, etc.)");
  });

  it("inclui o conteúdo de scripts/lib/scheduled-tasks.ts (corpus fixo, sempre presente)", () => {
    const text = buildLocalCorpusText(ROOT);
    assert.ok(text.includes("SCHEDULED_TASKS"), "esperava achar a constante SCHEDULED_TASKS no corpus");
  });
});

describe("regressão #7137 — os 16 scripts triados nesta PR não voltam como finding cru", () => {
  // Removidos nesta PR ou em PR anterior (#7143) — não são mais candidatos.
  const removed = ["check-drive-push", "check-intra-themes", "node-modules-loop-alarm"];
  // Os 14 restantes: cada um foi armado (aparece direto no corpus),
  // excluído por cadeia indireta, ou excluído por decisão deliberada —
  // nenhum pode sobrar em `findings` sem registro.
  const shouldBeResolved = [
    "ads-kill-switch-alarm",
    "ads-spend-ingest-alarm",
    "check-alarm-retirement-candidates",
    "check-campaign-docs-sync",
    "check-continuo-coherence",
    "check-continuo-workdir",
    "check-control-edition-noise",
    "check-corrupted-names",
    "check-glm-lane-gate",
    "check-highlight-themes",
    "check-secondary-themes",
    "check-session-leakage",
    "task-registry-prose-drift-check",
  ];

  it("nenhum dos 16 originais (exceto os 2 já removidos em PR anterior) aparece em scripts/", () => {
    for (const name of removed) {
      const candidates = listGuardCandidates(join(ROOT, "scripts"));
      assert.ok(
        !candidates.some((c) => c.name === name),
        `"${name}" deveria ter sido removido (PR #7143) e não existir mais em scripts/`,
      );
    }
  });

  it("cada um dos 14 restantes está armado ou tem exclusão documentada — nenhum finding cru", () => {
    const candidates = listGuardCandidates(join(ROOT, "scripts"));
    const corpusText = buildLocalCorpusText(ROOT);
    const report = evaluateGuardNeverInvoked(candidates, corpusText);
    const findingNames = new Set(report.findings.map((f) => f.name));
    for (const name of shouldBeResolved) {
      assert.ok(
        !findingNames.has(name),
        `"${name}" deveria estar armado ou ter exclusão documentada (#7137), mas apareceu como finding cru`,
      );
    }
  });
});
