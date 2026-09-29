/**
 * test/google-ads-conversion-primary-error-branches-8960.test.ts (#8960 item 3)
 *
 * Cobre os branches de erro de `scripts/google-ads-set-conversion-primary.ts`
 * que ficaram sem teste dedicado (achado #3 do review da PR #8956, ver issue
 * #8960): falha de rede, HTTP não-2xx e corpo não-JSON em cada call site
 * (`googleAds:search` antes/depois da mutação, `conversionActions:mutate`),
 * `--customer-id`/env vars ausentes, `--skip-registro`, e propagação de
 * falha de `registrarEdicaoMain`.
 *
 * Nenhum teste chama a API real: `fetch` é sempre mock (ou nem chega a ser
 * chamado, nos casos de validação ANTES de qualquer rede).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SAMPLE_STATE_ROW = {
  conversionAction: {
    resourceName: "customers/2369219639/conversionActions/7758161410",
    id: "7758161410",
    name: "Cadastro newsletter (recuperação #7770)",
    primaryForGoal: true,
  },
};

// ---------------------------------------------------------------------------
// Validação antes de qualquer chamada de rede
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-set-conversion-primary: --customer-id/env vars ausentes", () => {
  it("sem --customer-id e sem GOOGLE_ADS_CUSTOMER_ID no ambiente -> falha antes de qualquer fetch", async () => {
    const fetchMock = async () => {
      throw new Error("não deveria chamar fetch sem customer-id resolvido");
    };
    const code = await withEnv({ ...AUTH_ENV, GOOGLE_ADS_CUSTOMER_ID: "" }, () =>
      setPrimaryMain(["--conversion-action-id", "7758161410", "--target", "false"], fetchMock as unknown as typeof fetch),
    );
    assert.equal(code, 1);
  });

  it("env vars de auth ausentes (ex: GOOGLE_ADS_DEVELOPER_TOKEN vazio) -> falha antes de qualquer fetch", async () => {
    const fetchMock = async () => {
      throw new Error("não deveria chamar fetch sem as env vars de auth resolvidas");
    };
    const code = await withEnv({ ...AUTH_ENV, GOOGLE_ADS_DEVELOPER_TOKEN: "" }, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
  });
});

// ---------------------------------------------------------------------------
// Renovação do access token
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-set-conversion-primary: falha na renovação do access token", () => {
  it("falha de rede no /token -> falha limpa, nunca chega a ler a conversion_action", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") throw new Error("network down (simulado)");
      throw new Error(`não deveria chamar mais nada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
  });
});

// ---------------------------------------------------------------------------
// Leitura ANTES da mutação (googleAds:search) — rede / HTTP / corpo
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-set-conversion-primary: leitura ANTES da mutação", () => {
  it("falha de rede no :search -> falha limpa, nunca tenta mutar", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) throw new Error("network down (simulado)");
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
  });

  it(":search HTTP não-2xx -> falha limpa, nunca tenta mutar", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(500, { error: "internal" });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
  });

  it(":search corpo não-JSON -> falha limpa, nunca tenta mutar", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return new Response("isto não é JSON", { status: 200 });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
  });
});

// ---------------------------------------------------------------------------
// Mutação (conversionActions:mutate) — rede / HTTP
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-set-conversion-primary: conversionActions:mutate", () => {
  it("falha de rede na mutação -> falha limpa, nunca releva/registra", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: [SAMPLE_STATE_ROW] });
      if (input.endsWith(":mutate")) throw new Error("network down (simulado)");
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639", "--send"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
  });

  it("HTTP não-2xx na mutação -> falha limpa, nunca releva/registra", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: [SAMPLE_STATE_ROW] });
      if (input.endsWith(":mutate")) return jsonResponse(400, { error: "INVALID_ARGUMENT" });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639", "--send"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
  });
});

// ---------------------------------------------------------------------------
// Releitura DEPOIS da mutação (#573) — rede / não encontrado
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-set-conversion-primary: releitura pós-mutação (#573)", () => {
  it("mutação aceita, mas releitura falha por rede -> falha (nunca confia só no 2xx da mutação)", async () => {
    let searchCallCount = 0;
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":mutate")) return jsonResponse(200, { results: [{ resourceName: SAMPLE_STATE_ROW.conversionAction.resourceName }] });
      if (input.endsWith(":search")) {
        searchCallCount++;
        if (searchCallCount === 1) return jsonResponse(200, { results: [SAMPLE_STATE_ROW] });
        throw new Error("network down na releitura (simulado)");
      }
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639", "--send"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
    assert.equal(searchCallCount, 2, "precisa tentar reler mesmo que a 2ª leitura falhe");
  });

  it("mutação aceita, mas releitura não encontra mais a ação -> falha (estado inesperado)", async () => {
    let searchCallCount = 0;
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":mutate")) return jsonResponse(200, { results: [{ resourceName: SAMPLE_STATE_ROW.conversionAction.resourceName }] });
      if (input.endsWith(":search")) {
        searchCallCount++;
        if (searchCallCount === 1) return jsonResponse(200, { results: [SAMPLE_STATE_ROW] });
        return jsonResponse(200, { results: [] });
      }
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      setPrimaryMain(
        ["--conversion-action-id", "7758161410", "--target", "false", "--customer-id", "2369219639", "--send"],
        fetchMock as unknown as typeof fetch,
      ),
    );
    assert.equal(code, 1);
  });
});

// ---------------------------------------------------------------------------
// --skip-registro e propagação de falha de registrarEdicaoMain
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-set-conversion-primary: registro em edicoes.jsonl", () => {
  it("--skip-registro: sucesso mesmo sem gravar nada em edicoes.jsonl", async () => {
    const edicoesDir = mkdtempSync(join(tmpdir(), "gads-conv-primary-8960-skip-"));
    const edicoesPath = join(edicoesDir, "edicoes.jsonl");
    try {
      let searchCallCount = 0;
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":mutate")) {
          const body = JSON.parse(String(init?.body));
          return jsonResponse(200, { results: [{ resourceName: body.operations[0].update.resourceName }] });
        }
        if (input.endsWith(":search")) {
          searchCallCount++;
          const primaryForGoal = searchCallCount === 1; // antes: true, depois: false
          return jsonResponse(200, { results: [{ conversionAction: { ...SAMPLE_STATE_ROW.conversionAction, primaryForGoal } }] });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
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
            "--skip-registro",
            "--edicoes-path",
            edicoesPath,
          ],
          fetchMock as unknown as typeof fetch,
        ),
      );
      assert.equal(code, 0);
      assert.equal(existsSync(edicoesPath), false, "--skip-registro nunca deve escrever em edicoes.jsonl");
    } finally {
      rmSync(edicoesDir, { recursive: true, force: true });
    }
  });

  it("falha de registrarEdicaoMain (I/O) é propagada como exit 1, apesar da mutação/releitura terem confirmado", async () => {
    // Força `mkdirSync(dirname(edicoesPath))` a falhar: `edicoesPath` mira um
    // subdiretório de um ARQUIVO (não-diretório), então criar o diretório-pai
    // falha com ENOTDIR -- registrarEdicaoMain devolve 2 (!== 0), e o CLI
    // precisa propagar isso como falha, nunca reportar sucesso.
    const dir = mkdtempSync(join(tmpdir(), "gads-conv-primary-8960-registro-falha-"));
    const fileNotDir = join(dir, "arquivo-nao-diretorio");
    writeFileSync(fileNotDir, "conteúdo qualquer");
    const edicoesPath = join(fileNotDir, "sub", "edicoes.jsonl");
    try {
      let searchCallCount = 0;
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":mutate")) {
          const body = JSON.parse(String(init?.body));
          return jsonResponse(200, { results: [{ resourceName: body.operations[0].update.resourceName }] });
        }
        if (input.endsWith(":search")) {
          searchCallCount++;
          const primaryForGoal = searchCallCount === 1;
          return jsonResponse(200, { results: [{ conversionAction: { ...SAMPLE_STATE_ROW.conversionAction, primaryForGoal } }] });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
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
      assert.equal(code, 1, "falha ao gravar o registro precisa propagar como exit 1, mesmo com a mutação já confirmada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
