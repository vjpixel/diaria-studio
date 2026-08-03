/**
 * test/beehiiv-insert-text.test.ts (#2550, timeout+fallback+verificação #4196)
 *
 * Regressão para o helper `scripts/lib/beehiiv-insert-text.ts`:
 *
 *  - `buildInsertTextJs`: dado um fragmento contendo `{{email}}`, o snippet
 *    JS gerado contém `tr.insertText` e preserva a merge-tag literalmente.
 *  - `verifyFragmentPreserved`: detecta ausência de `{{email}}` e fragmento vazio.
 *  - `classifyInsertResult`: roteamento ok/retry_chunked/verify_only.
 *  - (#4196) `buildInsertTextJs` com fetch que nunca resolve → timeout dispara →
 *    `classifyInsertResult` roteia pro fallback chunked automaticamente.
 *  - (#4196) `verifyBodySizePlausible`/`readLocalFragmentBytes`: verificação de
 *    tamanho pós-paste — corpo vazio/truncado não "declara sucesso silenciosamente".
 *
 * **SPEC do #2550:** "tr.insertText num fixture de htmlSnippet vazio → node.textContent
 * == fragmento; merge-tag {{email}} preservada".  Esta suite testa o seam TS puro —
 * a execução real no browser (DOM TipTap) não é unit-testável aqui.
 *
 * **SPEC do #4196:** o critério de aceite é comportamental ("fetch pendurado →
 * timeout dispara → cai no chunked automaticamente"), não só textual — por isso o
 * describe "buildInsertTextJs timeout" abaixo efetivamente `eval()`a o snippet
 * gerado contra um `fetch` mock que só resolve/rejeita quando abortado (replica o
 * comportamento real de `fetch` + `AbortController` em browsers), em vez de só
 * inspecionar a string produzida.
 *
 * Regressão #633: PR de feature de publish-flow → teste obrigatório.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInsertTextJs,
  verifyFragmentPreserved,
  classifyInsertResult,
  verifyBodySizePlausible,
  readLocalFragmentBytes,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MIN_BODY_SIZE_RATIO,
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

  it("#4512 (achado pr-test-analyzer): varredura hasEmail também checa {{poll_token}} — branch novo do #4487 nunca coberto por este arquivo", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    // #4487 trocou a URL de voto pro token opaco {{poll_token}} — a varredura
    // 'hasEmail' passou a checar `n.text.includes('{{poll_token}}') ||
    // n.text.includes('{{email}}')` (scripts/lib/beehiiv-insert-text.ts:159),
    // mas nenhum teste até aqui cobria explicitamente o branch novo — só o
    // legado {{email}} (teste acima). Sem isso, uma regressão que quebrasse
    // só a checagem de {{poll_token}} (ex: typo, remoção acidental do OR)
    // passaria batido pela suíte.
    assert.match(
      snippet,
      /\{\{poll_token\}\}/,
      "snippet deve verificar a presença de {{poll_token}} no doc pós-paste (#4487)",
    );
    assert.match(
      snippet,
      /n\.text\.includes\('\{\{poll_token\}\}'\)\s*\|\|\s*n\.text\.includes\('\{\{email\}\}'\)/,
      "a varredura hasEmail deve checar {{poll_token}} OU {{email}} — nem uma sozinha basta (regressão do #4487)",
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

  it("usa AbortController + timeout no fetch (#4196)", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    assert.match(snippet, /new AbortController\(\)/, "snippet deve criar um AbortController");
    assert.match(
      snippet,
      /signal:\s*controller\.signal/,
      "snippet deve passar controller.signal pro fetch",
    );
  });

  it("default timeoutMs é DEFAULT_FETCH_TIMEOUT_MS (#4196)", () => {
    const snippet = buildInsertTextJs(RAW_URL);
    assert.match(
      snippet,
      new RegExp(`controller\\.abort\\(\\),\\s*${DEFAULT_FETCH_TIMEOUT_MS}\\)`),
      `snippet deve usar o timeout default (${DEFAULT_FETCH_TIMEOUT_MS}ms)`,
    );
  });

  it("timeoutMs customizado aparece literalmente no snippet (#4196)", () => {
    const snippet = buildInsertTextJs(RAW_URL, 5000);
    assert.match(snippet, /controller\.abort\(\),\s*5000\)/);
    // não deve sobrar o default quando um valor customizado foi passado
    assert.doesNotMatch(snippet, new RegExp(`,\\s*${DEFAULT_FETCH_TIMEOUT_MS}\\)`));
  });
});

// ---------------------------------------------------------------------------
// #4196 — timeout do fetch in-page dispara o fallback chunked automaticamente
// ---------------------------------------------------------------------------

describe("buildInsertTextJs timeout (#4196) — fetch pendurado nunca resolve", () => {
  it("aborta após o timeout e retorna error:fetch_timeout — critério de aceite: cai no fallback chunked SEM intervenção", async () => {
    const TIMEOUT_MS = 30; // curto de propósito — o teste não deve esperar os 25s reais de produção
    const snippet = buildInsertTextJs(RAW_URL, TIMEOUT_MS);

    const originalFetch = (globalThis as { fetch?: unknown }).fetch;

    // Mock de fetch que replica o comportamento real de fetch+AbortController em
    // browsers: a promise NUNCA resolve por conta própria (simula o Worker/CSP
    // pendurado do #2495), só rejeita quando o AbortSignal dispara.
    (globalThis as { fetch: (url: string, opts: { signal: AbortSignal }) => Promise<unknown> }).fetch = (
      _url: string,
      opts: { signal: AbortSignal },
    ) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    try {
      // eslint-disable-next-line no-eval -- exercita o snippet gerado de fato, não só a string
      const result = (await eval(snippet)) as {
        error?: string;
        url?: string;
        timeoutMs?: number;
      };

      assert.equal(result.error, "fetch_timeout", "fetch pendurado deve produzir error:fetch_timeout");
      assert.equal(result.url, RAW_URL);
      assert.equal(result.timeoutMs, TIMEOUT_MS);

      // O critério de aceite real do #4196: esse resultado precisa cair automaticamente
      // no fallback chunked — mesmo caminho de qualquer outro erro de fetch, sem
      // nenhuma lógica adicional/intervenção manual.
      assert.equal(
        classifyInsertResult(result),
        "retry_chunked",
        "timeout deve rotear pro fallback chunked automaticamente, sem intervenção",
      );
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
    }
  });

  it("erro de rede (não-abort) também produz error detectável (não trava a promise)", async () => {
    const snippet = buildInsertTextJs(RAW_URL, 5000);
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;

    (globalThis as { fetch: () => Promise<unknown> }).fetch = () =>
      Promise.reject(new TypeError("Failed to fetch"));

    try {
      // eslint-disable-next-line no-eval
      const result = (await eval(snippet)) as { error?: string };
      assert.ok(result.error?.startsWith("fetch_exception:"), "erro de rede deve virar fetch_exception, não travar");
      assert.equal(classifyInsertResult(result), "retry_chunked");
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// #4196 — verificação de tamanho pós-paste
// ---------------------------------------------------------------------------

describe("verifyBodySizePlausible (#4196)", () => {
  it("ok:true quando observedBytes está dentro da razão mínima do esperado", () => {
    const result = verifyBodySizePlausible(9500, 10000);
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
    assert.ok(result.ratio >= DEFAULT_MIN_BODY_SIZE_RATIO);
  });

  it("ok:false reason:empty_body quando o corpo é vazio — falha explícita, não sucesso silencioso", () => {
    const result = verifyBodySizePlausible(0, 10000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty_body");
  });

  it("ok:false reason:body_too_small quando o corpo é bem menor que o arquivo local (paste truncado/parcial)", () => {
    const result = verifyBodySizePlausible(2000, 10000); // 20% do esperado
    assert.equal(result.ok, false);
    assert.equal(result.reason, "body_too_small");
    assert.ok(result.ratio < DEFAULT_MIN_BODY_SIZE_RATIO);
  });

  it("ok:false reason:expected_bytes_invalid quando expectedBytes <= 0 (uso incorreto do caller)", () => {
    const result = verifyBodySizePlausible(5000, 0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expected_bytes_invalid");
  });

  it("respeita minRatio customizado", () => {
    const result = verifyBodySizePlausible(5000, 10000, 0.4);
    assert.equal(result.ok, true, "50% >= 40% (minRatio customizado) deve passar");
  });

  it("valores negativos de observedBytes são tratados como corpo vazio, não como sucesso", () => {
    const result = verifyBodySizePlausible(-1, 10000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty_body");
  });
});

describe("readLocalFragmentBytes (#4196)", () => {
  it("mede bytes UTF-8 (não unidades UTF-16) — relevante pra conteúdo PT-BR acentuado", () => {
    const tmpPath = join(tmpdir(), `beehiiv-insert-text-test-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    const content = "<p>Título com acentuação: ção, ã, é, ç, à</p>";
    writeFileSync(tmpPath, content, "utf8");
    try {
      const bytes = readLocalFragmentBytes(tmpPath);
      assert.equal(bytes, Buffer.byteLength(content, "utf8"));
      assert.ok(
        bytes > content.length,
        "bytes UTF-8 devem exceder .length UTF-16 quando o conteúdo tem acentos PT-BR",
      );
    } finally {
      unlinkSync(tmpPath);
    }
  });
});

describe("integração: paste classificado 'ok' porém truncado é pego pela verificação de tamanho (#4196)", () => {
  it("classifyInsertResult diz ok, mas verifyBodySizePlausible detecta o corpo truncado — falha explícita, não sucesso silencioso", () => {
    const truncatedResult = {
      inserted: true,
      htmlBytes: 500, // muito menor que o arquivo local (simulando paste parcial)
      docSize: 504,
      hasEmail: true,
      hasPollA: true,
      hasPollB: true,
    };

    // classifyInsertResult sozinho não detecta truncamento — é exatamente por
    // isso que verifyBodySizePlausible existe como passo separado (#4196).
    assert.equal(classifyInsertResult(truncatedResult), "ok");

    const sizeCheck = verifyBodySizePlausible(truncatedResult.htmlBytes, 28341);
    assert.equal(sizeCheck.ok, false);
    assert.equal(sizeCheck.reason, "body_too_small");
  });

  it("classifyInsertResult diz ok E verifyBodySizePlausible confirma tamanho plausível — sucesso real", () => {
    const fullResult = {
      inserted: true,
      htmlBytes: 27800,
      docSize: 27804,
      hasEmail: true,
      hasPollA: true,
      hasPollB: true,
    };
    assert.equal(classifyInsertResult(fullResult), "ok");
    const sizeCheck = verifyBodySizePlausible(fullResult.htmlBytes, 28341);
    assert.equal(sizeCheck.ok, true);
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
    // #4487: a merge tag de identidade virou {{poll_token}} — a mensagem de
    // erro passou a citar essa forma (a atual), não mais {{email}} (legado).
    assert.match(err!, /\{\{poll_token\}\}/, "mensagem de erro deve mencionar {{poll_token}}");
    assert.match(err!, /--no-wrap/, "mensagem de erro deve orientar uso do --no-wrap");
  });

  it("#4487: retorna null para fragmento com {{poll_token}} (token opaco, forma atual)", () => {
    const fragmentComToken = FRAGMENT_WITH_EMAIL.replace(/\{\{email\}\}/g, "{{poll_token}}@vote.eia.diaria.local");
    const err = verifyFragmentPreserved(fragmentComToken);
    assert.equal(err, null, "fragmento com {{poll_token}} deve passar na validação");
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

  it("retry_chunked quando objeto não-vazio não tem `inserted` (chaves desconhecidas)", () => {
    // Se javascript_tool retornar um objeto com campos inesperados mas sem `inserted`,
    // NÃO é o caso ambíguo de verify_only (que é só objeto vazio {}). Aqui o objeto é
    // não-vazio mas `inserted` está ausente → r.inserted === undefined → falsy → retry_chunked.
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
