/**
 * #11251 — MCP `clarice` devolvia 401 no `300`: o `.mcp.json` só tinha o
 * header estático `X-Clarice-Api-Key: ${CLARICE_API_KEY}`, expandido do
 * ambiente do processo do Claude Code. As sessões interativas do `300` sobem
 * sem o `.env` no ambiente, então o header ia vazio. O fix é um
 * `headersHelper` (`scripts/mcp/clarice-headers.mjs`) que lê a key do
 * ambiente ou do `.env` do projeto. Regressão: `.mcp.json` sem o helper volta
 * a depender de quem lançou a sessão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CLARICE_API_KEY_KEY,
  CLARICE_MCP_HEADER,
  PROJECT_ROOT,
  envWithProjectKeys,
  resolveClariceHeaders,
} from "../scripts/mcp/mcp-wrapper-core.mjs";

const HELPER = join(PROJECT_ROOT, "scripts/mcp/clarice-headers.mjs");

/** `.env` falso injetado: o teste nunca lê o `.env` real da máquina. */
function fakeEnvFile(vars: Record<string, string>) {
  return () => vars;
}

describe("resolveClariceHeaders (#11251)", () => {
  it("key no ambiente → header X-Clarice-Api-Key", () => {
    const r = resolveClariceHeaders({ CLARICE_API_KEY: "k-env" });
    assert.deepEqual(r, { headers: { "X-Clarice-Api-Key": "k-env" } });
  });

  it("key só no .env (cenário do 300: ambiente sem a var) → header com a key do .env", () => {
    const { env } = envWithProjectKeys([CLARICE_API_KEY_KEY], {
      root: "/nao-existe",
      env: { PATH: "/usr/bin" },
      readFile: fakeEnvFile({ CLARICE_API_KEY: "k-file", OUTRA_KEY: "nao-vaza" }),
    });
    const r = resolveClariceHeaders(env);
    assert.deepEqual(r, { headers: { [CLARICE_MCP_HEADER]: "k-file" } });
  });

  it("var VAZIA no ambiente (o `${CLARICE_API_KEY}` não resolvido) é preenchida pelo .env", () => {
    const { env } = envWithProjectKeys([CLARICE_API_KEY_KEY], {
      root: "/nao-existe",
      env: { CLARICE_API_KEY: "" },
      readFile: fakeEnvFile({ CLARICE_API_KEY: "k-file" }),
    });
    assert.equal((resolveClariceHeaders(env) as { headers: Record<string, string> }).headers[CLARICE_MCP_HEADER], "k-file");
  });

  it("ambiente vence o .env quando os dois têm valor", () => {
    const { env } = envWithProjectKeys([CLARICE_API_KEY_KEY], {
      root: "/nao-existe",
      env: { CLARICE_API_KEY: "k-env" },
      readFile: fakeEnvFile({ CLARICE_API_KEY: "k-file" }),
    });
    assert.equal((resolveClariceHeaders(env) as { headers: Record<string, string> }).headers[CLARICE_MCP_HEADER], "k-env");
  });

  it("ausente nos dois → erro, nunca header vazio", () => {
    for (const env of [{}, { CLARICE_API_KEY: "" }, { CLARICE_API_KEY: "   " }]) {
      const r = resolveClariceHeaders(env);
      assert.ok(!("headers" in r));
      assert.match(r.error ?? "", /CLARICE_API_KEY ausente/);
    }
  });

  it("key com quebra de linha → erro sem ecoar o valor", () => {
    const r = resolveClariceHeaders({ CLARICE_API_KEY: "segredo-abc\nX-Outro: 1" });
    assert.ok(!("headers" in r));
    assert.ok(r.error && !r.error.includes("segredo-abc"), "mensagem não pode carregar a key");
  });
});

describe("scripts/mcp/clarice-headers.mjs (processo real, #11251)", () => {
  it("imprime em stdout um objeto JSON de headers string→string", () => {
    const res = spawnSync(process.execPath, [HELPER], {
      env: { PATH: process.env.PATH ?? "", CLARICE_API_KEY: "fake-11251" },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.deepEqual(parsed, { "X-Clarice-Api-Key": "fake-11251" });
    assert.ok(!res.stderr.includes("fake-11251"), "a key nunca vai pra stderr");
  });

  it("sem key em lugar nenhum → exit 1, stdout vazio, mensagem em stderr", { skip: existsSync(join(PROJECT_ROOT, ".env")) ? "checkout com .env real — o caso ausente é coberto pelo teste puro acima" : false }, () => {
    const res = spawnSync(process.execPath, [HELPER], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    assert.equal(res.status, 1);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /CLARICE_API_KEY ausente/);
  });
});

describe(".mcp.json → clarice usa headersHelper (#11251)", () => {
  const mcp = JSON.parse(readFileSync(join(PROJECT_ROOT, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { type?: string; url?: string; headersHelper?: string; headers?: Record<string, string> }>;
  };
  const clarice = mcp.mcpServers.clarice;

  it("servidor http com headersHelper apontando pro script do repo", () => {
    assert.equal(clarice.type, "http");
    assert.equal(clarice.headersHelper, "node scripts/mcp/clarice-headers.mjs");
    const scriptPath = clarice.headersHelper!.split(" ")[1];
    assert.ok(existsSync(join(PROJECT_ROOT, scriptPath)), `${scriptPath} não existe`);
  });

  it("o header estático, se presente, tem o MESMO nome do dinâmico (o helper o sobrepõe) e é só fallback", () => {
    // Doc oficial: "Dynamic headers override any static `headers` with the
    // same name". O estático fica só pra quando o helper não roda (pasta sem
    // trust). Se ele tivesse outro nome, o servidor receberia os dois.
    for (const name of Object.keys(clarice.headers ?? {})) {
      assert.equal(name, CLARICE_MCP_HEADER);
    }
  });
});
