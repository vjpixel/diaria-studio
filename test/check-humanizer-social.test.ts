/**
 * test/check-humanizer-social.test.ts (#2279)
 *
 * Testes de regressão para check-humanizer-social.ts:
 * - hash-match → exit 0
 * - sentinel ausente → exit 1
 * - hash diverge (social editado pós-humanização) → exit 2
 * - CLI subprocess tests covering --write / --check modes
 *
 * Simula o cenário real da edição 260615: social editado/reordenado após
 * humanização sem re-humanizar. Garante que o guard bloqueia nesse caso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkSentinel,
  computeSocialHash,
  writeSentinel,
  lintTicsOnMismatch,
  computeChangedSections,
} from "../scripts/check-humanizer-social.ts";

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/check-humanizer-social.ts");

const SOCIAL_CONTENT_A = `# LinkedIn
## d1
Post humanizado sem travessões.

# Facebook
## d1
Post humanizado sem marks IA.
`;

const SOCIAL_CONTENT_B = `# LinkedIn
## d1
Post DIFERENTE — editado manualmente pelo editor no gate do Stage 4.

# Facebook
## d1
Post também diferente.
`;

function mkEdition(socialContent?: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "humanizer-social-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (socialContent !== undefined) {
    writeFileSync(join(dir, "03-social.md"), socialContent, "utf8");
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("computeSocialHash (#2279)", () => {
  it("retorna hash sha256 hex de 64 chars", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const hash = computeSocialHash(join(dir, "03-social.md"));
      assert.equal(typeof hash, "string");
      assert.equal(hash.length, 64);
      assert.match(hash, /^[0-9a-f]+$/);
    } finally {
      cleanup();
    }
  });

  it("hash difere para conteúdo diferente", () => {
    const { dir: dirA, cleanup: cleanupA } = mkEdition(SOCIAL_CONTENT_A);
    const { dir: dirB, cleanup: cleanupB } = mkEdition(SOCIAL_CONTENT_B);
    try {
      const hashA = computeSocialHash(join(dirA, "03-social.md"));
      const hashB = computeSocialHash(join(dirB, "03-social.md"));
      assert.notEqual(hashA, hashB);
    } finally {
      cleanupA();
      cleanupB();
    }
  });

  it("hash idêntico para conteúdo idêntico (CRLF normalizado)", () => {
    const { dir: dirA, cleanup: cleanupA } = mkEdition(SOCIAL_CONTENT_A);
    // CRLF variant
    const { dir: dirB, cleanup: cleanupB } = mkEdition(SOCIAL_CONTENT_A.replace(/\n/g, "\r\n"));
    try {
      const hashA = computeSocialHash(join(dirA, "03-social.md"));
      const hashB = computeSocialHash(join(dirB, "03-social.md"));
      assert.equal(hashA, hashB, "CRLF e LF devem produzir o mesmo hash");
    } finally {
      cleanupA();
      cleanupB();
    }
  });
});

describe("writeSentinel (#2279)", () => {
  it("grava sentinel com sha256 do 03-social.md e retorna path", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const path = writeSentinel(dir);
      assert.match(path, /_internal[/\\]\.humanizer-social-done\.json$/);
      assert.ok(existsSync(path), "sentinel deve existir no disco");
      const data = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(typeof data.social_sha256 === "string");
      assert.equal(data.social_sha256.length, 64);
      assert.ok(typeof data.written_at === "string");
    } finally {
      cleanup();
    }
  });

  it("lança erro quando 03-social.md não existe", () => {
    const { dir, cleanup } = mkEdition(); // sem social
    try {
      assert.throws(() => writeSentinel(dir), /03-social\.md não existe/);
    } finally {
      cleanup();
    }
  });
});

const SOCIAL_CONTENT_MULTI = `# LinkedIn
## d1
Post d1 humanizado.

### comment_pixel
Comentário pessoal d1.

## d2
Post d2 humanizado.

### comment_pixel
Comentário pessoal d2.

## post_pixel
Post pixel humanizado.

# Facebook
## d1
Post Facebook d1.
`;

describe("writeSentinel — section_hashes (#3446)", () => {
  it("grava section_hashes junto com o hash whole-file", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_MULTI);
    try {
      const path = writeSentinel(dir);
      const data = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(data.section_hashes && typeof data.section_hashes === "object", "section_hashes deve estar presente");
      assert.ok(typeof data.section_hashes.main_d1 === "string" && data.section_hashes.main_d1.length === 64);
      assert.ok(typeof data.section_hashes.main_d2 === "string");
      assert.ok(typeof data.section_hashes.post_pixel === "string");
      assert.ok(typeof data.section_hashes.comment_pixel_d1 === "string");
    } finally {
      cleanup();
    }
  });
});

describe("computeChangedSections (#3446)", () => {
  it("legacy:true quando sentinel não tem section_hashes (gravado antes do #3446)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_MULTI);
    try {
      const sentinelPath = join(dir, "_internal", ".humanizer-social-done.json");
      // Simula sentinel legado: sem section_hashes
      writeFileSync(sentinelPath, JSON.stringify({
        social_sha256: computeSocialHash(join(dir, "03-social.md")),
        written_at: new Date().toISOString(),
      }), "utf8");
      const result = computeChangedSections(dir);
      assert.equal(result.legacy, true);
      assert.deepEqual(result.changed, []);
    } finally {
      cleanup();
    }
  });

  it("legacy:true quando sentinel está ausente", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_MULTI);
    try {
      // Sem writeSentinel — sentinel nunca foi gravado
      const result = computeChangedSections(dir);
      assert.equal(result.legacy, true);
    } finally {
      cleanup();
    }
  });

  it("detecta EXATAMENTE as seções que mudaram (só D2 editado no gate)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_MULTI);
    try {
      writeSentinel(dir); // sentinel com hashes de todas as seções

      // Simula ajuste no gate do Stage 4: só o D2 muda
      const edited = SOCIAL_CONTENT_MULTI.replace("Post d2 humanizado.", "Post d2 EDITADO no gate.");
      writeFileSync(join(dir, "03-social.md"), edited, "utf8");

      const result = computeChangedSections(dir);
      assert.equal(result.legacy, false);
      assert.deepEqual(result.changed, ["main_d2"], "apenas main_d2 deve aparecer em changed");
    } finally {
      cleanup();
    }
  });

  it("detecta múltiplas seções alteradas (D1 main + D2 comment_pixel)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_MULTI);
    try {
      writeSentinel(dir);
      let edited = SOCIAL_CONTENT_MULTI.replace("Post d1 humanizado.", "Post d1 EDITADO.");
      edited = edited.replace("Comentário pessoal d2.", "Comentário pessoal d2 EDITADO.");
      writeFileSync(join(dir, "03-social.md"), edited, "utf8");

      const result = computeChangedSections(dir);
      assert.equal(result.legacy, false);
      assert.deepEqual(result.changed.sort(), ["comment_pixel_d2", "main_d1"]);
    } finally {
      cleanup();
    }
  });

  it("changed vazio quando nada mudou (whole-file hash bateria também)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_MULTI);
    try {
      writeSentinel(dir);
      const result = computeChangedSections(dir);
      assert.equal(result.legacy, false);
      assert.deepEqual(result.changed, []);
    } finally {
      cleanup();
    }
  });
});

describe("checkSentinel (#2279) — cenários de regressão", () => {
  it("OK: sentinel presente e hash bate (humanizador rodou, social intacto)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // escreve sentinel com hash de CONTENT_A
      const result = checkSentinel(dir);
      assert.equal(result.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL sentinel_missing: humanizador nunca rodou (sem sentinel)", () => {
    // Cenário regressão 260615 furo (a): nada bloqueou quando humanizador foi
    // feito manualmente sem gravar sentinel.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      // Não chama writeSentinel → sentinel ausente
      const result = checkSentinel(dir);
      assert.equal(result.ok, false);
      assert.ok("reason" in result && result.reason === "sentinel_missing");
    } finally {
      cleanup();
    }
  });

  it("FAIL hash_mismatch: social editado pós-humanização sem re-humanizar", () => {
    // Cenário regressão 260615 furo (b): após reorder D3>D1>D2 e reescrita
    // do post_pixel no gate do Stage 4, social mudou mas não houve re-humanização.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // sentinel com hash de CONTENT_A
      // Simula edição posterior: editor reescreve o social no gate
      writeFileSync(join(dir, "03-social.md"), SOCIAL_CONTENT_B, "utf8");
      const result = checkSentinel(dir);
      assert.equal(result.ok, false);
      assert.ok("reason" in result && result.reason === "hash_mismatch");
      // Garantir que stored e current são expostos para logging
      assert.ok("stored" in result && typeof result.stored === "string");
      assert.ok("current" in result && typeof result.current === "string");
      assert.notEqual(result.stored, result.current);
    } finally {
      cleanup();
    }
  });

  it("FAIL sentinel_missing: sentinel existe mas 03-social.md sumiu (Drive pull falhou)", () => {
    // Sentiel existe (Stage 2 rodou) mas 03-social.md sumiu — isso é erro de pipeline,
    // não estado pré-Stage-2. Deve bloquear (false-negative corrigido via #2290).
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir);
      rmSync(join(dir, "03-social.md")); // simula Drive pull falhou + arquivo sumiu
      const result = checkSentinel(dir);
      assert.equal(result.ok, false, "sentinel presente + 03-social.md ausente deve bloquear");
      assert.ok("reason" in result && result.reason === "sentinel_missing");
    } finally {
      cleanup();
    }
  });

  it("FAIL sentinel_missing: sentinel JSON corrompido", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const sentinelPath = join(dir, "_internal", ".humanizer-social-done.json");
      writeFileSync(sentinelPath, "{ json inválido }", "utf8");
      const result = checkSentinel(dir);
      assert.equal(result.ok, false);
      assert.ok("reason" in result && result.reason === "sentinel_missing");
    } finally {
      cleanup();
    }
  });

  it("FAIL sentinel_missing: sentinel JSON sem social_sha256 (malformado)", () => {
    // Guard contra TypeError: undefined.slice(0,12) quando campo ausente.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const sentinelPath = join(dir, "_internal", ".humanizer-social-done.json");
      writeFileSync(sentinelPath, JSON.stringify({ written_at: new Date().toISOString() }), "utf8");
      const result = checkSentinel(dir);
      assert.equal(result.ok, false);
      assert.ok("reason" in result && result.reason === "sentinel_missing");
    } finally {
      cleanup();
    }
  });
});

describe("CLI — check-humanizer-social.ts (#2279 #2290)", () => {
  function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", SCRIPT_PATH, ...args],
      { encoding: "utf8", env: { ...process.env } },
    );
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("--write exits 0 and writes sentinel", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const result = runScript(["--write", "--edition-dir", dir]);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
      const sentinelPath = join(dir, "_internal", ".humanizer-social-done.json");
      assert.ok(existsSync(sentinelPath), "sentinel deve existir após --write");
      const data = JSON.parse(readFileSync(sentinelPath, "utf8"));
      assert.ok(typeof data.social_sha256 === "string" && data.social_sha256.length === 64);
    } finally {
      cleanup();
    }
  });

  it("--check exits 0 when sentinel matches (hash match)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // write via library
      const result = runScript(["--check", "--edition-dir", dir]);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  it("--check exits 1 when sentinel absent", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      // no writeSentinel call → sentinel absent
      const result = runScript(["--check", "--edition-dir", dir]);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    } finally {
      cleanup();
    }
  });

  it("--check exits 2 when hash diverges (social edited after humanization)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir);
      writeFileSync(join(dir, "03-social.md"), SOCIAL_CONTENT_B, "utf8"); // simulate post-humanization edit
      const result = runScript(["--check", "--edition-dir", dir]);
      assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  it("--check exit 2 reports EXACTLY the changed sections in stdout JSON (#3446)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_MULTI);
    try {
      writeSentinel(dir);
      const edited = SOCIAL_CONTENT_MULTI.replace("Post d2 humanizado.", "Post d2 EDITADO no gate.");
      writeFileSync(join(dir, "03-social.md"), edited, "utf8");
      const result = runScript(["--check", "--edition-dir", dir]);
      assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);

      const lines = result.stdout.trim().split("\n");
      const jsonLine = lines.find((l) => l.includes("changed_sections"));
      assert.ok(jsonLine, `stdout deve conter uma linha JSON com changed_sections; got:\n${result.stdout}`);
      const parsed = JSON.parse(jsonLine!);
      assert.equal(parsed.legacy, false);
      assert.deepEqual(parsed.changed_sections, ["main_d2"]);

      assert.ok(
        result.stderr.includes("SEÇÕES ALTERADAS") && result.stderr.includes("main_d2"),
        `stderr deve mencionar a seção alterada; got:\n${result.stderr}`,
      );
    } finally {
      cleanup();
    }
  });

  it("--check exit 2 reports legacy:true when stored sentinel predates #3446", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_MULTI);
    try {
      const sentinelPath = join(dir, "_internal", ".humanizer-social-done.json");
      writeFileSync(sentinelPath, JSON.stringify({
        social_sha256: computeSocialHash(join(dir, "03-social.md")),
        written_at: new Date().toISOString(),
      }), "utf8");
      const edited = SOCIAL_CONTENT_MULTI.replace("Post d2 humanizado.", "Post d2 EDITADO.");
      writeFileSync(join(dir, "03-social.md"), edited, "utf8");
      const result = runScript(["--check", "--edition-dir", dir]);
      assert.equal(result.status, 2);

      const lines = result.stdout.trim().split("\n");
      const jsonLine = lines.find((l) => l.includes("changed_sections"));
      const parsed = JSON.parse(jsonLine!);
      assert.equal(parsed.legacy, true, "sentinel sem section_hashes deve reportar legacy:true");
      assert.ok(
        result.stderr.includes("legacy") || result.stderr.includes("INTEIRO"),
        `stderr deve avisar sobre fallback full-file; got:\n${result.stderr}`,
      );
    } finally {
      cleanup();
    }
  });

  it("no flags → exits 1 with usage message", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const result = runScript(["--edition-dir", dir]);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.ok(result.stderr.includes("--write") || result.stderr.includes("--check"),
        "stderr should mention --write or --check");
    } finally {
      cleanup();
    }
  });
});

describe("--bypass-reason guard (#2373) — writeSentinel library", () => {
  it("primeiro --write (sem sentinel anterior) não exige bypass-reason", () => {
    // Cenário legítimo Stage 2: humanizador acaba de rodar, sem sentinel anterior.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      // Não deve lançar erro — primeiro write é sempre livre
      const path = writeSentinel(dir);
      assert.ok(existsSync(path), "sentinel deve existir");
      const data = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(!data.bypass_reason, "bypass_reason deve estar ausente no write inicial");
    } finally {
      cleanup();
    }
  });

  it("--write com hash idêntico ao sentinel anterior NÃO exige bypass-reason (sem mudança)", () => {
    // Social não mudou — re-gravar sentinel sem bypass é OK (caso: re-rodar Stage 2).
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // escreve sentinel com hash de CONTENT_A
      // Re-gravar com mesmo conteúdo: não deve lançar
      const path = writeSentinel(dir);
      assert.ok(existsSync(path));
    } finally {
      cleanup();
    }
  });

  it("--write sem bypass-reason FALHA quando hash diverge (social editado pós-humanização)", () => {
    // Cenário Stage 4 bug #2373: editor edita social no gate, orchestrator chama
    // --write sem re-humanizar → deve falhar.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // sentinel com hash de CONTENT_A
      writeFileSync(join(dir, "03-social.md"), SOCIAL_CONTENT_B, "utf8"); // simula edição pós-gate
      assert.throws(
        () => writeSentinel(dir), // sem bypassReason
        /bypass-reason/i,
        "deve exigir --bypass-reason quando hash diverge",
      );
    } finally {
      cleanup();
    }
  });

  it("--write COM bypass-reason PASSA quando hash diverge e registra motivo", () => {
    // Fluxo correto Stage 4: humanizador re-rodou após ajuste, --bypass-reason documenta isso.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // sentinel com hash de CONTENT_A
      writeFileSync(join(dir, "03-social.md"), SOCIAL_CONTENT_B, "utf8"); // simula edição
      const path = writeSentinel(dir, "humanizador re-rodou após swap D1↔D2 no Stage 4");
      assert.ok(existsSync(path), "sentinel deve existir após write com bypass");
      const data = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(typeof data.bypass_reason === "string" && data.bypass_reason.length > 0,
        "bypass_reason deve estar registrado no sentinel");
      assert.ok(data.bypass_reason.includes("D1↔D2"), "bypass_reason deve conter o motivo passado");
      // Hash deve ter sido atualizado para CONTENT_B
      const expected = computeSocialHash(join(dir, "03-social.md"));
      assert.equal(data.social_sha256, expected, "sentinel deve refletir o hash atual do social");
    } finally {
      cleanup();
    }
  });
});

describe("--bypass-reason guard (#2373) — CLI subprocess", () => {
  function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", SCRIPT_PATH, ...args],
      { encoding: "utf8", env: { ...process.env } },
    );
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("--write exits 3 (bypass required) when hash diverges without --bypass-reason", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // sentinel com hash de CONTENT_A
      writeFileSync(join(dir, "03-social.md"), SOCIAL_CONTENT_B, "utf8"); // simula edição pós-gate
      const result = runScript(["--write", "--edition-dir", dir]);
      assert.equal(result.status, 3,
        `expected exit 3 (bypass required), got ${result.status}\nstderr: ${result.stderr}`);
      assert.ok(
        result.stderr.toLowerCase().includes("bypass"),
        "stderr deve mencionar bypass",
      );
    } finally {
      cleanup();
    }
  });

  it("--write --bypass-reason exits 0 and stores reason when hash diverges", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // sentinel com hash de CONTENT_A
      writeFileSync(join(dir, "03-social.md"), SOCIAL_CONTENT_B, "utf8"); // simula edição pós-gate
      const result = runScript([
        "--write",
        "--bypass-reason", "humanizador re-rodou após ajuste Stage 4",
        "--edition-dir", dir,
      ]);
      assert.equal(result.status, 0,
        `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
      const sentinelPath = join(dir, "_internal", ".humanizer-social-done.json");
      const data = JSON.parse(readFileSync(sentinelPath, "utf8"));
      assert.ok(data.bypass_reason && data.bypass_reason.includes("Stage 4"),
        "bypass_reason deve estar no sentinel");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// #2529: Tic lint on hash mismatch — caso real 260624
// ---------------------------------------------------------------------------

/**
 * Social com construção de antítese-revelação ("não é X, é Y") — tic de IA
 * que o humanizador deveria ter removido mas passou por uma edição pós-humanização.
 * Reproduz o cenário 260624: editor edita social no gate do Stage 4, reintroduz
 * tom corporativo, e o guard deve detectar E sinalizar os tics.
 */
const SOCIAL_WITH_TICS = `# LinkedIn
## d1
Não é uma ferramenta, é uma revolução no mercado de trabalho.
Isso muda tudo no setor.

### comment_diaria
Leia a edição completa em {edition_url}
Siga a Diar.ia: linkedin.com/company/diar.ia.br

### comment_pixel
Compartilho minha perspectiva sobre isso.

## post_pixel
<!-- destaque: d1 -->
Não é hype, é tendência real.

# Facebook
## d1
Saiba mais em https://diar.ia.br.
`;

/** Social editado pós-humanização mas SEM tics de IA — apenas mudança de conteúdo legítima. */
const SOCIAL_EDITED_NO_TICS = `# LinkedIn
## d1
Post ajustado pelo editor no gate — sem tics de IA aqui.
Conteúdo direto, objetivo, sem construções problemáticas.

### comment_diaria
Leia a edição em {edition_url}
linkedin.com/company/diar.ia.br

### comment_pixel
Perspectiva direta sobre o tema.

## post_pixel
<!-- destaque: d1 -->
Ajuste editado sem tics.

# Facebook
## d1
Saiba mais em https://diar.ia.br.
`;

describe("lintTicsOnMismatch (#2529) — caso real 260624", () => {
  it("detecta tics de antítese-revelação em social editado pós-humanizador", () => {
    // Reproduz caso 260624: social editado no gate do Stage 4 com tics de IA
    const { dir, cleanup } = mkEdition(SOCIAL_WITH_TICS);
    try {
      const socialPath = join(dir, "03-social.md");
      const result = lintTicsOnMismatch(socialPath);
      assert.equal(result.ok, true, "lintTicsOnMismatch sempre retorna ok:true (WARN-ONLY)");
      assert.equal(result.tics_found, true, "deve detectar tics no social com antítese-revelação");
      assert.ok(result.antithesis_matches.length > 0,
        `deve ter matches de antítese-revelação; got ${result.antithesis_matches.length}`);
    } finally {
      cleanup();
    }
  });

  it("retorna tics_found:false quando social editado não tem tics", () => {
    // Caso onde edição foi só remoção de tic — não deve forçar re-humanização
    const { dir, cleanup } = mkEdition(SOCIAL_EDITED_NO_TICS);
    try {
      const socialPath = join(dir, "03-social.md");
      const result = lintTicsOnMismatch(socialPath);
      assert.equal(result.ok, true);
      assert.equal(result.tics_found, false, "social sem tics não deve acusar warning");
      assert.equal(result.antithesis_matches.length, 0);
      assert.equal(result.trailing_hook_matches.length, 0, "sem ganchos editoriais → array vazio (#2658)");
    } finally {
      cleanup();
    }
  });

  it("detecta gancho editorial ', e [trigger]' via trailing_hook_matches mesmo sem antítese (#2658)", () => {
    // Social editado pós-humanização: SEM antítese-revelação, mas COM gancho editorial.
    // Garante que o ramo OR de tics_found (hook-only) é exercitado e que o gancho
    // não passa invisível pela ausência de antítese.
    const SOCIAL_HOOK_ONLY = `# LinkedIn
## d1
A OpenAI colocou no ar a prévia do GPT-5.6, e a escolha de focos diz mais sobre estratégia do que os benchmarks revelam.

### comment_diaria
Leia em {edition_url}
linkedin.com/company/diar.ia.br

# Facebook
## d1
Saiba mais em https://diar.ia.br.
`;
    const { dir, cleanup } = mkEdition(SOCIAL_HOOK_ONLY);
    try {
      const socialPath = join(dir, "03-social.md");
      const result = lintTicsOnMismatch(socialPath);
      assert.equal(result.ok, true);
      assert.equal(result.antithesis_matches.length, 0, "este fixture não tem antítese-revelação");
      assert.ok(result.trailing_hook_matches.length > 0,
        `deve detectar gancho editorial; got ${result.trailing_hook_matches.length}`);
      assert.equal(result.tics_found, true, "tics_found deve ser true via ramo trailing_hook (OR)");
    } finally {
      cleanup();
    }
  });

  it("retorna tics_found:false graciosamente quando 03-social.md não existe", () => {
    const { dir, cleanup } = mkEdition(); // sem social
    try {
      const result = lintTicsOnMismatch(join(dir, "03-social.md"));
      assert.equal(result.ok, true);
      assert.equal(result.tics_found, false);
    } finally {
      cleanup();
    }
  });
});

describe("--check exits 2 + tic lint (#2529) — CLI subprocess", () => {
  function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", SCRIPT_PATH, ...args],
      { encoding: "utf8", env: { ...process.env } },
    );
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("--check exits 2 AND warns about tics when social edited with AI tics (#2529 caso 260624)", () => {
    // Reproduz caso 260624: sentinel foi gravado após humanizador, depois editor
    // editou o social no gate reintroduzindo antítese-revelação ("não é X, é Y").
    // O guard deve: (a) continuar saindo exit 2 (bloqueio existente), (b) mostrar
    // WARNs adicionais sobre os tics detectados.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A); // conteúdo humanizado inicial
    try {
      writeSentinel(dir); // grava sentinel com hash do social humanizado
      // Simula edição pós-humanização no gate do Stage 4 com tics de IA
      writeFileSync(join(dir, "03-social.md"), SOCIAL_WITH_TICS, "utf8");
      const result = runScript(["--check", "--edition-dir", dir]);
      // (a) continua exit 2 — não introduz novo código de saída
      assert.equal(result.status, 2,
        `expected exit 2 (hash mismatch), got ${result.status}\nstderr: ${result.stderr}`);
      // (b) avisa sobre tics detectados
      assert.ok(
        result.stderr.includes("TICS DE IA") || result.stderr.includes("antítese"),
        `stderr deve mencionar tics de IA; got:\n${result.stderr}`,
      );
    } finally {
      cleanup();
    }
  });

  it("--check exits 2 AND shows 'nenhum tic' info when social edited without tics (#2529 WARN correto)", () => {
    // Caso onde edição foi remoção de tic — editor NÃO deve ser forçado a re-humanizar.
    // WARN deve informar que não há tics, dando ao editor informação para decidir.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir);
      writeFileSync(join(dir, "03-social.md"), SOCIAL_EDITED_NO_TICS, "utf8");
      const result = runScript(["--check", "--edition-dir", dir]);
      // Ainda exit 2 (hash diverge = gate-blocking)
      assert.equal(result.status, 2,
        `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
      // Mas mensagem informa que não foram detectados tics (não forçar re-humanização)
      assert.ok(
        result.stderr.includes("nenhum tic") || result.stderr.includes("Lint de tics"),
        `stderr deve indicar que nenhum tic foi detectado; got:\n${result.stderr}`,
      );
      // NÃO deve conter a mensagem de tics encontrados
      assert.ok(
        !result.stderr.includes("TICS DE IA DETECTADOS"),
        "stderr não deve alegar tics encontrados quando social não tem tics",
      );
    } finally {
      cleanup();
    }
  });
});
