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

it("prompt de dispatch pede o anúncio de PR ao implementador, com destino e SHA completo (#13271)", () => {
  // #14044: o texto da regra mora no item 2 das regras de dispatch, que o
  // prompt cita; o prompt só aponta para ele.
  const i = skill.indexOf("O prompt do subagente inclui, obrigatoriamente:");
  assert.ok(i >= 0);
  const list = skill.slice(i, skill.indexOf("O subagente implementa,", i));
  assert.match(list, /`context\/overnight-dispatch-rules\.md` no início da própria sessão/);
  assert.match(list, /anúncio de PR por `SendMessage` ao coordenador logo após o `gh pr create` \(item 2, #3321\/#13271\)/);
  const item2 = rules.slice(rules.indexOf("## 2. "), rules.indexOf("## 3. "));
  assert.match(item2, /imediatamente após `gh pr create`,\s+enviar ao coordenador via `SendMessage`/);
  assert.match(item2, /destino `main`/);
  assert.match(item2, /SHA completo \(40 hex\)/);
  assert.match(item2, /Falha no envio não bloqueia/);
});

/** Só o parágrafo (linha) que começa no marcador, sem o bloco bash nem o trem que vêm depois. */
function paragraphFrom(text: string, marker: string): string {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, `marcador ausente: ${marker}`);
  const end = text.indexOf("\n", i);
  return text.slice(i, end < 0 ? undefined : end);
}

it("review_done sai no HEAD corrente com head_sha; gate2 só sobre o HEAD final (#13271)", () => {
  const p = paragraphFrom(skill, "**Marcos `ci_green`, `review_done` e `gate2` do timeline (#13271");
  assert.match(p, /`review_done` sai quando o review termina sobre o HEAD corrente, sem esperar a CI dele, com o `head_sha` em `details`/);
  assert.match(p, /`fix_iteration` vier depois .* o marco fica desatualizado/);
  assert.match(p, /`gate2` só sai sobre o HEAD final, depois da última `fix_iteration`/);
  assert.match(p, /`--match-head-commit`/);
  assert.doesNotMatch(p, /repetir depois de um push é inofensivo/);
});

// Pré-condição de merge fora do bullet do anúncio (#13271, review da PR #13445):
// com CI verde antes do self-review terminar, nenhuma thread existe e o Gate 2
// passaria à toa. Os três caminhos que levam a merge precisam citá-la.
it("ramo Verde: implementador retornado e self-review tratado é pré-condição de merge (#13271)", () => {
  const p = bulletFrom(skill, "   - Verde (CI verde **e** threads_não_resolvidas == 0) →");
  const verde = p.slice(0, p.indexOf("**Adquirir o merge lock"));
  assert.match(verde, /pré-condição de merge \(#13271\): o implementador já retornou e o self-review foi tratado/);
  assert.match(verde, /não mergear: só emitir `ci_green` e aguardar o retorno/);
  assert.match(verde, /`gate2` só se `review_done` já saiu/);
  assert.doesNotMatch(verde, /emitir `gate2` \(e `ci_green`/);
});

it("recheck do #11276: exit 0 só segue pro merge gate com o implementador retornado (#13271)", () => {
  const p = bulletFrom(skill, "**Toda espera de CI também arma o fallback wake");
  assert.match(p, /0 emite `ci_green`/);
  assert.match(p, /segue pro merge gate só se o implementador já retornou e o self-review foi tratado; senão, só emitir `ci_green` e aguardar o retorno/);
});

it("trem de merge: unidade em self-review não é elegível (#13271)", () => {
  const p = paragraphFrom(skill, "**Trem de merge (#6300");
  assert.match(p, /com o implementador já retornado e o self-review tratado \(pré-condição de merge, #13271/);
  const v = paragraphFrom(skill, "**Validação da combinação (#10927)");
  assert.match(v, /ainda estão implementando ou em self-review, que não são elegíveis até o retorno do implementador/);
});

it("espera de CI não é relançada no retorno, e ci_timeout conta do HEAD corrente (#13271)", () => {
  const p = bulletFrom(skill, "   - Esperar CI, ");
  assert.match(p, /se a espera ainda não foi lançada no anúncio para este HEAD \(senão, não lançar um 2º helper nem armar um 2º fallback wake\)/);
  const t = paragraphFrom(skill, "**Timeout de CI (ci_timeout, #2381):**");
  assert.match(t, /contados do início da espera sobre o HEAD corrente/);
  assert.match(t, /push do fixer reinicia a CI num HEAD novo e reinicia a contagem/);
  assert.doesNotMatch(t, /\(a partir do `pr_opened`\)/);
});

it("--agendado usa sempre o caminho sem anúncio (#13271)", () => {
  const p = paragraphFrom(skill, "- **Registro desassistido (passo 1):**");
  assert.match(p, /no `--agendado`, vale sempre o caminho sem anúncio de PR \(#13271\)/);
});

it("dispatch-rules nomeia o destino do anúncio (#13271)", () => {
  const i = rules.indexOf("**Anúncio de PR (overnight, develop e continuo; #13271):**");
  assert.match(rules.slice(i, i + 400), /destino `main`/);
});
