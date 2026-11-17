import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rules = readFileSync("context/overnight-dispatch-rules.md", "utf8");

it("implementador anuncia a PR por SendMessage antes do self-review (#13271)", () => {
  const i = rules.indexOf("**Anúncio de PR (overnight, develop e continuo; #13271):**");
  assert.ok(i >= 0);
  const block = rules.slice(i, i + 600);
  assert.match(block, /SendMessage/);
  assert.match(block, /antes de iniciar o self-review/);
  assert.match(block, /em\s+paralelo/);
});

it("o anúncio fica na seção 2, antes do bootstrap do worktree (#13271)", () => {
  assert.ok(rules.indexOf("**Anúncio de PR (overnight, develop e continuo; #13271):**") < rules.indexOf("## 3. Bootstrap do worktree"));
});

// Lado do coordenador (#13271): as edições no SKILL.md do overnight que a
// PR #13385 deixou pendentes (escrita em .claude/ negada no modo agendado).
const skill = readFileSync(".claude/skills/diaria-overnight/SKILL.md", "utf8");

/** Do marcador até o próximo bullet de mesmo nível (ou o fim do arquivo). */
function bulletFrom(text: string, marker: string): string {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, `marcador ausente: ${marker}`);
  const end = text.indexOf("\n   - ", i + marker.length);
  return text.slice(i, end < 0 ? undefined : end);
}

it("coordenador inicia a espera de CI ao receber o anúncio, sem esperar o retorno (#13271)", () => {
  const p = bulletFrom(skill, "**Anúncio de PR: a espera de CI começa em paralelo ao self-review (#13271");
  assert.match(p, /wait-pr-checks\.sh/);
  assert.match(p, /fallback wake/);
  assert.match(p, /sem esperar o retorno/);
  assert.match(p, /não despachar fixer e não mergear antes do retorno/);
  assert.match(p, /Sem anúncio/);
});

it("prompt de dispatch pede o anúncio de PR ao implementador (#13271)", () => {
  const i = skill.indexOf("O prompt do subagente inclui, obrigatoriamente:");
  assert.ok(i >= 0);
  assert.match(skill.slice(i), /\*\*anúncio de PR \(#13271\)\*\*: logo após o `gh pr create`, `SendMessage`/);
});

it("review_done e gate2 só sobre o HEAD final, depois da última fix_iteration (#13271)", () => {
  const p = bulletFrom(skill, "**Marcos `ci_green`, `review_done` e `gate2` do timeline (#13271");
  assert.match(p, /`review_done` e `gate2` só saem sobre o HEAD final, depois da última `fix_iteration`/);
  assert.match(p, /`--match-head-commit`/);
  assert.doesNotMatch(p, /repetir depois de um push é inofensivo/);
});

it("ramo Verde só emite gate2 se review_done já saiu (#13271)", () => {
  const p = bulletFrom(skill, "   - Verde (CI verde **e** threads_não_resolvidas == 0) →");
  const verde = p.slice(0, p.indexOf("**Adquirir o merge lock"));
  assert.match(verde, /`gate2` só se `review_done` já saiu para este HEAD/);
  assert.doesNotMatch(verde, /emitir `gate2` \(e `ci_green`/);
});

it("recheck do #11276 emite ci_green no exit 0 (#13271)", () => {
  const p = bulletFrom(skill, "**Toda espera de CI também arma o fallback wake");
  assert.match(p, /0 segue pro merge gate, emitindo `ci_green`/);
});
