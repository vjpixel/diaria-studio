/**
 * test/social-tic-reaudit-4505.test.ts (#4505 item 2 — regressão, #633)
 *
 * Cenário mockado da issue #4505 (recorrência ao vivo na edição 260803):
 * o humanizador roda e o sentinel é gravado limpo. Depois, uma correção
 * MECÂNICA pós-humanizador (ex: fact-check autofix, ou uma edição inline
 * "ajustar" corrigindo travessão residual) reintroduz um tique de
 * antítese-revelação (#2526) — sem re-auditoria automática, o pipeline só
 * detectaria isso se o EDITOR notasse manualmente e pedisse "passa o
 * humanizador de novo".
 *
 * Este teste prova que a re-auditoria (as chamadas explícitas
 * `lint-social-md.ts --check no-antithesis-reveal`/`no-trailing-editorial-hook`
 * agora também cabeadas no passo 6.7 do loop "ajustar", §4d.1) DETECTA esse
 * cenário determinística e automaticamente — fechando o loop que antes
 * dependia só do editor perceber (ver também a wiring de prosa verificada em
 * test/orchestrator-prompt.test.ts, describe "#4505 item 2").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeSentinel, checkSentinel } from "../scripts/check-humanizer-social.ts";

function mkSocialMd(d1Body: string, postPixelBody = "Comentário pessoal limpo, sem tique."): string {
  return [
    "# LinkedIn",
    "",
    "## d1",
    "",
    d1Body,
    "",
    "## post_pixel",
    "",
    postPixelBody,
    "",
    "# Facebook",
    "",
    "## d1",
    "",
    d1Body,
    "",
  ].join("\n");
}

function makeTmpEdition(): string {
  return mkdtempSync(join(tmpdir(), "social-tic-reaudit-"));
}

function runLint(mdPath: string, check: string) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "lint-social-md.ts");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--check", check, "--md", mdPath],
    { cwd: projectRoot, encoding: "utf8" },
  );
}

describe("#4505 item 2 — mock: correção mecânica pós-humanizador reintroduz tique conhecido", () => {
  it("baseline: texto limpo pós-humanizador passa limpo nos 2 tic-lints (sentinel bate, sem tique)", () => {
    const dir = makeTmpEdition();
    try {
      const cleanBody = "A empresa lançou o recurso sem alarde, direto para produção.";
      const socialPath = join(dir, "03-social.md");
      writeFileSync(socialPath, mkSocialMd(cleanBody), "utf8");

      // Simula o humanizador tendo rodado com sucesso: sentinel gravado.
      writeSentinel(dir);
      assert.deepEqual(checkSentinel(dir), { ok: true });

      // Os 2 tic-lints (mesmos agora cabeados no passo 6.7 do loop "ajustar")
      // devem passar limpo sobre o texto humanizado original.
      const antithesis = runLint(socialPath, "no-antithesis-reveal");
      const hook = runLint(socialPath, "no-trailing-editorial-hook");
      assert.equal(antithesis.status, 0, `esperava exit 0 (sem tique). stderr: ${antithesis.stderr}`);
      assert.equal(hook.status, 0, `esperava exit 0 (sem tique). stderr: ${hook.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("correção mecânica pós-humanizador reintroduz antítese-revelação — sentinel diverge E o tic-lint recém-cabeado no passo 6.7 detecta (GATE-BLOCKING)", () => {
    const dir = makeTmpEdition();
    try {
      const cleanBody = "A empresa lançou o recurso sem alarde, direto para produção.";
      const socialPath = join(dir, "03-social.md");
      writeFileSync(socialPath, mkSocialMd(cleanBody), "utf8");

      // 1. Humanizador rodou — sentinel gravado sobre o texto limpo.
      writeSentinel(dir);
      assert.deepEqual(checkSentinel(dir), { ok: true }, "sentinel deve bater sobre o texto limpo original");

      // 2. Correção MECÂNICA pós-humanizador (ex: fact-check autofix, ou
      //    "ajustar" corrigindo travessão residual) reintroduz um tique real
      //    de antítese-revelação — mesmo padrão flagrado na edição 260624
      //    (#2526) e reincidente ao vivo em 260803 (#4505).
      const mechanicallyEditedBody = "Não é sorte, é execução consistente ao longo dos meses.";
      writeFileSync(socialPath, mkSocialMd(mechanicallyEditedBody), "utf8");

      // 3. O sentinel diverge (comportamento pré-existente #2279/#2529) —
      //    confirma que o arquivo mudou depois da humanização.
      const check = checkSentinel(dir);
      assert.equal(check.ok, false);
      assert.equal((check as { reason: string }).reason, "hash_mismatch");

      // 4. O PONTO CENTRAL do item 2 (#4505): rodar os mesmos 2 tic-lints que
      //    agora são chamados EXPLICITAMENTE (e GATE-BLOCKING) no passo 6.7 do
      //    loop "ajustar" — sem depender do editor notar manualmente e pedir
      //    "passa o humanizador de novo" de novo.
      const antithesis = runLint(socialPath, "no-antithesis-reveal");
      assert.equal(
        antithesis.status,
        1,
        `#4505 item 2: o tic-lint deveria FALHAR (GATE-BLOCKING) sobre a correção mecânica que reintroduziu antítese-revelação. stdout: ${antithesis.stdout} stderr: ${antithesis.stderr}`,
      );
      assert.ok(
        /antítese-revelação/i.test(antithesis.stderr),
        "stderr deve nomear o problema (antítese-revelação) pro editor/orchestrator agir",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("correção mecânica pós-humanizador reintroduz gancho editorial emendado — mesmo mecanismo de detecção", () => {
    const dir = makeTmpEdition();
    try {
      const cleanBody = "A empresa lançou o recurso sem alarde, direto para produção.";
      const socialPath = join(dir, "03-social.md");
      writeFileSync(socialPath, mkSocialMd(cleanBody), "utf8");
      writeSentinel(dir);

      // Correção mecânica reintroduz ", e [gancho editorial]" (#2658).
      const mechanicallyEditedBody =
        "A empresa lançou o recurso sem alarde, e a escolha de foco diz mais sobre estratégia do que os benchmarks costumam revelar.";
      writeFileSync(socialPath, mkSocialMd(mechanicallyEditedBody), "utf8");

      const hook = runLint(socialPath, "no-trailing-editorial-hook");
      assert.equal(
        hook.status,
        1,
        `#4505 item 2: o tic-lint de gancho editorial deveria FALHAR (GATE-BLOCKING). stdout: ${hook.stdout} stderr: ${hook.stderr}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3 reintroduções seguidas na mesma sessão (replay da recorrência ao vivo 260803) — cada uma é pega pelo mesmo mecanismo, sem depender do editor notar", () => {
    // Replay literal do relato da issue: 3 correções mecânicas seguidas,
    // cada uma reintroduzindo antítese-revelação — o teste confirma que o
    // MESMO comando de lint pega as 3, de forma determinística e repetível
    // (não dependendo de um humano perceber a cada rodada).
    const dir = makeTmpEdition();
    try {
      const socialPath = join(dir, "03-social.md");
      const variants = [
        "Não é sorte, é execução consistente.",
        "Não é hype, é adoção real por quem usa todo dia.",
        "Não é apenas automação — é substituição de julgamento humano.",
      ];

      for (const [i, variant] of variants.entries()) {
        writeFileSync(socialPath, mkSocialMd("texto limpo temporário " + i), "utf8");
        writeSentinel(dir, i === 0 ? undefined : `re-humanizou após ajuste ${i} (#4505 replay)`);

        writeFileSync(socialPath, mkSocialMd(variant), "utf8");
        const result = runLint(socialPath, "no-antithesis-reveal");
        assert.equal(
          result.status,
          1,
          `reintrodução #${i + 1} ("${variant}") deveria ser pega pelo tic-lint. stderr: ${result.stderr}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#4505 item 2 — wiring de prosa (cross-check com orchestrator-prompt.test.ts)", () => {
  it("orchestrator-stage-4.md §4d.1 passo 6.7 referencia os mesmos 2 --check usados neste teste", () => {
    // Sanity check leve — a cobertura funcional acima prova que o MECANISMO
    // funciona; este teste confirma que o texto do orchestrator (lido pelo
    // top-level Claude Code, não executável) de fato instrui a rodar os
    // mesmos comandos no ponto de gap identificado pela issue. Cobertura
    // mais detalhada (ordem, linguagem GATE-BLOCKING, referência #4505) vive
    // em test/orchestrator-prompt.test.ts — describe "#4505 item 2".
    const projectRoot = join(import.meta.dirname, "..");
    const stage4 = readFileSync(join(projectRoot, ".claude/agents/orchestrator-stage-4.md"), "utf8");
    const section4d1 = stage4.slice(stage4.indexOf("### 4d.1"));
    assert.ok(section4d1.includes("--check no-antithesis-reveal --md {EDITION_DIR}/03-social.md"));
    assert.ok(section4d1.includes("--check no-trailing-editorial-hook --md {EDITION_DIR}/03-social.md"));
  });
});
