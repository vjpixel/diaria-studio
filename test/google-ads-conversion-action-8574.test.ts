/**
 * test/google-ads-conversion-action-8574.test.ts (#8574)
 *
 * Cobre `scripts/lib/google-ads-conversion-action.ts` (núcleo puro) e o CLI
 * `scripts/google-ads-set-conversion-primary.ts` — rebaixar/promover
 * `primary_for_goal` de uma `conversion_action`.
 *
 * Nenhum teste chama a API real: `fetch` é sempre mock. `--dry-run`
 * (default) nunca deve chamar `fetch` para mutar (só ler, ou nem isso se
 * mockado como estado já convergido).
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildConversionActionReadQuery,
  parseConversionActionRow,
  decidePrimaryForGoalChange,
  buildSetPrimaryForGoalPayload,
  type ConversionActionApiRow,
} from "../scripts/lib/google-ads-conversion-action.ts";
import { main as setPrimaryMain } from "../scripts/google-ads-set-conversion-primary.ts";

const AUTH_ENV = {
  GOOGLE_ADS_CLIENT_ID: "client-id",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "6236094249",
  GOOGLE_ADS_CUSTOMER_ID: "2369219639",
};

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Núcleo puro
// ---------------------------------------------------------------------------

describe("#8574 — buildConversionActionReadQuery", () => {
  it("monta a query GAQL com o id interpolado", () => {
    const q = buildConversionActionReadQuery("7758161410");
    assert.match(q, /FROM conversion_action/);
    assert.match(q, /conversion_action\.id = 7758161410/);
  });

  it("rejeita id não-numérico (defesa contra injeção de GAQL)", () => {
    assert.throws(() => buildConversionActionReadQuery("7758161410 OR 1=1"), /numérico/);
    assert.throws(() => buildConversionActionReadQuery(""), /numérico/);
  });
});

describe("#8574 — parseConversionActionRow", () => {
  it("normaliza uma linha bem-formada", () => {
    const rows: ConversionActionApiRow[] = [
      {
        conversionAction: {
          resourceName: "customers/2369219639/conversionActions/7758161410",
          id: "7758161410",
          name: "Cadastro newsletter (recuperação #7770)",
          primaryForGoal: true,
        },
      },
    ];
    const state = parseConversionActionRow(rows);
    assert.deepEqual(state, {
      resourceName: "customers/2369219639/conversionActions/7758161410",
      id: "7758161410",
      name: "Cadastro newsletter (recuperação #7770)",
      primaryForGoal: true,
    });
  });

  it("trata primaryForGoal ausente como false (default documentado da API)", () => {
    const rows: ConversionActionApiRow[] = [
      { conversionAction: { resourceName: "customers/1/conversionActions/2", id: "2" } },
    ];
    const state = parseConversionActionRow(rows);
    assert.equal(state?.primaryForGoal, false);
  });

  it("devolve null quando não há resultado (id não encontrado)", () => {
    assert.equal(parseConversionActionRow([]), null);
  });
});

describe("#8574 — decidePrimaryForGoalChange", () => {
  it("needsChange=false quando já convergido (idempotência)", () => {
    const d = decidePrimaryForGoalChange(false, false);
    assert.equal(d.needsChange, false);
  });

  it("needsChange=true quando o alvo difere do atual", () => {
    const d = decidePrimaryForGoalChange(true, false);
    assert.equal(d.needsChange, true);
    assert.equal(d.current, true);
    assert.equal(d.target, false);
  });
});

describe("#8574 — buildSetPrimaryForGoalPayload", () => {
  it("restringe o updateMask a primary_for_goal apenas", () => {
    const payload = buildSetPrimaryForGoalPayload("customers/1/conversionActions/2", false);
    assert.equal(payload.operations.length, 1);
    assert.equal(payload.operations[0].updateMask, "primary_for_goal");
    assert.equal(payload.operations[0].update.primaryForGoal, false);
    assert.equal(payload.operations[0].update.resourceName, "customers/1/conversionActions/2");
  });
});

// ---------------------------------------------------------------------------
// CLI (fetch mockado)
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("#8574 — CLI google-ads-set-conversion-primary (dry-run)", () => {
  it("dry-run: lê o estado, NÃO chama mutate, e não registra em edicoes.jsonl", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gads-conv-primary-8574-"));
    try {
      const calls: string[] = [];
      const fetchMock = mock.fn(async (input: string) => {
        if (input === "https://oauth2.googleapis.com/token") {
          return jsonResponse(200, { access_token: "tok" });
        }
        calls.push(input);
        if (input.endsWith(":search")) {
          return jsonResponse(200, {
            results: [
              {
                conversionAction: {
                  resourceName: "customers/2369219639/conversionActions/7758161410",
                  id: "7758161410",
                  name: "Cadastro newsletter (recuperação #7770)",
                  primaryForGoal: true,
                },
              },
            ],
          });
        }
        throw new Error(`chamada inesperada no dry-run: ${input}`);
      });

      const code = await withEnv(AUTH_ENV, () =>
        setPrimaryMain(
          ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639"],
          fetchMock as unknown as typeof fetch,
        ),
      );
      assert.equal(code, 0);
      // Só a leitura (:search) foi chamada — nenhuma chamada a :mutate.
      assert.ok(calls.every((c) => c.endsWith(":search")));
      assert.ok(!calls.some((c) => c.includes(":mutate")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("dry-run com estado já convergido: nem a decisão dispara plano de mutação", async () => {
    const fetchMock = mock.fn(async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) {
        return jsonResponse(200, {
          results: [
            {
              conversionAction: {
                resourceName: "customers/2369219639/conversionActions/7758161410",
                id: "7758161410",
                name: "Cadastro newsletter (recuperação #7770)",
                primaryForGoal: false,
              },
            },
          ],
        });
      }
      throw new Error(`chamada inesperada: ${input}`);
    });

    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 0);
  });

  it("--send muta, relê para confirmar, e registra em edicoes.jsonl só quando convergiu", async () => {
    const edicoesPath = join(mkdtempSync(join(tmpdir(), "gads-conv-primary-8574-edicoes-")), "edicoes.jsonl");
    let searchCallCount = 0;
    const fetchMock = mock.fn(async (input: string, init?: RequestInit) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":mutate")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.operations[0].update.primaryForGoal, false);
        return jsonResponse(200, { results: [{ resourceName: body.operations[0].update.resourceName }] });
      }
      if (input.endsWith(":search")) {
        searchCallCount++;
        // 1ª leitura: true (antes). 2ª leitura (pós-mutate): false (depois).
        const primaryForGoal = searchCallCount === 1;
        return jsonResponse(200, {
          results: [
            {
              conversionAction: {
                resourceName: "customers/2369219639/conversionActions/7758161410",
                id: "7758161410",
                name: "Cadastro newsletter (recuperação #7770)",
                primaryForGoal,
              },
            },
          ],
        });
      }
      throw new Error(`chamada inesperada: ${input}`);
    });

    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        [
          "--conversion-action-id",
          "7758161410",
          "--target",
          "false",
          "--customer-id",
          "2369219639",
          "--send",
          "--edicoes-path",
          edicoesPath,
        ],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 0);
    assert.equal(searchCallCount, 2, "deve reler o estado depois da mutação (#573)");

    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(edicoesPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.tipo, "conversion-action-secundaria");
    assert.equal(line.efeito, "mudanca");
    assert.equal(line.origem, "agente");
    assert.equal(line.issue, "8574");
  });

  it("recusa --target inválido", async () => {
    const fetchMock = mock.fn(async () => {
      throw new Error("não deveria chamar fetch");
    });
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(["--conversion-action-id", "7758161410", "--target", "maybe"], fetchMock as unknown as typeof fetch),
    );
    assert.equal(code, 1);
  });
});
