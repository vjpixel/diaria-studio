/**
 * #11667 — padrão do 4º post (`## um`, USE MELHOR) como isca para a edição.
 *
 * Cenário real da issue (edição 261030): o `## um` mostrava parte das "15
 * funções do Claude" (Exame, marcada como "Pré-MBA" pelo
 * `sponsored-source-marker`) e fechava com "O guia completo está na edição de
 * hoje." — chamada que envelhece. Decisões do editor: isca sem dizer quantas
 * faltam, chamada com DATA, no fim do 3º parágrafo com uma frase antes, e item
 * marcado como publieditorial só é isca se o editor confirmar no gate.
 *
 * Cobre a lógica pura (`lintUseMelhorIsca`), o invariante do Stage 4
 * (`use-melhor-um-isca`, registrado e inerte com o 4º post desligado), a regra
 * em `context/editorial-rules.md` e o prompt do `social-writer`.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  editionCallDate,
  lintUseMelhorIsca,
  useMelhorEditionCall,
} from "../scripts/lib/use-melhor-isca.ts";
import {
  writeUseMelhorPostState,
  type UseMelhorCandidate,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import { checkUseMelhorIsca, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ON: UseMelhorPostConfigState = { enabled: true, time: "19:00" };
const OFF: UseMelhorPostConfigState = { enabled: false, time: null };

const P1 = "Peça ao Claude para **revisar contratos** e apontar cláusulas de risco antes de assinar.";
const P2 = "Ele também monta **planilhas a partir de anotações** soltas e explica cada fórmula que usou.";

/** Forma conforme: 3 parágrafos, chamada datada fechando o 3º com uma frase antes. */
const UM_OK = [
  P1,
  P2,
  "Dá para **resumir reuniões longas** em decisões e pendências. O guia completo está na edição de 30/10.",
  "#InteligenciaArtificial #Produtividade",
].join("\n\n");

/** Como saiu na 261030: chamada relativa ("de hoje"). */
const UM_261030 = UM_OK.replace("na edição de 30/10", "na edição de hoje");

describe("#11667 — chamada datada", () => {
  it("DD/MM vem do id AAMMDD; id inválido dá null", () => {
    assert.equal(editionCallDate("261030"), "30/10");
    assert.equal(editionCallDate("260105"), "05/01");
    assert.equal(editionCallDate("2610"), null);
    assert.equal(editionCallDate("261340"), null);
    assert.equal(useMelhorEditionCall("261030"), "O guia completo está na edição de 30/10.");
  });
});

describe("#11667 — lintUseMelhorIsca", () => {
  it("forma conforme passa limpa", () => {
    assert.deepEqual(lintUseMelhorIsca(UM_OK, { format: "prosa", editionId: "261030" }), []);
  });

  it("cenário real 261030: 'edição de hoje' é acusado (envelhece) e falta a chamada datada", () => {
    const p = lintUseMelhorIsca(UM_261030, { format: "prosa", editionId: "261030" }).join(" | ");
    assert.match(p, /chamada relativa "edição de hoje"/);
    assert.match(p, /sem a chamada datada/);
  });

  // #11824: sem a flag `u`, o `\b` final não existe depois de "amanhã" (ã não
  // é caractere de palavra) e a grafia correta escapava. Frases da issue.
  for (const frase of ["na edição de amanhã.", "na edição de amanhã tem", "na edição de amanhã"]) {
    it(`#11824: "${frase}" com acento é acusada como chamada relativa`, () => {
      const t = UM_OK.replace("na edição de 30/10.", frase);
      assert.match(lintUseMelhorIsca(t, { format: "prosa", editionId: "261030" }).join(" | "), /chamada relativa "edição de amanhã"/);
    });
  }

  it("#11824: chamada relativa com acento é acusada mesmo com data válida em outra frase", () => {
    const t = UM_OK.replace(P2, "Veja também na edição de amanhã. " + P2);
    const p = lintUseMelhorIsca(t, { format: "prosa", editionId: "261030" });
    assert.match(p.join(" | "), /chamada relativa "edição de amanhã"/);
  });

  it("#11824: sem acento continua casando; palavra que continua ('hojereis') não casa", () => {
    const sem = UM_OK.replace("na edição de 30/10.", "na edição de amanha.");
    assert.match(lintUseMelhorIsca(sem, { format: "prosa", editionId: "261030" }).join(" | "), /chamada relativa "edição de amanha"/);
    const cont = UM_OK.replace(P2, "A edição de hojereis não existe. " + P2);
    assert.doesNotMatch(lintUseMelhorIsca(cont, { format: "prosa", editionId: "261030" }).join(" | "), /chamada relativa/);
  });

  it("data da chamada diferente da edição é acusada", () => {
    const p = lintUseMelhorIsca(UM_OK, { format: "prosa", editionId: "261031" }).join(" | ");
    assert.match(p, /edição de 30\/10, mas esta edição é de 31\/10/);
  });

  it("dizer quantos faltam é acusado", () => {
    const t = UM_OK.replace(P1, "Mostramos 3 das 15 funções. " + P1);
    assert.match(lintUseMelhorIsca(t, { format: "prosa", editionId: "261030" }).join(" | "), /quantos itens faltam \("3 das 15"\)/);
  });

  it("prometer a lista inteira é acusado", () => {
    const t = UM_OK.replace(P2, "A lista completa vem a seguir. " + P2);
    assert.match(lintUseMelhorIsca(t, { format: "prosa", editionId: "261030" }).join(" | "), /promete "lista completa"/);
  });

  it("'15 funções' sem apontar para a edição é acusado mesmo no formato lista", () => {
    const t = ["1) Use as **15 funções** do Claude no trabalho.\n2) **Comece pelo resumo** de documentos.", "#InteligenciaArtificial"].join("\n\n");
    assert.match(lintUseMelhorIsca(t, { format: "lista", editionId: "261030" }).join(" | "), /cita "15 funções" sem apontar para a edição/);
  });

  it("formato lista sem número de itens não exige a chamada (tutorial segue com todos os passos, #9585)", () => {
    const t = ["1) Peça **o primeiro rascunho** de e-mails.\n2) **Resuma documentos longos**.", "#InteligenciaArtificial"].join("\n\n");
    assert.deepEqual(lintUseMelhorIsca(t, { format: "lista", editionId: "261030" }), []);
  });

  it("chamada no meio do texto (não no último parágrafo) é acusada", () => {
    const t = [P1 + " O guia completo está na edição de 30/10.", P2, "Dá para **resumir reuniões longas** em decisões e pendências.", "#IA"].join("\n\n");
    assert.match(lintUseMelhorIsca(t, { format: "prosa", editionId: "261030" }).join(" | "), /precisa fechar o último parágrafo/);
  });

  it("chamada como frase única do 3º parágrafo (sem frase antes) é acusada: o slide não a separa", () => {
    const t = [P1, P2, "O guia completo está na edição de 30/10.", "#IA"].join("\n\n");
    assert.match(lintUseMelhorIsca(t, { format: "prosa", editionId: "261030" }).join(" | "), /UMA única frase antes da chamada/);
  });

  it("negrito na chamada não esconde a data", () => {
    const t = UM_OK.replace("O guia completo está na edição de 30/10.", "O guia completo está **na edição de 30/10**.");
    assert.deepEqual(lintUseMelhorIsca(t, { format: "prosa", editionId: "261030" }), []);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function edition(um: string, item: UseMelhorCandidate): string {
  const base = mkdtempSync(join(tmpdir(), "um-isca-11667-"));
  dirs.push(base);
  const dir = join(base, "261030");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "03-social.md"), `# Social\n\n## d1\n\nTexto.\n\n## um\n\n${um}\n`, "utf8");
  writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item, generated_at: "x" });
  return dir;
}

const ITEM: UseMelhorCandidate = {
  url: "https://example.com/guia-claude",
  title: "15 funções do Claude",
  summary: "Guia.",
  score: 80,
};

describe("#11667 — invariante `use-melhor-um-isca` do Stage 4", () => {
  it("está registrado no Stage 4 como warning-only", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "use-melhor-um-isca");
    assert.ok(rule, "sem registro, check-invariants --stage 4 nunca roda o check");
    assert.equal(rule!.source_issue, "#11667");
  });

  it("cenário 261030 ('edição de hoje') vira warning", () => {
    const v = checkUseMelhorIsca(edition(UM_261030, ITEM), ON);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "use-melhor-um-isca");
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /edição de hoje/);
  });

  it("forma conforme não gera violação", () => {
    assert.deepEqual(checkUseMelhorIsca(edition(UM_OK, ITEM), ON), []);
  });

  it("inerte com o 4º post desligado", () => {
    assert.deepEqual(checkUseMelhorIsca(edition(UM_261030, ITEM), OFF), []);
  });

  it("item com marcador de publieditorial na URL pede confirmação no gate", () => {
    const sponsored = { ...ITEM, url: "https://exame.com/publicidade/15-funcoes-claude/" };
    const v = checkUseMelhorIsca(edition(UM_OK, sponsored), ON);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /publieditorial/);
    assert.match(v[0].message, /confirmar no gate/);
  });
});

describe("#11667 — regra e prompt", () => {
  it("editorial-rules documenta a isca, a chamada datada e o CTA por rede", () => {
    const rules = readFileSync(resolve(ROOT, "context/editorial-rules.md"), "utf8");
    assert.match(rules, /#11667/);
    assert.match(rules, /na edição de DD\/MM/);
    assert.match(rules, /sem dizer quantos? faltam|sem dizer quantas faltam/i);
    assert.match(rules, /Instagram/);
    assert.match(rules, /não fixado/);
  });

  it("social-writer pede a chamada datada no fim do 3º parágrafo, com uma frase antes", () => {
    const prompt = readFileSync(resolve(ROOT, ".claude/agents/social-writer.md"), "utf8");
    assert.match(prompt, /#11667/);
    assert.match(prompt, /na edição de DD\/MM/);
    assert.match(prompt, /uma única frase antes/i);
  });
});
