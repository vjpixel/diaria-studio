/**
 * test/google-ads-conversion-primary-registro-10423.test.ts (#10423)
 *
 * Regressão: `scripts/google-ads-set-conversion-primary.ts --send` gravava a
 * linha de `edicoes.jsonl` com `issue: "8574"` e um motivo FIXO do caso
 * original, mesmo quando rodado com `--issue 8543` pra outra mudança (18/10:
 * duas linhas saíram assim e exigiram `correcao-de-registro` à mão). Agora
 * `--issue`/`--motivo` são obrigatórios em `--send` e vão literalmente pra
 * linha. Também cobre o tipo novo `lance-alvo` em `TIPO_TO_EFEITO`.
 *
 * Nenhum teste chama a API real: `fetch` é sempre mock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as setPrimaryMain } from "../scripts/google-ads-set-conversion-primary.ts";
import { validateRegistrarEdicaoInput, main as registrarMain } from "../scripts/ads-registrar-edicao.ts";
import { TIPO_TO_EFEITO, isTipoValido } from "../scripts/lib/ads-rolling-window.ts";

const AUTH_ENV = {
  GOOGLE_ADS_CLIENT_ID: "client-id",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "6236094249",
  GOOGLE_ADS_CUSTOMER_ID: "2369219639",
};

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Mock que simula a conta: 1ª leitura `before`, mutação aceita, 2ª leitura `!before`. */
function convergingFetch(before: boolean, calls: string[]): typeof fetch {
  let searchCount = 0;
  return (async (input: string, init?: RequestInit) => {
    calls.push(input);
    if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
    if (input.endsWith(":mutate")) {
      const body = JSON.parse(String(init?.body));
      return jsonResponse(200, { results: [{ resourceName: body.operations[0].update.resourceName }] });
    }
    if (input.endsWith(":search")) {
      searchCount++;
      const primaryForGoal = searchCount === 1 ? before : !before;
      return jsonResponse(200, {
        results: [
          {
            conversionAction: {
              resourceName: "customers/2369219639/conversionActions/7762768203",
              id: "7762768203",
              name: "Ação qualquer",
              primaryForGoal,
            },
          },
        ],
      });
    }
    throw new Error(`chamada inesperada: ${input}`);
  }) as unknown as typeof fetch;
}

const BASE = ["--conversion-action-id", "7762768203", "--customer-id", "2369219639"];

describe("#10423 — google-ads-set-conversion-primary grava --issue/--motivo, nunca texto fixo", () => {
  it("--issue X --motivo Y aparecem literalmente na linha gravada (cenário real de 18/10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-conv-primary-10423-"));
    const edicoesPath = join(dir, "edicoes.jsonl");
    try {
      const motivo = "promover ação de cadastro do 2º form, decisão do editor em 18/10";
      const code = await withEnv(AUTH_ENV, () =>
        setPrimaryMain(
          [...BASE, "--target", "true", "--send", "--issue", "8543", "--motivo", motivo, "--edicoes-path", edicoesPath],
          convergingFetch(false, []),
        ),
      );
      assert.equal(code, 0);
      const lines = readFileSync(edicoesPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const line = JSON.parse(lines[0]);
      assert.equal(line.issue, "8543", "issue precisa ser a passada em --issue, nunca 8574 fixo");
      assert.equal(line.motivo, motivo, "motivo precisa ser o passado em --motivo, nunca texto fixo");
      assert.equal(line.conversion_action ?? line["conversion-action"], "7762768203");
      assert.equal(line["primary-for-goal"], "false -> true");
      assert.ok(!JSON.stringify(line).includes("28/09/2026"), "nenhum resquício do motivo fixo antigo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--issue aceita o prefixo # e grava só o número", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-conv-primary-10423-hash-"));
    const edicoesPath = join(dir, "edicoes.jsonl");
    try {
      const code = await withEnv(AUTH_ENV, () =>
        setPrimaryMain(
          [...BASE, "--target", "false", "--send", "--issue", "#8543", "--motivo", "rebaixar", "--edicoes-path", edicoesPath],
          convergingFetch(true, []),
        ),
      );
      assert.equal(code, 0);
      assert.equal(JSON.parse(readFileSync(edicoesPath, "utf8").trim()).issue, "8543");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, extra] of [
    ["sem --motivo", ["--issue", "8543"]],
    ["sem --issue", ["--motivo", "rebaixar"]],
    ["sem os dois", []],
  ] as const) {
    it(`--send ${label} -> falha ALTO antes de qualquer chamada de rede, nada gravado`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "gads-conv-primary-10423-falta-"));
      const edicoesPath = join(dir, "edicoes.jsonl");
      try {
        const calls: string[] = [];
        const code = await withEnv(AUTH_ENV, () =>
          setPrimaryMain([...BASE, "--target", "false", "--send", ...extra, "--edicoes-path", edicoesPath], convergingFetch(true, calls)),
        );
        assert.equal(code, 1);
        assert.deepEqual(calls, [], "nenhuma chamada (nem token) pode acontecer sem issue/motivo em --send");
        assert.equal(existsSync(edicoesPath), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("--issue não numérico é recusado antes de qualquer rede", async () => {
    const calls: string[] = [];
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain([...BASE, "--target", "false", "--send", "--issue", "abc", "--motivo", "x"], convergingFetch(true, calls)),
    );
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
  });

  it("dry-run (sem --send) continua funcionando sem --issue/--motivo", async () => {
    const calls: string[] = [];
    const code = await withEnv(AUTH_ENV, () => setPrimaryMain([...BASE, "--target", "false"], convergingFetch(true, calls)));
    assert.equal(code, 0);
    assert.ok(!calls.some((c) => c.endsWith(":mutate")), "dry-run nunca muta");
  });

  it("--send --skip-registro não exige --issue/--motivo (nada é gravado)", async () => {
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain([...BASE, "--target", "false", "--send", "--skip-registro"], convergingFetch(true, [])),
    );
    assert.equal(code, 0);
  });
});

describe("#10423 — tipo lance-alvo no conjunto fechado de edicoes.jsonl", () => {
  it("lance-alvo está catalogado com efeito mudanca", () => {
    assert.ok(isTipoValido("lance-alvo"));
    assert.equal(TIPO_TO_EFEITO["lance-alvo"], "mudanca");
  });

  it("validateRegistrarEdicaoInput aceita lance-alvo e auto-deriva efeito mudanca", () => {
    const r = validateRegistrarEdicaoInput(
      { braco: "Google Ads (UTM)", tipo: "lance-alvo", origem: "editor", extra: { campanha: "Max", issue: "8543" } },
      "2026-10-18T00:00:00.000Z",
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.line.efeito, "mudanca");
      assert.equal(r.line.campanha, "Max");
    }
  });

  it("CLI ads-registrar-edicao grava linha lance-alvo", () => {
    const dir = mkdtempSync(join(tmpdir(), "ads-registrar-lance-alvo-10423-"));
    const edicoesPath = join(dir, "edicoes.jsonl");
    try {
      const code = registrarMain([
        "--braco",
        "Google Ads (UTM)",
        "--tipo",
        "lance-alvo",
        "--origem",
        "editor",
        "--issue",
        "8543",
        "--motivo",
        "tCPA da Max",
        "--edicoes-path",
        edicoesPath,
      ]);
      assert.equal(code, 0);
      const line = JSON.parse(readFileSync(edicoesPath, "utf8").trim());
      assert.equal(line.tipo, "lance-alvo");
      assert.equal(line.efeito, "mudanca");
      assert.equal(line.issue, "8543");
      assert.equal(line.motivo, "tCPA da Max");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
