/**
 * Invariante #6196 — cada referência a `gh issue edit` em SKILL.md deve ter
 * `route-issue` como substituto (ou ressaltar #6196 como fallback até merge).
 *
 * Mecanismo de exceção (#6196, self-review): nem toda linha que menciona
 * `gh issue edit` é write-path prescritivo — algumas só FALAM SOBRE o
 * comando (definição de gatilho de outra regra, citação de passagem,
 * reconciliação de auditoria sobre labels arbitrárias que `route-issue`
 * genuinamente não cobre). Para essas, a linha carrega um marcador inline
 * `<!-- route-issue-exempt: motivo -->` — fica junto do texto que explica
 * o porquê, sobrevive a renumeração de linha (diferente de uma allowlist
 * por número de linha) e obriga quem adicionar uma exceção nova a
 * justificá-la ali mesmo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

/** Exige texto não-vazio (motivo) após o `:` — `<!-- route-issue-exempt: -->`
 * sem justificativa NÃO casa, de propósito (regressão abaixo cobre isso). */
const ROUTE_ISSUE_EXEMPT_RE = /<!--\s*route-issue-exempt:\s*[^\s>][^>]*-->/;
/** Mesma checagem de sempre ("route-issue" citado por perto), mas sem
 * confundir com o próprio marcador de exceção — `route-issue-exempt` NÃO
 * conta como "route-issue foi citado como substituto", senão um marcador
 * malformado (sem motivo) passaria pelo `hasRouteIssue` de qualquer jeito
 * e a exigência de justificativa da regex acima nunca seria exercitada. */
const ROUTE_ISSUE_MENTION_RE = /route-issue(?!-exempt)/;

function findSkmdFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...findSkmdFiles(full));
    } else if (entry.name.endsWith("SKILL.md")) {
      result.push(full);
    }
  }
  return result;
}

/**
 * Lógica pura do invariante — extraída pra ser testável com conteúdo
 * sintético (regressão do mecanismo de exceção), sem depender dos arquivos
 * reais do repo. Retorna uma violação por linha, no formato "N: <trecho>".
 */
export function findRouteIssueViolations(content: string): string[] {
  const lines = content.split("\n");
  const violations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("gh issue edit")) {
      // Check nearby lines (±3 lines) for route-issue reference, #6196
      // fallback note, ou marcador de exceção explícito.
      const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join("\n");
      const hasRouteIssue = ROUTE_ISSUE_MENTION_RE.test(window) || window.includes("#6196");
      const isExempt = ROUTE_ISSUE_EXEMPT_RE.test(window);
      if (!hasRouteIssue && !isExempt) {
        violations.push(`${i + 1}: ${line.trim()}`);
      }
    }
  }
  return violations;
}

/**
 * Um marcador de exceção deve cobrir UMA linha, não uma vizinhança.
 *
 * A janela de ±3 linhas que `findRouteIssueViolations` usa é o que permite ao
 * marcador ficar na linha de cima em vez de poluir o texto — mas ela também é
 * o vetor de abuso apontado no self-review do #6196: colar um marcador perto
 * de uma linha genuinamente prescritiva a exime de carona, sem que ninguém
 * tenha escrito uma justificativa pra ELA. Um marcador que alcança 2+ linhas
 * com `gh issue edit` é indistinguível de abuso, então é tratado como erro —
 * a correção é mover a linha prescritiva pra fora da janela ou dar a ela o
 * próprio marcador, com o próprio motivo.
 *
 * Retorna uma violação por marcador excessivamente abrangente.
 */
export function findOverreachingExemptions(content: string): string[] {
  const lines = content.split("\n");
  const violations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ROUTE_ISSUE_EXEMPT_RE.test(lines[i])) continue;
    const covered: number[] = [];
    for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 4); j++) {
      if (lines[j].includes("gh issue edit")) covered.push(j + 1);
    }
    if (covered.length > 1) {
      violations.push(
        `${i + 1}: marcador de exceção alcança ${covered.length} linhas com \`gh issue edit\` (${covered.join(", ")}) — cada uma precisa do próprio motivo`,
      );
    }
  }
  return violations;
}

describe("invariante #6196 — route-issue referenciado nas SKILLs", () => {
  it("cada SKILL.md que menciona `gh issue edit` também menciona `route-issue` (ou está exempta com motivo)", () => {
    const skillsDir = resolve(import.meta.dirname, "../.claude/skills");
    const skmdFiles = findSkmdFiles(skillsDir);
    const violations: string[] = [];
    for (const file of skmdFiles) {
      const content = readFileSync(file, "utf8");
      for (const v of findRouteIssueViolations(content)) {
        violations.push(`${file}:${v}`);
      }
    }
    assert.strictEqual(
      violations.length,
      0,
      `Issues sem referência a route-issue nem marcador de exceção (#6196):\n  ${violations.join("\n  ")}`,
    );
  });
});

describe("invariante #6196 — mecanismo de exceção `route-issue-exempt`", () => {
  it("linha com `gh issue edit` e SEM route-issue/marcador continua reprovando (o mecanismo não neutraliza o invariante)", () => {
    const content = "texto antes\nrodar `gh issue edit N --add-label foo` sem mais nada\ntexto depois\n";
    const violations = findRouteIssueViolations(content);
    assert.strictEqual(violations.length, 1);
    assert.match(violations[0], /gh issue edit N --add-label foo/);
  });

  it("linha com `gh issue edit` e marcador `route-issue-exempt` na MESMA linha passa, com motivo exigido", () => {
    const content =
      "rodar `gh issue edit N --add-label foo` <!-- route-issue-exempt: só documentação, não instrução --> resto\n";
    assert.deepStrictEqual(findRouteIssueViolations(content), []);
  });

  it("marcador `route-issue-exempt` dentro da janela de ±3 linhas também exime", () => {
    const content = [
      "<!-- route-issue-exempt: gatilho de outra regra -->",
      "linha 2",
      "linha 3",
      "rodar `gh issue edit N --add-label foo` aqui",
    ].join("\n");
    assert.deepStrictEqual(findRouteIssueViolations(content), []);
  });

  it("marcador `route-issue-exempt` FORA da janela de ±3 linhas NÃO exime (não é allowlist de arquivo inteiro)", () => {
    const lines = ["<!-- route-issue-exempt: bem longe -->"];
    for (let i = 0; i < 10; i++) lines.push(`linha de recheio ${i}`);
    lines.push("rodar `gh issue edit N --add-label foo` aqui");
    const content = lines.join("\n");
    const violations = findRouteIssueViolations(content);
    assert.strictEqual(violations.length, 1);
  });

  it("marcador sem motivo (`<!-- route-issue-exempt: -->` vazio, sem texto) não casa a regex — exige justificativa", () => {
    const content = "rodar `gh issue edit N --add-label foo` <!-- route-issue-exempt: --> resto\n";
    const violations = findRouteIssueViolations(content);
    assert.strictEqual(violations.length, 1);
  });
});

describe("invariante #6196 — sanidade do fixture usado no scan real", () => {
  it("os arquivos SKILL.md existem e são lidos (findSkmdFiles não está silenciosamente vazio)", () => {
    const skillsDir = resolve(import.meta.dirname, "../.claude/skills");
    const skmdFiles = findSkmdFiles(skillsDir);
    assert.ok(skmdFiles.length > 0, "esperava pelo menos 1 SKILL.md");
    for (const f of skmdFiles) {
      assert.ok(statSync(f).size > 0, `${f} está vazio`);
    }
  });
});

describe("mecanismo de exceção não pode eximir por vizinhança (#6196)", () => {
  it("nenhum marcador nas SKILLs reais alcança mais de uma linha com `gh issue edit`", () => {
    const skillsDir = resolve(import.meta.dirname, "../.claude/skills");
    const todas: string[] = [];
    for (const f of findSkmdFiles(skillsDir)) {
      for (const v of findOverreachingExemptions(readFileSync(f, "utf8"))) {
        todas.push(`${f}:${v}`);
      }
    }
    assert.deepEqual(todas, [], `Exceções abrangentes demais (#6196):\n    ${todas.join("\n    ")}`);
  });

  it("marcador que alcança 2 linhas prescritivas é acusado", () => {
    const conteudo = [
      "linha usando `gh issue edit N --add-label a`",
      "<!-- route-issue-exempt: motivo que só vale pra uma delas -->",
      "outra linha usando `gh issue edit N --add-label b`",
    ].join("\n");
    assert.equal(findOverreachingExemptions(conteudo).length, 1);
  });

  it("marcador que alcança exatamente 1 linha é aceito", () => {
    const conteudo = [
      "<!-- route-issue-exempt: define o gatilho, não instrui rodar -->",
      "toda vez que alguém rodar `gh issue edit N --add-label x`, registre",
    ].join("\n");
    assert.deepEqual(findOverreachingExemptions(conteudo), []);
  });

  it("linha com `gh issue edit` fora da janela do marcador não é contada", () => {
    const conteudo = [
      "linha usando `gh issue edit N --add-label a`",
      "filler",
      "filler",
      "filler",
      "<!-- route-issue-exempt: motivo -->",
      "linha usando `gh issue edit N --add-label b`",
    ].join("\n");
    // só a linha 6 cai na janela (±3) do marcador na linha 5; a linha 1 não.
    assert.deepEqual(findOverreachingExemptions(conteudo), []);
  });
});
