/**
 * test/pr-body-fetch.test.ts (#7140)
 *
 * Cobre `scripts/lib/pr-body-fetch.ts` — a busca do body ATUAL do PR pela API
 * do GitHub (com retry/backoff) + a lógica pura de fallback pro `PR_BODY`
 * do payload do evento.
 *
 * O caso que mais importa (regressão #7140): um body ATUALIZADO após a
 * emissão do evento do workflow — `gh run rerun` replaya o mesmo payload,
 * então um gate que só lia `process.env.PR_BODY` nunca enxergava a
 * atualização. `resolvePrBody` é o ponto de decisão: quando a API
 * retorna o body novo, o gate usa ele; quando a API falha, cai pro payload
 * mas diz isso no log (nunca silencioso).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchPrBody, resolvePrBody, type PrBodyResolution } from "../scripts/lib/pr-body-fetch.ts";

type SpawnFn = (cmd: string, args: string[], opts: { encoding: "utf8" }) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const noopSleep = async (_ms: number): Promise<void> => {};

function okSpawn(stdout: string): SpawnFn {
  return () => ({ status: 0, stdout, stderr: "" });
}

function failSpawn(stderr: string, status: number | null = 1): SpawnFn {
  return () => ({ status, stdout: "", stderr });
}

// ---------------------------------------------------------------------------
// fetchPrBody: retry+backoff (mesmo padrão de getPrLabels em #2060)
// ---------------------------------------------------------------------------

describe("#7140 — fetchPrBody: retry+backoff em falhas transitórias da API", () => {
  it("retry 2×fail→pass: retorna o body na 3ª tentativa sem lançar", async () => {
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      if (callCount < 3) {
        return { status: 1, stdout: "", stderr: "HTTP 401: Requires authentication" };
      }
      return { status: 0, stdout: "no-regression-test: agent prompt change, sem teste TS unitário.", stderr: "" };
    };

    const body = await fetchPrBody("42", mockSpawn, noopSleep, 3);

    assert.equal(callCount, 3, `deve ter sido chamado 3 vezes, foi ${callCount}×`);
    assert.match(body, /no-regression-test:/, `body deve ser o da API, foi: ${JSON.stringify(body)}`);
  });

  it("1ª tentativa bem-sucedida: retorna imediatamente (sem retry desnecessário)", async () => {
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      return { status: 0, stdout: "removal-declaration: feature nova, nada a remover ainda", stderr: "" };
    };

    const body = await fetchPrBody("99", mockSpawn, noopSleep, 3);

    assert.equal(callCount, 1, "não deve retentar quando a 1ª chamada passa");
    assert.match(body, /removal-declaration:/);
  });

  it("3×fail: lança com mensagem INFRA distinta (não genérica)", async () => {
    const mockSpawn: SpawnFn = () => ({ status: 1, stdout: "", stderr: "HTTP 401" });

    await assert.rejects(
      () => fetchPrBody("42", mockSpawn, noopSleep, 3),
      (err: Error) => {
        assert.match(
          err.message,
          /\[#7140\] INFRA: não foi possível buscar o body do PR após 3 tentativas/,
          `mensagem de erro deve ser distinta (INFRA), foi: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("#2082 regressão: maxAttempts=0 lança com mensagem coerente (não loop vazio)", async () => {
    const mockSpawn: SpawnFn = () => ({ status: 0, stdout: "x", stderr: "" });
    await assert.rejects(
      () => fetchPrBody("1", mockSpawn, noopSleep, 0),
      (err: Error) => {
        assert.match(err.message, /maxAttempts deve ser/, `mensagem deve explicar o erro, foi: ${err.message}`);
        return true;
      },
    );
  });

  it("status null (processo morto por sinal) é tratado como falha transitória", async () => {
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      if (callCount === 1) return { status: null, stdout: "", stderr: "" };
      return { status: 0, stdout: "body novo", stderr: "" };
    };

    const body = await fetchPrBody("7", mockSpawn, noopSleep, 3);
    assert.equal(callCount, 2);
    assert.equal(body, "body novo");
  });
});

// ---------------------------------------------------------------------------
// resolvePrBody: lógica pura de fallback (#7140)
// ---------------------------------------------------------------------------

describe("#7140 — resolvePrBody: usa o body da API quando disponível, cai pro payload com aviso", () => {
  it("usa o body da API quando a busca tem sucesso (source=api)", async () => {
    const fetcher = async (_n: string): Promise<string> => "no-regression-test: agente prompt, não dá pra testar em TS";
    const result: PrBodyResolution = await resolvePrBody("42", "BODY ANTIGO DO PAYLOAD", fetcher);

    assert.equal(result.source, "api", "fonte deve ser api quando a busca passa");
    assert.match(result.body, /no-regression-test:/, "body deve ser o da API, não o do payload");
    // Garante que o payload antigo NUNCA vira o body quando a API deu certo.
    assert.notEqual(result.body, "BODY ANTIGO DO PAYLOAD");
  });

  it("cai pro payload (source=env-fallback) quando a API falha, mas avisa", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const fetcher = async (_n: string): Promise<string> => {
        throw new Error("[#7140] INFRA: não foi possível buscar o body do PR após 3 tentativas.");
      };
      const result: PrBodyResolution = await resolvePrBody("7", "BODY CONGELADO DO PAYLOAD", fetcher);

      assert.equal(result.source, "env-fallback", "fonte deve ser env-fallback quando a API falha");
      assert.equal(result.body, "BODY CONGELADO DO PAYLOAD", "body deve ser o payload quando a API falha");
      assert.ok(
        warnings.some((w) => w.includes("#7140") && w.toLowerCase().includes("desatualizado")),
        `deve avisar que o body do payload pode estar desatualizado. warnings: ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("NUNCA usa o payload quando a API retorna um body diferente — é este o caso de regressão #7140", async () => {
    // Simula exatamente a situação do incidente: payload tem o body SEM
    // justificativa (o estado quando o evento foi emitido), e a API retorna
    // o body COM justificativa (editado depois). O gate deve ver o body novo.
    const fetcher = async (_n: string): Promise<string> =>
      "no-regression-test: agente prompt change não pode ser testado em TS unitário.";
    const result: PrBodyResolution = await resolvePrBody(
      "1",
      "## Summary\n\nFix. Sem justificativa.", // payload: body antigo, sem marcador
      fetcher,
    );

    assert.equal(result.source, "api");
    assert.match(result.body, /no-regression-test:/, "gate deve enxergar a justificativa que foi editada");
  });
});
