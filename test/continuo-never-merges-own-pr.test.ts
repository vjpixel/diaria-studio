/**
 * test/continuo-never-merges-own-pr.test.ts (#6864)
 *
 * `hermes-diaria-continuo/SKILL.md` §3 costumava instruir "exit 0 → merge
 * no MESMO tick, como antes" — a delegação (mesma identidade/credencial
 * que abriu a PR) mergeando com base num gate honor-system
 * (`check-pr-review-authenticity.ts`, #6849). Decisão do editor (#6864):
 * remover a capacidade, não só endurecer o gate. Trava aqui pra ninguém
 * reintroduzir o verbo "por otimização" numa rodada futura — a issue
 * antecipa exatamente isso ("Se você chegou aqui pensando em reintroduzir
 * merge... não").
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = resolve(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md");

function readSkill(): string {
  return readFileSync(SKILL_PATH, "utf8");
}

/** Extrai a seção "### 3. Fila de PRs abertos..." até o próximo "### " —
 *  é o único lugar do playbook onde o TICK DO CONTÍNUO decide se mergeia
 *  a própria PR (não confundir com a descrição do pickup do #6823, que é
 *  outra skill/#/diaria-overnight, mencionada dentro desta seção só como
 *  contexto — essa PODE citar merge livremente, é comportamento de outro
 *  processo, não deste). */
function extractSection3(skill: string): string {
  const startMarker = "### 3. Fila de PRs abertos";
  const start = skill.indexOf(startMarker);
  assert.ok(start >= 0, "seção '### 3. Fila de PRs abertos' não encontrada no SKILL.md");
  const rest = skill.slice(start + startMarker.length);
  const nextHeaderIdx = rest.indexOf("\n### ");
  return nextHeaderIdx >= 0 ? rest.slice(0, nextHeaderIdx) : rest;
}

describe("hermes-diaria-continuo/SKILL.md §3 nunca autoriza a delegação a mergear a própria PR (#6864)", () => {
  it("não contém a frase-gatilho antiga 'merge no mesmo tick'", () => {
    const section = extractSection3(readSkill());
    assert.ok(
      !/merge no mesmo tick/i.test(section),
      "a instrução antiga de merge autônomo ('merge no mesmo tick') não pode voltar a §3 — decisão do editor, #6864",
    );
  });

  it("contém a instrução explícita 'NUNCA mergeia'/'NÃO mergear' + referência ao #6864", () => {
    const section = extractSection3(readSkill());
    assert.match(section, /N[AÃ]O\s+merge|NUNCA\s+mergei/i, "§3 precisa instruir explicitamente a nunca mergear");
    assert.match(section, /#6864/, "§3 precisa referenciar #6864 (por que a capacidade foi removida, não só reduzida)");
  });

  it("check-pr-review-authenticity.ts vira rótulo informativo, não gate de autorização — §3 não descreve NENHUM veredito positivo (exit 0/pass/aprovado/sucesso/ok) como 'autoriza merge'", () => {
    const section = extractSection3(readSkill());
    // Achado do review da PR #6873 (P2, confiança alta): checar só o
    // literal "exit 0" perto de "merge" é frágil a paráfrase — um texto
    // reescrito como "caso o resultado seja pass, fazer merge
    // imediatamente" passaria batido. Varre um conjunto de palavras que
    // um veredito POSITIVO plausivelmente usaria (exit 0, pass, aprovado,
    // sucesso, ok) e falha se QUALQUER uma aparecer perto de "merge" SEM
    // negação entre os dois — não é exaustivo (nenhuma checagem textual é,
    // ver #6849), mas fecha a paráfrase mais óbvia sem virar falso-positivo
    // no texto atual, que sempre nega.
    const positiveVerdictWords = /exit\s*0|\bpass\b|aprovad[oa]|sucesso|\bok\b/gi;
    let m: RegExpExecArray | null;
    while ((m = positiveVerdictWords.exec(section)) !== null) {
      const windowEnd = Math.min(section.length, m.index + m[0].length + 80);
      const after = section.slice(m.index + m[0].length, windowEnd);
      if (!/merge/i.test(after)) continue;
      assert.match(
        after,
        /n[aã]o|nunca/i,
        `§3 não pode condicionar merge a um veredito positivo ('${m[0]}') sem negação — trecho: "${m[0]}${after}"`,
      );
    }
  });

  it("a frase-âncora atual ('em TODOS os casos... NÃO mergear') está presente — checagem positiva, mais difícil de burlar por paráfrase que checagens negativas isoladas", () => {
    const section = extractSection3(readSkill());
    assert.match(
      section,
      /em\s+TODOS\s+os\s+casos[\s\S]{0,60}N[AÃ]O\s+mergear/i,
      "a frase-âncora que fecha explicitamente TODOS os vereditos (inclusive pass) precisa sobreviver — se ela sumir, mesmo os outros testes deste arquivo não garantem cobertura completa",
    );
  });

  it("a seção do pickup (#6823, dentro de §3 só como contexto de OUTRO processo) continua podendo descrever merge — não é o alvo desta trava", () => {
    const section = extractSection3(readSkill());
    assert.match(
      section,
      /pickup[\s\S]{0,400}merge|merge[\s\S]{0,400}pickup|mergeia se limpo/i,
      "a descrição do pickup do #6823 (mecanismo de OUTRA skill, /diaria-overnight) deveria seguir presente como contexto",
    );
  });
});
