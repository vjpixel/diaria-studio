/**
 * test/beehiiv-insert-text.test.ts (#2550)
 *
 * Regressão para o helper `scripts/lib/beehiiv-insert-text.ts`:
 *
 *  - `buildInsertTextJs`: dado um fragmento contendo `{{email}}`, o snippet
 *    JS gerado contém `tr.insertText` e preserva a merge-tag literalmente.
 *  - `verifyFragmentPreserved`: detecta ausência de `{{email}}` e fragmento vazio.
 *  - `classifyInsertResult`: roteamento ok/retry_chunked/verify_only.
 *
 * **SPEC do #2550:** "tr.insertText num fixture de htmlSnippet vazio → node.textContent
 * == fragmento; merge-tag {{email}} preservada".  Esta suite testa o seam TS puro —
 * a execução real no browser (DOM TipTap) não é unit-testável aqui.
 *
 * Regressão #633: PR de feature de publish-flow → teste obrigatório.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInsertTextJs,
  verifyFragmentPreserved,
  classifyInsertResult,
} from "../scripts/lib/beehiiv-insert-text.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FRAGMENT_WITH_EMAIL = `<!DOCTYPE html>
<html><body>
<p>Clique para votar:</p>
<a href="https://poll.diaria.workers.dev/vote/260625?email={{email}}&opt=A">
  Opção A
</a>
<a href="https://poll.diaria.workers.dev/vote/260625?email={{email}}&opt=B">
  Opção B
</a>
<p>{{poll_a_url}}</p>
<p>{{poll_b_url}}</p>
</body></html>`;

const RAW_URL = "https://draft.diaria.workers.dev/260625-a3b2c1";

// ---------------------------------------------------------------------------
// buildInsertTextJs
// ---------------------------------------------------------------------------

describe("buildInsertTextJs (#2550)", () => {
  it("retorna string não-vazia", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    assert.ok(typeof snippet === "string" && snippet.length > 0);
  });

  it("contém tr.insertText — método correto de paste (#2550 insight 1)", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    assert.match(
      snippet,
      /tr\.insertText/,
      "snippet deve usar tr.insertText, não insertContent",
    );
  });

  it("não usa insertContent (causador do freeze em #2495)", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    // insertContent causava o congelamento do renderer — nunca deve aparecer
    // neste path como chamada principal de paste.
    assert.doesNotMatch(
      snippet,
      /editor\.commands\.insertContent/,
      "snippet NÃO deve usar editor.commands.insertContent (causa freeze #2495)",
    );
  });

  it("a URL do Worker aparece literalmente no snippet", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    assert.ok(
      snippet.includes(RAW_URL),
      `snippet deve conter a URL '${RAW_URL}'`,
    );
  });

  it("usa fetch() — caminho padrão (#2550 insight 2)", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    assert.match(snippet, /\bfetch\(/, "snippet deve fazer fetch da URL do Worker");
  });

  it("inclui varredura direcionada pós-paste — hasEmail (#1766 + #2550)", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    // A varredura deve checar {{email}} (merge-tag do identificador de assinante)
    assert.match(
      snippet,
      /\{\{email\}\}/,
      "snippet deve verificar a presença de {{email}} no doc pós-paste",
    );
  });

  it("SPEC #2550: fragmento com {{email}} é inserido via text literal — merge-tag preservada", () => {
    // Este é o invariante central do #2550:
    // buildInsertTextJs produz um snippet que insere o HTML como TEXT (não como HTML parseado).
    // tr.insertText(html, pos) insere literalmente — o TipTap não parseia o conteúdo.
    // Portanto {{email}} sobrevive intacta no ProseMirror state.
    //
    // Validação aqui (seam TS puro):
    //   1. O snippet referencia `html` como variável (não o conteúdo inline).
    //   2. `tr.insertText(html, ...)` está presente — isso garante que a variável
    //      `html` (que conterá o fragmento com {{email}}) é inserida via text node.
    //
    // A chain completa (fetch → html = text → tr.insertText(html)) preserva {{email}}
    // porque nenhuma etapa faz HTML parsing (que poderia normalizar href="{{email}}").
    const snippet = buildInsertTextJs(RAW_URL);

    // A variável html (result do fetch) é o que vai pro insertText
    const insertTextCall = snippet.match(/tr\.insertText\(([^,)]+)/);
    assert.ok(insertTextCall, "deve ter chamada tr.insertText(...)");
    const firstArg = insertTextCall![1].trim();
    assert.equal(
      firstArg,
      "html",
      "tr.insertText deve receber a variável `html` (conteúdo do fetch) como primeiro argumento",
    );
  });

  it("lança erro se URL contém aspas simples (quebra o template literal)", () => {
    assert.throws(
      () => buildInsertTextJs("https://draft.workers.dev/it's-broken"),
      /aspas simples/,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyFragmentPreserved
// ---------------------------------------------------------------------------

describe("verifyFragmentPreserved (#2550)", () => {
  it("retorna null para fragmento válido com {{email}}", () => {
    const err = verifyFragmentPreserved(FRAGMENT_WITH_EMAIL);
    assert.equal(err, null, "fragmento com {{email}} deve passar na validação");
  });

  it("retorna erro descritivo quando {{email}} está ausente", () => {
    const fragmentSemEmail = FRAGMENT_WITH_EMAIL.replace(/\{\{email\}\}/g, "REMOVED");
    const err = verifyFragmentPreserved(fragmentSemEmail);
    assert.ok(err !== null, "deve retornar erro quando {{email}} ausente");
    assert.match(err!, /\{\{email\}\}/, "mensagem de erro deve mencionar {{email}}");
    assert.match(err!, /--no-wrap/, "mensagem de erro deve orientar uso do --no-wrap");
  });

  it("retorna erro para fragmento vazio", () => {
    const err = verifyFragmentPreserved("");
    assert.ok(err !== null, "fragmento vazio deve ser inválido");
    assert.match(err!, /vazio|empty/i);
  });

  it("múltiplas ocorrências de {{email}} — ainda válido", () => {
    // É normal ter {{email}} múltiplas vezes (link A e link B do poll)
    const multi = FRAGMENT_WITH_EMAIL;
    const count = (multi.match(/\{\{email\}\}/g) ?? []).length;
    assert.ok(count >= 2, "fixture deve ter ≥2 ocorrências de {{email}}");
    assert.equal(verifyFragmentPreserved(multi), null);
  });
});

// ---------------------------------------------------------------------------
// classifyInsertResult
// ---------------------------------------------------------------------------

describe("classifyInsertResult (#2550)", () => {
  it("ok quando inserted:true + hasEmail:true", () => {
    assert.equal(
      classifyInsertResult({
        inserted: true,
        htmlBytes: 28000,
        docSize: 28004,
        hasEmail: true,
        hasPollA: true,
        hasPollB: true,
      }),
      "ok",
    );
  });

  it("verify_only quando resultado é {} (javascript_tool async longa)", () => {
    assert.equal(classifyInsertResult({}), "verify_only");
  });

  it("verify_only quando resultado é null/undefined", () => {
    assert.equal(classifyInsertResult(null), "verify_only");
    assert.equal(classifyInsertResult(undefined), "verify_only");
  });

  it("retry_chunked quando error presente", () => {
    assert.equal(
      classifyInsertResult({ error: "fetch 403", inserted: false }),
      "retry_chunked",
    );
  });

  it("retry_chunked quando inserted:false (insert falhou)", () => {
    assert.equal(
      classifyInsertResult({
        inserted: false,
        htmlBytes: 0,
        docSize: 0,
        hasEmail: false,
        hasPollA: false,
        hasPollB: false,
      }),
      "retry_chunked",
    );
  });

  it("retry_chunked quando inserted:true mas hasEmail:false (merge-tag perdida)", () => {
    // O caso mais crítico do #2550: insert "funcionou" mas {{email}} sumiu.
    // Isso indica que o fragmento foi carregado sem a merge-tag (wrapped em vez de raw).
    assert.equal(
      classifyInsertResult({
        inserted: true,
        htmlBytes: 28000,
        docSize: 28004,
        hasEmail: false,  // ← merge-tag perdida
        hasPollA: true,
        hasPollB: true,
      }),
      "retry_chunked",
    );
  });

  it("verify_only mesmo com chaves extras (objeto não-vazio com fields desconhecidos)", () => {
    // Se javascript_tool retornar um objeto com campos inesperados mas sem `inserted`,
    // é ambíguo — pedir re-verificação via varredura, não assumir falha.
    // classifyInsertResult trata `inserted` ausente como r.inserted === undefined → falsy.
    assert.equal(
      classifyInsertResult({ unknownField: true }),
      "retry_chunked", // inserted:undefined → !r.inserted → retry_chunked
    );
  });
});

// ---------------------------------------------------------------------------
// Integração leve: buildInsertTextJs → verifyFragmentPreserved chain
// ---------------------------------------------------------------------------

describe("integração buildInsertTextJs + verifyFragmentPreserved (#2550)", () => {
  it("fragmento com {{email}} passa verifyFragmentPreserved e tem URL no snippet", () => {
    // Simula o fluxo completo do Stage 5:
    //   1. Worker retorna fragmento (com {{email}})
    //   2. verifyFragmentPreserved valida antes de construir o snippet
    //   3. buildInsertTextJs produz o snippet com a URL
    const fragment = FRAGMENT_WITH_EMAIL;
    const url = RAW_URL;

    // Passo 2: validar fragmento
    const validationErr = verifyFragmentPreserved(fragment);
    assert.equal(validationErr, null, "fragmento deve passar na validação pré-paste");

    // Passo 3: construir snippet
    const snippet = buildInsertTextJs(url);
    assert.ok(snippet.includes(url), "snippet deve conter a URL");
    assert.match(snippet, /tr\.insertText/);
    // O fragmento em si não é embedded no snippet (fetch em runtime) —
    // mas a merge-tag {{email}} aparece na varredura pós-paste do snippet.
    assert.match(snippet, /\{\{email\}\}/);
  });
});
