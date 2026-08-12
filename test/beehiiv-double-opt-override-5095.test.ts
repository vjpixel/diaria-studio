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
 * ## Por que a detecção é grosseira DE PROPÓSITO (revisão da PR #5096)
 *
 * A 1ª versão deste guard procurava `method: "POST"` numa janela de 400 chars
 * depois da URL. O review mostrou, com repro, que isso FALHA ABERTO: some a
 * detecção se o autor escrever `const opts = { method: "POST" }` antes da URL,
 * usar `{ method }` como variável, ou tiver um corpo grande o bastante pra
 * empurrar o token pra fora da janela. Todas são formas ordinárias de escrever
 * o mesmo fetch — e o modo de falha era o pior possível: o call site novo não
 * entrava em `found`, o `deepEqual` continuava passando dos dois lados, e o CI
 * ficava verde exatamente no cenário que o guard existe pra pegar.
 *
 * A regra agora não tenta entender a chamada. Ela é: **um arquivo que menciona
 * o endpoint de subscriptions E contém o token "POST" em qualquer lugar tem
 * que estar classificado** — ou como call site de criação (e aí carrega o
 * override), ou na allowlist de POST-pra-outro-endpoint, com motivo escrito.
 * Isso erra pro lado de exigir classificação a mais, nunca a menos: não existe
 * jeito de criar subscription sem a string "POST" e sem citar o endpoint.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Caminhos que CRIAM subscription. Cada um DEVE mandar
 * `double_opt_override: "off"` — sem isso o contato entra em `pending` e nunca
 * mais recebe e-mail, sem volta programática.
 */
const CREATE_CALL_SITES = [
  "scripts/evaluate-brevo-diaria.ts",
  "workers/cursos/src/subscribe.ts",
  "workers/poll/src/subscribe.ts",
  "workers/reativar/src/index.ts",
].sort();

/**
 * Arquivos que citam o endpoint de subscriptions e contêm "POST", mas cujo
 * POST vai pra OUTRO endpoint. Entrar aqui exige motivo verificável.
 */
const POST_TO_OTHER_ENDPOINT: Record<string, string> = {
  // O único POST deste script é `/custom_fields` (cria o campo `poll_token`,
  // idempotente). Sobre subscriptions ele só faz GET paginado e PATCH.
  "scripts/inject-poll-token.ts": "POST vai pra /custom_fields, não /subscriptions",
};

/** Diretórios varridos. `test/` fica de fora de propósito — mock não é call site. */
const SCAN_ROOTS = ["scripts", "workers"];

/** Menção ao endpoint de subscriptions, em qualquer método. */
const SUBSCRIPTIONS_ENDPOINT_RE = /\/publications\/\$\{[^}]+\}\/subscriptions/;

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

/** Remove linhas de docstring (`  * ...`) — comentário não é implementação. */
function stripDocstringLines(source: string): string {
  return source.replace(/^\s*\*.*$/gm, "");
}

/**
 * Um arquivo entra no radar do guard se cita o endpoint de subscriptions E
 * contém o token "POST". Grosseiro de propósito — ver docstring do topo.
 */
function touchesSubscriptionsWithPost(source: string): boolean {
  const code = stripDocstringLines(source);
  return SUBSCRIPTIONS_ENDPOINT_RE.test(code) && /"POST"/.test(code);
}

describe("#5095 — double_opt_override em todo POST de criação de subscription", () => {
  const flagged = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)))
    .filter((file) => touchesSubscriptionsWithPost(readFileSync(file, "utf8")))
    .map((file) => relative(REPO_ROOT, file).replace(/\\/g, "/"))
    .sort();

  it("todo arquivo que POSTa perto do endpoint de subscriptions está classificado", () => {
    const classified = [...CREATE_CALL_SITES, ...Object.keys(POST_TO_OTHER_ENDPOINT)].sort();
    assert.deepEqual(
      flagged,
      classified,
      "Um arquivo passou a mencionar /subscriptions com um POST e não está classificado. " +
        "Se ele CRIA subscription: mande `double_opt_override: \"off\"` (senão o contato " +
        "entra em `pending` e nunca mais recebe e-mail, sem volta programática) e some a " +
        "CREATE_CALL_SITES. Se o POST vai pra outro endpoint: some a POST_TO_OTHER_ENDPOINT " +
        "com o motivo.",
    );
  });

  for (const callSite of CREATE_CALL_SITES) {
    it(`${callSite} manda double_opt_override: "off"`, () => {
      const code = stripDocstringLines(readFileSync(join(REPO_ROOT, callSite), "utf8"));
      assert.match(
        code,
        /double_opt_override:\s*"off"/,
        `${callSite} cria subscription mas não isenta o fluxo do double opt-in da publicação.`,
      );
    });
  }

  it("a detecção pega as formas que a versão anterior deixava passar (#5096 review)", () => {
    // Estas 3 são as variações que o review provou que escapavam da heurística
    // de proximidade. Todas têm que ser detectadas agora.
    const methodBeforeUrl = `const opts = { method: "POST", body };
      await fetchImpl(\`\${base}/publications/\${pubId}/subscriptions\`, opts);`;
    const longBodyPushesMethodOut = `await fetchImpl(\`\${base}/publications/\${pubId}/subscriptions\`, {
      body: JSON.stringify({ ${"x".repeat(500)} }),
      method: "POST",
    });`;
    for (const [label, src] of [
      ["method antes da URL", methodBeforeUrl],
      ["corpo grande empurra o method pra longe", longBodyPushesMethodOut],
    ] as const) {
      assert.equal(touchesSubscriptionsWithPost(src), true, `não detectou: ${label}`);
    }
  });

  it("não dispara em arquivo que só LÊ o endpoint (sem POST)", () => {
    const readOnly = `await fetchImpl(\`\${base}/publications/\${pubId}/subscriptions?page=1\`);`;
    assert.equal(touchesSubscriptionsWithPost(readOnly), false);
  });

  it("não dispara em POST que não tem nada a ver com subscriptions", () => {
    const otherEndpoint = `await fetchImpl(\`\${base}/publications/\${pubId}/custom_fields\`, { method: "POST" });`;
    assert.equal(touchesSubscriptionsWithPost(otherEndpoint), false);
  });

  it("a varredura realmente encontra algo (não passa vazia por acidente)", () => {
    assert.equal(flagged.length > 0, true, "nenhum arquivo detectado — a varredura quebrou");
  });
});
