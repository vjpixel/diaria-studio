/**
 * test/eia-description-humanize-4258.test.ts (#4258 item 3)
 *
 * Cobre os dois scripts novos que dão suporte ao passo de
 * humanizador+Clarice sobre a frase de descrição do "É IA?" (Stage 3 do
 * orchestrator, ver .claude/agents/orchestrator-stage-3.md):
 *
 *   1. `scripts/extract-eia-description.ts` — extrai `wikimedia.description`
 *      de `01-eia-meta.json` pra um arquivo de texto plano.
 *   2. `scripts/apply-eia-description.ts` — recebe a frase já
 *      humanizada+corrigida e regrava `01-eia.md` (linha de crédito,
 *      REGERADA via `buildCreditLine` + o contexto persistido por
 *      `eia-compose.ts`) e `01-eia-meta.json` (`wikimedia.description`) de
 *      forma sincronizada — as duas saídas derivam do MESMO texto, nunca
 *      divergem.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSync } from "node:child_process";

import { extractDescriptionFromMeta } from "../scripts/extract-eia-description.ts";
import { replaceCreditLineInEiaMd } from "../scripts/apply-eia-description.ts";
import { buildCreditLine, buildEiaMd, chooseSides, PREV_RESULT_LINE_PREFIX } from "../scripts/eia-compose.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..");

function runExtractCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(PROJECT_ROOT, "scripts", "extract-eia-description.ts"), ...args],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
}

function runApplyCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(PROJECT_ROOT, "scripts", "apply-eia-description.ts"), ...args],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
}

// ── extractDescriptionFromMeta (pure) ───────────────────────────────────────

describe("extractDescriptionFromMeta (#4258 item 3, pure)", () => {
  it("extrai wikimedia.description quando presente", () => {
    const meta = { wikimedia: { description: "Uma ave rara em voo." } };
    assert.equal(extractDescriptionFromMeta(meta), "Uma ave rara em voo.");
  });

  it("description ausente → null (skip, não erro)", () => {
    assert.equal(extractDescriptionFromMeta({ wikimedia: {} }), null);
  });

  it("description vazia/só espaço → null", () => {
    assert.equal(extractDescriptionFromMeta({ wikimedia: { description: "" } }), null);
    assert.equal(extractDescriptionFromMeta({ wikimedia: { description: "   " } }), null);
  });

  it("wikimedia ausente → null", () => {
    assert.equal(extractDescriptionFromMeta({}), null);
  });

  it("input malformado (não-objeto, null, array) → null, nunca lança", () => {
    assert.equal(extractDescriptionFromMeta(null), null);
    assert.equal(extractDescriptionFromMeta(undefined), null);
    assert.equal(extractDescriptionFromMeta("string crua"), null);
    assert.equal(extractDescriptionFromMeta([1, 2, 3]), null);
  });

  it("description não-string (shape corrompido) → null", () => {
    assert.equal(extractDescriptionFromMeta({ wikimedia: { description: 123 } }), null);
  });
});

// ── replaceCreditLineInEiaMd (pure) ──────────────────────────────────────────

describe("replaceCreditLineInEiaMd (#4258 item 3, pure)", () => {
  const sides = chooseSides(0.5);

  it("substitui a creditLine preservando frontmatter + header, sem prevResultLine — byte-exato vs. buildEiaMd", () => {
    const md = buildEiaMd(sides, "Crédito original — [Foto](https://x.com/a) / CC BY-SA 4.0.", null);
    const newCredit = "Crédito corrigido — [Foto](https://x.com/a) / CC BY-SA 4.0.";
    const result = replaceCreditLineInEiaMd(md, newCredit);
    assert.match(result, /^---\neia_answer:/, "frontmatter preservado no início");
    assert.match(result, /\*\*É IA\?\*\*/, "header preservado");
    assert.match(result, /Crédito corrigido/);
    assert.ok(!result.includes("Crédito original"), "creditLine antiga não deve sobreviver");
    // Achado do review consolidado (pr-test-analyzer): asserções por
    // substring/match não pegam uma quebra sutil (ex: 1 newline a mais/a
    // menos) — comparar byte-a-byte contra o que buildEiaMd geraria direto
    // com a creditLine nova é o jeito de travar isso de verdade.
    assert.equal(result, buildEiaMd(sides, newCredit, null));
  });

  it("preserva prevResultLine intacta ao substituir a creditLine — byte-exato vs. buildEiaMd", () => {
    const prevResultLine = "Resultado da última edição: 62% das pessoas acertaram.";
    const md = buildEiaMd(sides, "Crédito original.", prevResultLine);
    const newCredit = "Crédito corrigido.";
    const result = replaceCreditLineInEiaMd(md, newCredit);
    assert.match(result, /Crédito corrigido\./);
    assert.match(result, /Resultado da última edição: 62% das pessoas acertaram\./);
    assert.ok(!result.includes("Crédito original"));
    assert.equal(result, buildEiaMd(sides, newCredit, prevResultLine));
  });

  it("#4258 item 3 (achado do review consolidado, bug real reproduzido e corrigido): creditLine antiga com quebra de linha interna NÃO vaza fragmento no resultado", () => {
    // Antes do fix, o boundary do fim da creditLine era achado via
    // rest.indexOf("\n\n") genérico — se a creditLine ANTIGA (texto livre,
    // já passado por humanizador/Clarice) tivesse uma quebra de linha
    // interna, esse indexOf casava com ELA em vez do separador de verdade
    // antes de um prevResultLine, deixando um fragmento da creditLine velha
    // sobrando no arquivo sem lançar nenhum erro. O fix ancora no prefixo
    // literal de PREV_RESULT_LINE_PREFIX (exportado por eia-compose.ts) em
    // vez de um "\n\n" genérico.
    const prevResultLine = `${PREV_RESULT_LINE_PREFIX} 62% das pessoas acertaram.`;
    const oldCreditWithInternalBlankLine = "Linha um.\n\nLinha dois (não pode vazar).";
    const md = buildEiaMd(sides, oldCreditWithInternalBlankLine, prevResultLine);
    const result = replaceCreditLineInEiaMd(md, "Nova linha única.");
    assert.ok(
      !result.includes("Linha dois (não pode vazar)"),
      `fragmento da creditLine antiga vazou no resultado: ${result}`,
    );
    assert.match(result, /Nova linha única\./);
    assert.match(result, /Resultado da última edição: 62% das pessoas acertaram\./);
    assert.equal(result, buildEiaMd(sides, "Nova linha única.", prevResultLine));
  });

  it("#4258 item 3 (mesmo bug, variante sem prevResultLine): creditLine antiga com quebra de linha interna e SEM prevResultLine também não vaza", () => {
    const oldCreditWithInternalBlankLine = "Linha um.\n\nLinha dois (não pode vazar).";
    const md = buildEiaMd(sides, oldCreditWithInternalBlankLine, null);
    const result = replaceCreditLineInEiaMd(md, "Nova linha única.");
    assert.ok(!result.includes("Linha dois (não pode vazar)"));
    assert.equal(result, buildEiaMd(sides, "Nova linha única.", null));
  });

  it("preserva o mapping eia_answer (A/B real|ia) byte-a-byte", () => {
    const md = buildEiaMd(sides, "X.", null);
    const result = replaceCreditLineInEiaMd(md, "Y.");
    const frontmatterOriginal = md.slice(0, md.indexOf("**É IA?**"));
    const frontmatterResult = result.slice(0, result.indexOf("**É IA?**"));
    assert.equal(frontmatterResult, frontmatterOriginal);
  });

  it("marcador \"**É IA?**\\n\\n\" ausente → lança (formato inesperado, falha alto)", () => {
    assert.throws(() => replaceCreditLineInEiaMd("texto qualquer sem o header", "novo"));
  });

  it("creditLine com markdown links inline sobrevive intacta quando é ela mesma o texto novo", () => {
    const md = buildEiaMd(sides, "Antiga.", null);
    const newCredit = "Uma [ave rara](https://en.wikipedia.org/wiki/Bird) — [Foto](https://x.com/a) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).";
    const result = replaceCreditLineInEiaMd(md, newCredit);
    assert.match(result, /\[ave rara\]\(https:\/\/en\.wikipedia\.org\/wiki\/Bird\)/);
    assert.match(result, /\[Foto\]\(https:\/\/x\.com\/a\)/);
  });
});

// ── Composição pura: extract → (humanizador/Clarice simulado) → apply ──────
// NÃO é fim-a-fim de verdade — chama as funções puras diretamente, sem
// spawnar os CLIs (rápido, bom pra iterar na lógica de composição). A
// cobertura real da CLI (exit codes, parsing de args, I/O) está no describe
// "extract-eia-description.ts CLI"/"apply-eia-description.ts CLI" abaixo,
// que spawna os scripts de verdade via subprocess (achado do review
// consolidado: chamar só as funções puras dava falsa confiança de que a
// wiring da CLI também estava coberta).

describe("#4258 item 3: extract + apply mantêm 01-eia.md e 01-eia-meta.json sincronizados (composição pura, sem subprocess)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eia-humanize-"));
  }

  it("frase corrigida aparece IDÊNTICA em wikimedia.description e na creditLine regerada", () => {
    const dir = makeDir();
    try {
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });

      const image = {
        title: "File:Test_bird.jpg",
        description: { text: "A rare bird flying over the mountains.", html: "A rare bird flying over the mountains." },
        artist: { text: "Jane Doe", html: '<a href="//commons.wikimedia.org/wiki/User:JaneDoe">Jane Doe</a>' },
        license: { type: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0" },
      };
      const originalSentence = "A rare bird flying over the mountains.";
      const originalCreditLine = buildCreditLine(image, { translatedSentence: originalSentence });
      writeFileSync(join(dir, "01-eia.md"), buildEiaMd(chooseSides(0.5), originalCreditLine, null));
      writeFileSync(
        join(internalDir, "01-eia-meta.json"),
        JSON.stringify({ edition: "260101", wikimedia: { description: originalSentence, credit: "Jane Doe" } }, null, 2),
      );
      writeFileSync(
        join(internalDir, "01-eia-compose-context.json"),
        JSON.stringify({ image, ptLabel: null, ptWikipediaUrl: null }, null, 2),
      );

      // Simula o passo de humanizador+Clarice do orchestrator: a frase
      // "melhora" (aqui, só uma substituição determinística pra não depender
      // de rede/skill no teste).
      const correctedSentence = "Uma ave rara sobrevoando as montanhas.";
      const correctedPath = join(internalDir, "01-eia-description-corrected.txt");
      writeFileSync(correctedPath, correctedSentence, "utf8");

      // Aplica manualmente a mesma lógica do main() de apply-eia-description.ts
      // (evita spawnar subprocess no teste — script fino sobre funções puras
      // já testadas acima).
      const context = JSON.parse(readFileSync(join(internalDir, "01-eia-compose-context.json"), "utf8"));
      const newCreditLine = buildCreditLine(context.image, {
        ptLabel: context.ptLabel,
        ptWikipediaUrl: context.ptWikipediaUrl,
        translatedSentence: correctedSentence,
      });
      const md = readFileSync(join(dir, "01-eia.md"), "utf8");
      const newMd = replaceCreditLineInEiaMd(md, newCreditLine);
      writeFileSync(join(dir, "01-eia.md"), newMd, "utf8");
      const meta = JSON.parse(readFileSync(join(internalDir, "01-eia-meta.json"), "utf8"));
      meta.wikimedia.description = correctedSentence;
      writeFileSync(join(internalDir, "01-eia-meta.json"), JSON.stringify(meta, null, 2), "utf8");

      const finalMd = readFileSync(join(dir, "01-eia.md"), "utf8");
      const finalMeta = JSON.parse(readFileSync(join(internalDir, "01-eia-meta.json"), "utf8"));

      assert.equal(finalMeta.wikimedia.description, correctedSentence);
      assert.match(finalMd, /Uma ave rara sobrevoando as montanhas/);
      assert.ok(!finalMd.includes(originalSentence), "frase antiga (EN) não deve sobreviver no md");
      assert.ok(!JSON.stringify(finalMeta).includes(originalSentence), "frase antiga não deve sobreviver no meta");
      // Nunca divergem: a frase corrigida aparece IGUAL nos dois lugares.
      assert.match(finalMd, new RegExp(correctedSentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── extract-eia-description.ts CLI (achado do review consolidado: zero ────
// cobertura da CLI de verdade — exit codes, parsing de args, I/O) ──────────

describe("extract-eia-description.ts CLI (#4258 item 3)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eia-extract-cli-"));
  }

  it("exit 1: args obrigatórios ausentes", () => {
    const r = runExtractCli([]);
    assert.equal(r.status, 1);
  });

  it("exit 0: description presente → escreve --out com o texto exato", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/01-eia-meta.json"),
        JSON.stringify({ wikimedia: { description: "Uma ave rara em voo." } }),
      );
      const outPath = join(dir, "_internal/01-eia-description-raw.txt");
      const r = runExtractCli(["--edition-dir", dir, "--out", outPath]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(outPath, "utf8"), "Uma ave rara em voo.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 2 (skip benigno): 01-eia-meta.json parseia OK mas sem description", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal/01-eia-meta.json"), JSON.stringify({ wikimedia: {} }));
      const r = runExtractCli(["--edition-dir", dir, "--out", join(dir, "out.txt")]);
      assert.equal(r.status, 2, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3 (erro de verdade): 01-eia-meta.json ausente", () => {
    const dir = makeDir();
    try {
      const r = runExtractCli(["--edition-dir", dir, "--out", join(dir, "out.txt")]);
      assert.equal(r.status, 3, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3 (erro de verdade): 01-eia-meta.json malformado (JSON inválido)", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal/01-eia-meta.json"), "{ isso não é json");
      const r = runExtractCli(["--edition-dir", dir, "--out", join(dir, "out.txt")]);
      assert.equal(r.status, 3, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── apply-eia-description.ts CLI (mesmo achado — zero cobertura da CLI) ───

describe("apply-eia-description.ts CLI (#4258 item 3)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eia-apply-cli-"));
  }

  function seedValidEdition(dir: string): { correctedPath: string } {
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    const image = {
      title: "File:Test_bird.jpg",
      description: { text: "A rare bird.", html: "A rare bird." },
      artist: { text: "Jane Doe", html: '<a href="//commons.wikimedia.org/wiki/User:JaneDoe">Jane Doe</a>' },
      license: { type: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0" },
    };
    const originalSentence = "A rare bird.";
    const originalCreditLine = buildCreditLine(image, { translatedSentence: originalSentence });
    writeFileSync(join(dir, "01-eia.md"), buildEiaMd(chooseSides(0.5), originalCreditLine, null));
    writeFileSync(
      join(internalDir, "01-eia-meta.json"),
      JSON.stringify({ edition: "260101", wikimedia: { description: originalSentence } }),
    );
    writeFileSync(
      join(internalDir, "01-eia-compose-context.json"),
      JSON.stringify({ image, ptLabel: null, ptWikipediaUrl: null }),
    );
    const correctedPath = join(internalDir, "01-eia-description-corrected.txt");
    writeFileSync(correctedPath, "Uma ave rara.", "utf8");
    return { correctedPath };
  }

  it("exit 1: args obrigatórios ausentes", () => {
    const r = runApplyCli([]);
    assert.equal(r.status, 1);
  });

  it("exit 0 (fim-a-fim de verdade via subprocess): regrava 01-eia.md + 01-eia-meta.json sincronizados", () => {
    const dir = makeDir();
    try {
      const { correctedPath } = seedValidEdition(dir);
      const r = runApplyCli(["--edition-dir", dir, "--corrected", correctedPath]);
      assert.equal(r.status, 0, r.stderr);
      const md = readFileSync(join(dir, "01-eia.md"), "utf8");
      const meta = JSON.parse(readFileSync(join(dir, "_internal/01-eia-meta.json"), "utf8"));
      assert.match(md, /Uma ave rara\./);
      assert.equal(meta.wikimedia.description, "Uma ave rara.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 2 (único skip benigno): 01-eia-compose-context.json ausente (edição pré-#4258)", () => {
    const dir = makeDir();
    try {
      const { correctedPath } = seedValidEdition(dir);
      rmSync(join(dir, "_internal/01-eia-compose-context.json"));
      const r = runApplyCli(["--edition-dir", dir, "--corrected", correctedPath]);
      assert.equal(r.status, 2, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3: --corrected ausente", () => {
    const dir = makeDir();
    try {
      seedValidEdition(dir);
      const r = runApplyCli(["--edition-dir", dir, "--corrected", join(dir, "nao-existe.txt")]);
      assert.equal(r.status, 3, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3: --corrected vazio", () => {
    const dir = makeDir();
    try {
      const { correctedPath } = seedValidEdition(dir);
      writeFileSync(correctedPath, "   ", "utf8");
      const r = runApplyCli(["--edition-dir", dir, "--corrected", correctedPath]);
      assert.equal(r.status, 3, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3: 01-eia-compose-context.json presente mas sem campo image válido", () => {
    const dir = makeDir();
    try {
      const { correctedPath } = seedValidEdition(dir);
      writeFileSync(join(dir, "_internal/01-eia-compose-context.json"), JSON.stringify({ ptLabel: null }));
      const r = runApplyCli(["--edition-dir", dir, "--corrected", correctedPath]);
      assert.equal(r.status, 3, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3: 01-eia-meta.json ausente", () => {
    const dir = makeDir();
    try {
      const { correctedPath } = seedValidEdition(dir);
      rmSync(join(dir, "_internal/01-eia-meta.json"));
      const r = runApplyCli(["--edition-dir", dir, "--corrected", correctedPath]);
      assert.equal(r.status, 3, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3: 01-eia-meta.json sem campo wikimedia", () => {
    const dir = makeDir();
    try {
      const { correctedPath } = seedValidEdition(dir);
      writeFileSync(join(dir, "_internal/01-eia-meta.json"), JSON.stringify({ edition: "260101" }));
      const r = runApplyCli(["--edition-dir", dir, "--corrected", correctedPath]);
      assert.equal(r.status, 3, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3: 01-eia.md ausente", () => {
    const dir = makeDir();
    try {
      const { correctedPath } = seedValidEdition(dir);
      rmSync(join(dir, "01-eia.md"));
      const r = runApplyCli(["--edition-dir", dir, "--corrected", correctedPath]);
      assert.equal(r.status, 3, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3 (o 'falhar alto' de replaceCreditLineInEiaMd nunca pode virar exit 2): 01-eia.md sem o header \"**É IA?**\"", () => {
    const dir = makeDir();
    try {
      const { correctedPath } = seedValidEdition(dir);
      writeFileSync(join(dir, "01-eia.md"), "conteúdo sem o header esperado");
      const r = runApplyCli(["--edition-dir", dir, "--corrected", correctedPath]);
      assert.equal(
        r.status,
        3,
        `#4258 item 3 (achado do review consolidado): o throw proposital de replaceCreditLineInEiaMd nunca pode ser reportado com o MESMO exit code do skip benigno (2) — stderr: ${r.stderr}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
