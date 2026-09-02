/**
 * test/openrouter-billing-leak-model-list-drift-6994.test.ts (#6994)
 *
 * `EXPECTED_PAID_MODELS` (TS, `scripts/lib/openrouter-billing-leak.ts`) e
 * `PAID_ALLOWLIST` (Python, `hermes/scripts/hermes-model-cost-report.py`)
 * duplicam O MESMO DADO — quais slugs pagos são intencionais — em duas
 * linguagens diferentes, à mão, de propósito (ver docstring de
 * `openrouter-billing-leak.ts`: "se os dois divergirem, é sinal a
 * investigar, não erro a silenciar"). O problema não é a duplicação em si —
 * é que, até este teste, NADA verificava, e as duas já divergiam no dia
 * zero (achado #6994): o TS tem `openai/gpt-5.6-luna` (mesma família de
 * `gpt-5.6-luna`/`openai-codex/gpt-5.6-luna`, sob o id PREFIXADO do
 * gateway), o Python não.
 *
 * No molde do precedente `test/hermes-model-chain-drift.test.ts` (#6663) —
 * mesmo modo de falha (2 fontes mantidas à mão divergindo em silêncio), a
 * mesma resposta (teste de correspondência, não fonte única — decisão já
 * tomada no #6663 e reaplicada aqui por escolha explícita, ver corpo do
 * #6994).
 *
 * O que este teste garante:
 * 1. Toda entrada do Python também aparece no TS (Python nunca deve ter
 *    algo que o TS desconhece — o TS é o guard mais novo, não deveria
 *    "esquecer" nada que o Python já sabe).
 * 2. As entradas que existem SÓ no TS são EXATAMENTE as documentadas em
 *    `KNOWN_TS_ONLY_MODELS` abaixo — hoje só o alias prefixado
 *    `openai/gpt-5.6-luna`. Uma entrada nova do lado TS que não esteja
 *    nesta lista falha o teste: ou foi um `git mv`/typo acidental, ou é
 *    drift genuíno que precisa de decisão humana (reconciliar as listas,
 *    ou documentar aqui o porquê do novo alias).
 *
 * **Se você chegou aqui porque este teste falhou:** NÃO adicione a entrada
 * nova a `KNOWN_TS_ONLY_MODELS` só pra fazer passar — investigue primeiro
 * se a divergência é intencional (modelo novo pago, alias novo do gateway)
 * ou acidental (typo, entrada que devia ter ido pros dois lados). Só depois
 * de confirmar intenção, decida: ou reflita a mesma entrada no Python (se o
 * detector antigo também deveria reconhecê-la), ou documente aqui por quê
 * ela é TS-only de propósito.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_PAID_MODELS } from "./../scripts/lib/openrouter-billing-leak.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_PATH = join(ROOT, "hermes/scripts/hermes-model-cost-report.py");

/**
 * Entradas que hoje existem SÓ em `EXPECTED_PAID_MODELS` (TS), com o porquê
 * — mantido aqui, não no docstring do módulo TS, porque este é o único
 * lugar que precisa saber a lista EXATA pra comparar.
 */
const KNOWN_TS_ONLY_MODELS: ReadonlySet<string> = new Set([
  // Mesma família de "gpt-5.6-luna"/"openai-codex/gpt-5.6-luna" (ambas já
  // presentes nos dois lados), sob o id que o gateway usa quando a chamada
  // é roteada com o prefixo "openai/" em vez de "openai-codex/" — medido
  // num --dry-run real de 7 dias (#6716/#6983). O detector Python
  // (`hermes-model-cost-report.py`) lê `session_model_usage`, tabela onde
  // este id prefixado nunca apareceu até agora — por isso o Python ainda
  // não precisou dele. Se aparecer lá também, adicionar a `PAID_ALLOWLIST`
  // do Python e então REMOVER esta linha (a entrada deixa de ser TS-only).
  "openai/gpt-5.6-luna",
]);

function parsePythonAllowlist(source: string): string[] {
  const match = source.match(/PAID_ALLOWLIST\s*=\s*\{([^}]*)\}/);
  assert.ok(
    match,
    "PAID_ALLOWLIST = { ... } não encontrado em hermes/scripts/hermes-model-cost-report.py — " +
      "o script mudou de forma estrutural, atualize o regex deste teste.",
  );
  const inner = match![1];
  const slugs = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(
    slugs.length > 0,
    "PAID_ALLOWLIST foi encontrado mas nenhum slug entre aspas foi extraído — regex desalinhado com o formato real.",
  );
  return slugs;
}

describe("#6994 — EXPECTED_PAID_MODELS (TS) x PAID_ALLOWLIST (Python) não divergem sem sinal", () => {
  it("toda entrada do PAID_ALLOWLIST (Python) também está em EXPECTED_PAID_MODELS (TS)", () => {
    const pythonSlugs = parsePythonAllowlist(readFileSync(PYTHON_PATH, "utf8"));
    const missingFromTs = pythonSlugs.filter((slug) => !EXPECTED_PAID_MODELS.has(slug));
    assert.deepEqual(
      missingFromTs,
      [],
      `PAID_ALLOWLIST (Python) tem entrada(s) ausente(s) de EXPECTED_PAID_MODELS (TS): ${missingFromTs.join(", ")}. ` +
        "Investigue antes de adicionar cegamente — pode ser typo em qualquer um dos dois lados.",
    );
  });

  it("as entradas exclusivas de EXPECTED_PAID_MODELS (TS) são exatamente as documentadas/esperadas", () => {
    const pythonSlugs = new Set(parsePythonAllowlist(readFileSync(PYTHON_PATH, "utf8")));
    const tsOnly = [...EXPECTED_PAID_MODELS].filter((slug) => !pythonSlugs.has(slug)).sort();
    const expected = [...KNOWN_TS_ONLY_MODELS].sort();
    assert.deepEqual(
      tsOnly,
      expected,
      "EXPECTED_PAID_MODELS (TS) diverge de PAID_ALLOWLIST (Python) além do documentado em " +
        "KNOWN_TS_ONLY_MODELS deste teste. Se a divergência é intencional, atualize " +
        "KNOWN_TS_ONLY_MODELS com o motivo; se não, uma das duas listas está errada.",
    );
  });
});
