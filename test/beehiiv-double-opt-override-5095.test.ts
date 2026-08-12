/**
 * test/beehiiv-double-opt-override-5095.test.ts (#5095)
 *
 * GUARD DE INVENTÁRIO — todo caminho do repo que CRIA subscription na Beehiiv
 * (`POST /publications/{id}/subscriptions`) tem que mandar
 * `double_opt_override: "off"`.
 *
 * ## Por que um guard e não uma linha no CLAUDE.md
 *
 * Desde 260812 a publicação tem double opt-in LIGADO, pra barrar co-registro
 * externo de origem duvidosa (SparkLoop / parceiro `Techzip Newsletter`). Todo
 * cadastro que a Beehiiv receber sem o override entra em `pending` e fica
 * excluído de TODOS os envios até o contato clicar num e-mail de confirmação —
 * e a API da Beehiiv **não expõe** promoção programática pending→active
 * (confirmado na doc oficial, artigo "Double opt-in and Smart Nudge",
 * atualizado 08/07/2026).
 *
 * Isso é inofensivo pra quem chega pelo site (é o efeito desejado), mas é
 * destrutivo em 2 caminhos nossos que DELETAM o registro existente e recriam
 * do zero — `workers/reativar` e `scripts/evaluate-brevo-diaria`. Sem o
 * override, cada rodada apaga um assinante ATIVO e o recria em `pending`. O
 * `evaluate` roda desassistido todo dia às 05:30 BRT
 * (`Diaria-Brevo-Diaria-Evaluate`), então a regressão seria silenciosa, diária
 * e cumulativa — a pior combinação possível.
 *
 * Um comentário em CLAUDE.md não impede um call site novo de nascer errado.
 * Este teste impede: acrescentar um POST de criação sem o override quebra o
 * CI, e acrescentar um call site NOVO (mesmo correto) também quebra, forçando
 * a atualização consciente do inventário abaixo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Inventário fechado dos caminhos que criam subscription. Crescer esta lista é
 * uma decisão consciente: todo caminho novo precisa (a) mandar o override, ou
 * (b) ser deliberadamente sujeito ao double opt-in — e nesse caso sair daqui
 * com justificativa no PR.
 */
const EXPECTED_CREATE_CALL_SITES = [
  "scripts/evaluate-brevo-diaria.ts",
  "workers/cursos/src/subscribe.ts",
  "workers/poll/src/subscribe.ts",
  "workers/reativar/src/index.ts",
].sort();

/** Diretórios varridos. `test/` fica de fora de propósito — mock não é call site. */
const SCAN_ROOTS = ["scripts", "workers"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".wrangler") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Detecta um POST de CRIAÇÃO de subscription. Precisa casar os dois sinais na
 * mesma janela de texto porque o endpoint `/subscriptions` também é lido (GET
 * paginado) e deletado (DELETE por id) em vários scripts — só a criação
 * importa aqui.
 *
 * A janela de 400 chars cobre a distância real entre a URL e o `method` nos 4
 * call sites atuais (o maior gap é ~120 chars). Um call site que escreva o
 * fetch de forma muito mais espalhada escaparia da detecção — é por isso que o
 * inventário acima é uma lista fechada e não só um filtro: se a heurística
 * falhar em achar um dos 4 conhecidos, o teste de inventário quebra.
 */
function hasSubscriptionCreatePost(source: string): boolean {
  const stripped = source.replace(/^\s*\*.*$/gm, ""); // ignora blocos de docstring
  const urlRe = /\/publications\/\$\{[^}]+\}\/subscriptions`/g;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(stripped)) !== null) {
    const window = stripped.slice(match.index, match.index + 400);
    if (/method:\s*"POST"/.test(window)) return true;
  }
  return false;
}

describe("#5095 — double_opt_override em todo POST de criação de subscription", () => {
  const found = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)))
    .filter((file) => hasSubscriptionCreatePost(readFileSync(file, "utf8")))
    .map((file) => relative(REPO_ROOT, file).replace(/\\/g, "/"))
    .sort();

  it("o inventário de call sites que CRIAM subscription não mudou sem revisão", () => {
    assert.deepEqual(
      found,
      EXPECTED_CREATE_CALL_SITES,
      "Um caminho que cria subscription na Beehiiv foi adicionado ou removido. " +
        "Se for novo: ele DEVE mandar `double_opt_override: \"off\"` (senão o " +
        "contato entra em `pending` e nunca mais recebe e-mail, sem volta " +
        "programática). Depois de decidir, atualize EXPECTED_CREATE_CALL_SITES.",
    );
  });

  for (const callSite of EXPECTED_CREATE_CALL_SITES) {
    it(`${callSite} manda double_opt_override: "off"`, () => {
      const source = readFileSync(join(REPO_ROOT, callSite), "utf8");
      const code = source.replace(/^\s*\*.*$/gm, ""); // docstring não conta como implementação
      assert.match(
        code,
        /double_opt_override:\s*"off"/,
        `${callSite} cria subscription mas não isenta o fluxo do double opt-in da publicação.`,
      );
    });
  }

  it("a heurística de detecção realmente detecta (não passa vazia por acidente)", () => {
    assert.equal(found.length > 0, true, "nenhum call site detectado — a heurística quebrou");
    assert.equal(
      hasSubscriptionCreatePost('await fetch(`${base}/publications/${pubId}/subscriptions`, { method: "POST" })'),
      true,
    );
    // GET paginado e DELETE por id no MESMO endpoint não podem contar.
    assert.equal(
      hasSubscriptionCreatePost('await fetch(`${base}/publications/${pubId}/subscriptions?page=1`, { method: "GET" })'),
      false,
    );
  });
});
