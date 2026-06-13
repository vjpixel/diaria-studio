/**
 * test/check-pr-bugfix.test.ts (#970, #2060)
 *
 * Cobre helpers puros do guard CI #970. Não testa main() (depende de gh CLI
 * + git diff externos — testado via integração no GH Action real).
 *
 * #2060: adiciona testes do retry de getPrLabels (mock de spawnSync).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isBugfixPr,
  hasExceptionLabel,
  hasNewOrModifiedTest,
  justificationInBody,
  getPrLabels,
  type SpawnFn,
} from "../scripts/check-pr-bugfix.ts";

describe("isBugfixPr (#970)", () => {
  it("detecta label `bug`", () => {
    assert.equal(isBugfixPr("any title", "", ["bug", "P2"]), true);
  });

  it("detecta título 'fix:'", () => {
    assert.equal(isBugfixPr("fix: drive-sync conflict", "", []), true);
    assert.equal(isBugfixPr("fix(stage-2): null check", "", []), true);
  });

  it("detecta keywords no título (bugfix, hotfix)", () => {
    assert.equal(isBugfixPr("hotfix LinkedIn cron", "", []), true);
    assert.equal(isBugfixPr("bugfix: missing url field", "", []), true);
  });

  it("não detecta PR de feature/refactor", () => {
    assert.equal(isBugfixPr("feat: nova funcionalidade", "", ["enhancement"]), false);
    assert.equal(isBugfixPr("refactor: split helper", "", []), false);
    assert.equal(isBugfixPr("docs: update README", "", ["documentation"]), false);
  });
});

describe("hasExceptionLabel (#970)", () => {
  it("detecta no-regression-test", () => {
    assert.equal(hasExceptionLabel(["bug", "no-regression-test"]), true);
  });

  it("retorna false sem label", () => {
    assert.equal(hasExceptionLabel(["bug", "P2"]), false);
  });
});

describe("hasNewOrModifiedTest (#970)", () => {
  it("detecta arquivo em test/", () => {
    assert.equal(hasNewOrModifiedTest(["test/foo.test.ts"]), true);
    assert.equal(hasNewOrModifiedTest(["test/lib/bar.test.ts"]), true);
  });

  it("detecta arquivo em tests/", () => {
    assert.equal(hasNewOrModifiedTest(["tests/integration.test.ts"]), true);
  });

  it("detecta arquivo em subdiretório workers/**/test/ (#2225)", () => {
    assert.equal(hasNewOrModifiedTest(["workers/linkedin-cron/test/index.test.ts"]), true);
    assert.equal(hasNewOrModifiedTest(["workers/foo/test/bar.test.ts"]), true);
    assert.equal(hasNewOrModifiedTest(["workers/foo/tests/bar.test.ts"]), true);
  });

  it("não detecta falso-positivo: worker src com 'test' no nome do arquivo (#2225)", () => {
    assert.equal(hasNewOrModifiedTest(["workers/foo/src/test-helper.ts"]), false);
    assert.equal(hasNewOrModifiedTest(["workers/foo/src/testing-utils.ts"]), false);
  });

  it("ignora arquivos fora de test/", () => {
    assert.equal(hasNewOrModifiedTest(["scripts/foo.ts"]), false);
    assert.equal(hasNewOrModifiedTest(["docs/test.md"]), false);
    assert.equal(hasNewOrModifiedTest(["test-data/sample.json"]), false);
  });

  it("ignora .ts não-.test.ts", () => {
    assert.equal(hasNewOrModifiedTest(["test/_helpers/utils.ts"]), false);
  });

  it("aceita .test.js", () => {
    assert.equal(hasNewOrModifiedTest(["test/legacy.test.js"]), true);
  });

  it("retorna false em diff vazio", () => {
    assert.equal(hasNewOrModifiedTest([]), false);
  });
});

describe("justificationInBody (#970)", () => {
  it("aceita justificativa com 30+ chars", () => {
    const body = `## Summary\n\nFix.\n\nno-regression-test: agent prompt change, sem teste TS unitário possível.`;
    assert.equal(justificationInBody(body), true);
  });

  it("rejeita label sem justificativa", () => {
    const body = `## Summary\n\nFix.`;
    assert.equal(justificationInBody(body), false);
  });

  it("rejeita justificativa curta (<30 chars)", () => {
    const body = `no-regression-test: skip`;
    assert.equal(justificationInBody(body), false);
  });

  it("aceita variantes de capitalização", () => {
    const body = `No-Regression-Test agent prompt change não pode ser testado em TS unitário.`;
    assert.equal(justificationInBody(body), true);
  });
});

// ---------------------------------------------------------------------------
// #2060 — getPrLabels: retry com backoff em 401/5xx transitórios
// ---------------------------------------------------------------------------

describe("#2060 — getPrLabels: retry+backoff em falhas transitórias da API", () => {
  /** sleepFn instantânea para testes (sem delay real). */
  const noopSleep = async (_ms: number): Promise<void> => {};

  it("retry 2×fail→pass: retorna labels na 3ª tentativa sem lançar", async () => {
    let callCount = 0;
    // spawnFn mockado: falha nas 2 primeiras chamadas (status 1 = gh auth error),
    // passa na 3ª (status 0 + labels).
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      if (callCount < 3) {
        return { status: 1, stdout: "", stderr: "HTTP 401: Requires authentication" };
      }
      return { status: 0, stdout: "bug\nP2\n", stderr: "" };
    };

    const labels = await getPrLabels("42", mockSpawn, noopSleep, 3);

    assert.equal(callCount, 3, `deve ter sido chamado 3 vezes, foi ${callCount}×`);
    assert.deepEqual(labels, ["bug", "P2"], `labels retornadas incorretas: ${JSON.stringify(labels)}`);
  });

  it("#2082 regressão: backoff schedule correto — 1ª falha dorme 10s, 2ª falha dorme 20s, 3ª não dorme", async () => {
    // Garante que schedule errado de backoff (ex: 30s para 2ª falha, ou 3ª tentativa dorme)
    // seria detectado por este teste.
    const delays: number[] = [];
    const trackingSleep = async (ms: number): Promise<void> => { delays.push(ms); };
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      // Todas as 3 tentativas falham para garantir que lançará no final
      return { status: 1, stdout: "", stderr: "err" };
    };

    await assert.rejects(
      () => getPrLabels("1", mockSpawn, trackingSleep, 3),
      /INFRA/,
    );

    assert.equal(callCount, 3, "deve ter 3 tentativas");
    assert.equal(delays.length, 2, `deve dormir 2× (entre tentativas), não ${delays.length}×`);
    assert.equal(delays[0], 10_000, `1ª pausa deve ser 10s, foi ${delays[0]}ms`);
    assert.equal(delays[1], 20_000, `2ª pausa deve ser 20s, foi ${delays[1]}ms`);
  });

  it("3×fail: lança com mensagem INFRA distinta (não genérica)", async () => {
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      return { status: 1, stdout: "", stderr: "HTTP 401: Requires authentication" };
    };

    await assert.rejects(
      () => getPrLabels("42", mockSpawn, noopSleep, 3),
      (err: Error) => {
        assert.match(
          err.message,
          /\[#970\] INFRA: não foi possível consultar a API após 3 tentativas/,
          `mensagem de erro deve ser distinta (INFRA), foi: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("1ª tentativa bem-sucedida: retorna imediatamente (sem retry desnecessário)", async () => {
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      return { status: 0, stdout: "enhancement\n", stderr: "" };
    };

    const labels = await getPrLabels("99", mockSpawn, noopSleep, 3);

    assert.equal(callCount, 1, "não deve retenttar quando a 1ª chamada passa");
    assert.deepEqual(labels, ["enhancement"]);
  });

  it("spawnFn 401 exato é tratado como transitório (status ≠ 0)", async () => {
    // Na prática, gh CLI retorna status 1 em 401 — mas o teste garante que qualquer
    // status ≠ 0 é retentado (o critério é status !== 0, não o stderr).
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      if (callCount === 1) return { status: 2, stdout: "", stderr: "timeout" };
      return { status: 0, stdout: "bug\n", stderr: "" };
    };

    const labels = await getPrLabels("7", mockSpawn, noopSleep, 3);
    assert.equal(callCount, 2);
    assert.deepEqual(labels, ["bug"]);
  });

  // #2104: processo morto por sinal (status null) deve ter mensagem distinta de 'exit null'
  it("#2104 regressão: status null (signal kill) → mensagem 'processo morto por sinal'", async () => {
    const errors: string[] = [];
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      // status null = processo morto por sinal (ex: OOM, SIGKILL do runner)
      return { status: null, stdout: "", stderr: "" };
    };

    await assert.rejects(
      () => getPrLabels("1", mockSpawn, noopSleep, 1),
      (err: Error) => {
        // Mensagem distinta — não deve conter 'exit null'
        assert.ok(
          !err.message.includes("exit null"),
          `mensagem não deve ser 'exit null', foi: ${err.message}`,
        );
        assert.match(
          err.message,
          /processo morto por sinal/,
          `mensagem deve indicar signal kill, foi: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("#2082: maxAttempts=0 lança com mensagem coerente (não loop vazio)", async () => {
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => ({ status: 0, stdout: "bug\n", stderr: "" });
    await assert.rejects(
      () => getPrLabels("1", mockSpawn, noopSleep, 0),
      (err: Error) => {
        assert.match(err.message, /maxAttempts deve ser/, `mensagem deve explicar o erro, foi: ${err.message}`);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// #2082 — hasNewOrModifiedTest: detecta rename de teste (status R*)
// ---------------------------------------------------------------------------

describe("#2082 — hasNewOrModifiedTest: arquivos renomeados (status R*)", () => {
  it("detecta teste renomeado (R100) como modificado", () => {
    assert.equal(
      hasNewOrModifiedTest(["test/new-name.test.ts"]),
      true,
      "caminho novo de rename em test/ deve ser detectado",
    );
  });

  it("não detecta se o caminho novo não é test/*.test.ts (ex: só scripts renomeados)", () => {
    assert.equal(
      hasNewOrModifiedTest(["scripts/new-name.ts"]),
      false,
    );
  });
});
