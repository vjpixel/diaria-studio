/**
 * test/gh-pr-checks-json-loop-guard.test.ts (#8425)
 *
 * Fronteira lint-enforced (mesmo molde de `test/lib-boundary.test.ts` e
 * `test/skill-chained-session-command-guard-6232.test.ts`: scan estrutural
 * sobre arquivos rastreados do repo, sem executar nada) contra o padrão
 * que causou o incidente: um laço `until`/`while` escrito à mão em torno
 * de `gh pr checks ... --json ...` — comando que não roda no `gh` 2.46.0
 * do `300` (#6225), então nunca sai do laço, mesmo com a PR já mergeada
 * (achado ao vivo #8425: 5h04 de laço órfão).
 *
 * Este teste é a única defesa possível pra essa classe de incidente
 * dentro deste repo: o laço travado em si só é visível numa sessão SSH
 * externa, muito depois de o comando ter sido escrito. Pegar o padrão na
 * AUTORIA (aqui, no CI de PR) é o único ponto de intervenção que existe.
 *
 * Escopo: `.claude/skills/**\/SKILL.md`, `docs/**\/*.md`,
 * `context/**\/*.md` (onde instruções de coordenador/skill podem embutir
 * um comando de exemplo) e `scripts/**\/*.sh` (código shell real). Não
 * escaneia `.ts`/`.md` de teste (`test/**`) — citações de teste (como este
 * próprio arquivo, que cita o comando da issue em prosa/docstring) não são
 * instrução operacional que alguém copiaria e rodaria.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findGhPrChecksJsonLoopViolations,
  findGhPrChecksJsonLoopInScannedUnit,
  extractFencedCodeBlocks,
  stripShellCommentOnlyLines,
} from "../scripts/lib/gh-pr-checks-json-loop-guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("findGhPrChecksJsonLoopInScannedUnit — unidades isoladas", () => {
  it("comando real da issue (until ... gh pr checks --json ... done) => flagra", () => {
    const unit = `until gh pr checks 8397 --json bucket --jq 'all(.bucket != "pending")' | grep -q true; do sleep 30; done`;
    assert.equal(findGhPrChecksJsonLoopInScannedUnit(unit).length, 1);
  });

  it("variante while (em vez de until) => também flagra", () => {
    const unit = `while ! gh pr checks 123 --json bucket --jq '.'; do sleep 20; done`;
    assert.equal(findGhPrChecksJsonLoopInScannedUnit(unit).length, 1);
  });

  it("gh pr checks --json ANTES da palavra de laço (ordem invertida) => também flagra", () => {
    const unit = `RESULT=$(gh pr checks 9 --json bucket); until [ -n "$RESULT" ]; do sleep 5; done`;
    assert.equal(findGhPrChecksJsonLoopInScannedUnit(unit).length, 1);
  });

  it("gh pr checks --json SEM nenhuma palavra de laço perto => não flagra (citação/uso pontual, não é loop)", () => {
    const unit = `gh pr checks 8397 --json bucket --jq '[.[] | select(.bucket != "pass")] | length'`;
    assert.equal(findGhPrChecksJsonLoopInScannedUnit(unit).length, 0);
  });

  it("'until'/'while' e 'gh pr checks --json' longe demais um do outro => não flagra (janela de 300 chars)", () => {
    const filler = "x".repeat(500);
    const unit = `until true; do ${filler} gh pr checks 1 --json bucket; done`;
    assert.equal(findGhPrChecksJsonLoopInScannedUnit(unit).length, 0);
  });

  it("gh pr checks SEM --json (ex: --watch) dentro de um laço => não flagra — o defeito é específico do --json (#6225), não do polling em si", () => {
    const unit = `while true; do gh pr checks 123 --watch; sleep 20; done`;
    assert.equal(findGhPrChecksJsonLoopInScannedUnit(unit).length, 0);
  });

  it("marcador de opt-out explícito suprime o achado da unidade inteira", () => {
    const unit = `<!-- guard-allow: gh-pr-checks-json-loop -->\nuntil gh pr checks 1 --json bucket; do sleep 1; done`;
    assert.equal(findGhPrChecksJsonLoopInScannedUnit(unit).length, 0);
  });
});

describe("extractFencedCodeBlocks / stripShellCommentOnlyLines — extração por tipo de arquivo", () => {
  it("Markdown: só o conteúdo de blocos cercados é extraído, nunca prosa nem span inline", () => {
    const md =
      "Prosa citando `gh pr checks --json bucket` como referência histórica, nunca rode isso.\n\n" +
      "```bash\necho ok\n```\n";
    const blocks = extractFencedCodeBlocks(md);
    assert.deepEqual(blocks, ["echo ok\n"]);
  });

  it("shell: linha 100% comentário é removida; código com comentário inline é preservado", () => {
    const src = "# um laço `until gh pr checks 1 --json`; do sleep; done — nunca rodar\necho real_code\n";
    const stripped = stripShellCommentOnlyLines(src);
    assert.ok(!stripped.includes("nunca rodar"));
    assert.ok(stripped.includes("echo real_code"));
  });
});

describe("findGhPrChecksJsonLoopViolations — regressão do achado #8425", () => {
  it("SKILL.md hipotético com o comando literal da issue dentro de um bloco cercado => flagra, apontando pra revisão", () => {
    const md =
      "## Passo X\n\n```bash\nuntil gh pr checks $PR --json bucket --jq 'all(.bucket != \"pending\")' | grep -q true; do sleep 30; done\n```\n";
    const violations = findGhPrChecksJsonLoopViolations(md, "markdown");
    assert.equal(violations.length, 1);
  });

  it("mesmo comando citado como PROSA de aviso (não em bloco cercado) => não flagra — não é instrução executável", () => {
    const md =
      "Nunca escreva algo como `até gh pr checks 8397 --json bucket falhar` (mas isto é só o texto do exemplo, sem cercar).";
    // Sem bloco cercado nenhum: extractFencedCodeBlocks devolve [], então
    // nada é escaneado.
    assert.equal(findGhPrChecksJsonLoopViolations(md, "markdown").length, 0);
  });

  it("wait-pr-checks.sh real (que CITA o comando da issue no próprio cabeçalho de comentário) não se autoflagra", () => {
    const src = readFileSync(join(ROOT, "scripts", "lib", "wait-pr-checks.sh"), "utf8");
    assert.equal(findGhPrChecksJsonLoopViolations(src, "shell").length, 0);
  });

  it("mesma citação, mas dentro de um bloco ```bash CERCADO num SKILL.md (não um .sh real) => também não flagra — simetria de comentário entre markdown e shell", () => {
    // Achado de review da PR #8425: a 1ª versão só removia linhas de
    // comentário puro em arquivos .sh, deixando um bloco ```bash de
    // Markdown vulnerável ao mesmo falso-positivo que a docstring do
    // módulo promete evitar.
    const md =
      "## Histórico\n\n```bash\n# achado ao vivo: um laço `until gh pr checks $PR --json bucket; do sleep 30; done` travou 5h\necho \"nunca faça isso — use scripts/lib/wait-pr-checks.sh\"\n```\n";
    assert.equal(findGhPrChecksJsonLoopViolations(md, "markdown").length, 0);
  });
});

/** Lista recursiva de arquivos sob `dir` cujo nome bate `predicate`, ou
 *  `[]` se `dir` não existe. */
function filesUnder(dir: string, predicate: (relPath: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter(predicate)
    .map((f) => join(dir, f));
}

describe("varredura real do repo — nenhum arquivo rastreado pode introduzir o padrão", () => {
  const targets: Array<{ dir: string; kind: "markdown" | "shell"; match: (f: string) => boolean }> = [
    { dir: join(ROOT, ".claude", "skills"), kind: "markdown", match: (f) => f.endsWith(`${sep}SKILL.md`) || f === "SKILL.md" },
    { dir: join(ROOT, "docs"), kind: "markdown", match: (f) => f.endsWith(".md") },
    { dir: join(ROOT, "context"), kind: "markdown", match: (f) => f.endsWith(".md") },
    { dir: join(ROOT, "scripts"), kind: "shell", match: (f) => f.endsWith(".sh") },
    { dir: join(ROOT, "hermes"), kind: "shell", match: (f) => f.endsWith(".sh") },
  ];

  for (const { dir, kind, match } of targets) {
    const files = filesUnder(dir, match);
    if (files.length === 0) continue;

    it(`${relative(ROOT, dir)} (${kind}, ${files.length} arquivo(s)) — zero laços gh pr checks --json escritos à mão`, () => {
      const flagged: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        const violations = findGhPrChecksJsonLoopViolations(content, kind);
        for (const v of violations) {
          flagged.push(`${relative(ROOT, file)}: ${v.snippet}`);
        }
      }
      assert.deepEqual(
        flagged,
        [],
        `Laço gh pr checks --json escrito à mão encontrado (mesma classe do achado #8425 — ` +
          `sessão peer travada 5h+ porque --json não roda em gh 2.46.0, #6225). Use ` +
          `scripts/lib/wait-pr-checks.sh no lugar de reimplementar o laço: ${JSON.stringify(flagged, null, 2)}`,
      );
    });
  }
});
