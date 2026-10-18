/**
 * test/openrouter-billing-leak-model-list-drift-6994.test.ts (#6994, revisto no #10387)
 *
 * `EXPECTED_PAID_MODELS` (TS, `scripts/lib/openrouter-billing-leak.ts`) e
 * `PAID_ALLOWLIST` (Python, `hermes/scripts/hermes-model-cost-report.py`)
 * duplicavam à mão, em duas linguagens, o mesmo dado — quais slugs pagos são
 * intencionais. O #6994 travou a correspondência entre as duas listas (a
 * divergência já existia no dia zero).
 *
 * #10387 (18/10/2026, decisão do editor: "não estou mais usando modelos pagos
 * no OpenRouter") esvaziou as DUAS. A correspondência virou trivial, então o
 * teste agora trava o que importa: ambas continuam vazias. Reintroduzir um
 * slug em qualquer uma delas exige nova decisão do editor revertendo o
 * #10387 — e este teste falha de propósito até essa decisão existir.
 *
 * Os modelos de ROTA DE ASSINATURA (luna via openai-codex, "sonnet" do elo de
 * assinatura do claude-delegate.sh) saíram do `PAID_ALLOWLIST` Python para
 * `SUBSCRIPTION_ROUTE_MODELS` — não são cobrança do OpenRouter. "sonnet"
 * nunca pode ir pro TS: no feed de billing do OpenRouter ele só aparece se o
 * guard fail-closed do #7649 falhou (#5608/#6714, sessão da assinatura
 * sequestrada) — é exatamente o alarme que o guard TS existe pra soar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_PAID_MODELS } from "./../scripts/lib/openrouter-billing-leak.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_PATH = join(ROOT, "hermes/scripts/hermes-model-cost-report.py");

/** Remove comentários Python (`# ...`) — prosa nunca é dado (regressão do PR #7648). */
function stripPyComments(source: string): string {
  return source.replace(/#[^\n]*/g, "");
}

/** Slugs entre aspas dentro de `NOME ... = frozenset({ ... })` ou `= frozenset()`. */
function parsePythonFrozenset(source: string, name: string): string[] {
  const cleaned = stripPyComments(source);
  const empty = new RegExp(`^${name}(?::[^=\\n]+)?\\s*=\\s*frozenset\\(\\)\\s*$`, "m");
  if (empty.test(cleaned)) return [];
  const full = new RegExp(`^${name}(?::[^=\\n]+)?\\s*=\\s*frozenset\\(\\{([^}]*)\\}\\)`, "m");
  const match = cleaned.match(full);
  assert.ok(
    match,
    `${name} = frozenset(...) não encontrado em hermes/scripts/hermes-model-cost-report.py — ` +
      "o script mudou de forma estrutural, atualize o regex deste teste.",
  );
  return [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("#6994/#10387 — EXPECTED_PAID_MODELS (TS) e PAID_ALLOWLIST (Python) vazios", () => {
  it("parser ignora aspas em comentário (regressão, PR #7648)", () => {
    const src = [
      "X: frozenset[str] = frozenset({",
      '    # Tirar daqui o transformaria em "vazamento" falso.',
      '    "a/b",',
      "})",
    ].join("\n");
    assert.deepEqual(parsePythonFrozenset(src, "X"), ["a/b"]);
    assert.deepEqual(parsePythonFrozenset("X: frozenset[str] = frozenset()\n", "X"), []);
  });

  it("PAID_ALLOWLIST (Python) é vazio — nenhum modelo pago do OpenRouter é intencional (#10387)", () => {
    assert.deepEqual(parsePythonFrozenset(readFileSync(PYTHON_PATH, "utf8"), "PAID_ALLOWLIST"), []);
  });

  it("EXPECTED_PAID_MODELS (TS) é vazio — qualquer cobrança > 0 no OpenRouter acusa (#10387)", () => {
    assert.deepEqual([...EXPECTED_PAID_MODELS], []);
  });

  it("'sonnet' segue em SUBSCRIPTION_ROUTE_MODELS (Python) e NUNCA em EXPECTED_PAID_MODELS (TS)", () => {
    const sub = parsePythonFrozenset(readFileSync(PYTHON_PATH, "utf8"), "SUBSCRIPTION_ROUTE_MODELS");
    assert.ok(sub.includes("sonnet"), "elo de assinatura (#7649) precisa continuar fora do vazamento no relatório Python");
    assert.equal(EXPECTED_PAID_MODELS.has("sonnet"), false);
  });
});
