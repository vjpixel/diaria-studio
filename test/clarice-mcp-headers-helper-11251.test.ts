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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  // Cobre só a função pura (mesma precedência dos wrappers do #8994). No
  // runtime do Claude Code o ambiente do helper vem SEM vars com `KEY` no
  // nome, então ali o `.env` é a única fonte — ver os testes de processo abaixo.
  it("ambiente vence o .env quando os dois têm valor (função pura, não o runtime do Claude Code)", () => {
    const { env } = envWithProjectKeys([CLARICE_API_KEY_KEY], {
      root: "/nao-existe",
      env: { CLARICE_API_KEY: "k-env" },
      readFile: fakeEnvFile({ CLARICE_API_KEY: "k-file" }),
    });
    assert.equal((resolveClariceHeaders(env) as { headers: Record<string, string> }).headers[CLARICE_MCP_HEADER], "k-env");
  });

  it("ausente nos dois → headers {} + aviso, nunca header vazio nem erro", () => {
    for (const env of [{}, { CLARICE_API_KEY: "" }, { CLARICE_API_KEY: "   " }]) {
      const r = resolveClariceHeaders(env);
      assert.deepEqual(r.headers, {});
      assert.match(r.warning ?? "", /CLARICE_API_KEY ausente/);
    }
  });

  it("key com quebra de linha → headers {} + aviso sem ecoar o valor", () => {
    const r = resolveClariceHeaders({ CLARICE_API_KEY: "segredo-abc\nX-Outro: 1" });
    assert.deepEqual(r.headers, {});
    assert.ok(r.warning && !r.warning.includes("segredo-abc"), "aviso não pode carregar a key");
  });
});

/**
 * Roda uma cópia do helper numa raiz descartável (com `node_modules` linkado),
 * pra controlar o `.env` sem tocar no do checkout. `dotEnv`: conteúdo do
 * `.env`; `"dir"` cria um diretório no lugar (ilegível como arquivo); omitido,
 * sem `.env`.
 */
function runHelperInSandbox(dotEnv: string | "dir" | undefined, env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "clarice-headers-11251-"));
  try {
    mkdirSync(join(root, "scripts/mcp"), { recursive: true });
    for (const f of ["clarice-headers.mjs", "mcp-wrapper-core.mjs"]) {
      copyFileSync(join(PROJECT_ROOT, "scripts/mcp", f), join(root, "scripts/mcp", f));
    }
    // O `node_modules` que resolve o `dotenv` pro checkout (num worktree, é o
    // do checkout principal, um nível acima).
    const nodeModules = dirname(dirname(createRequire(join(PROJECT_ROOT, "package.json")).resolve("dotenv/package.json")));
    symlinkSync(nodeModules, join(root, "node_modules"), "junction");
    if (dotEnv === "dir") mkdirSync(join(root, ".env"));
    else if (dotEnv !== undefined) writeFileSync(join(root, ".env"), dotEnv);
    return spawnSync(process.execPath, [join(root, "scripts/mcp/clarice-headers.mjs")], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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

  it("key no .env, ambiente sem a var (o que o Claude Code entrega ao helper) → header com a key do .env", () => {
    const res = runHelperInSandbox("CLARICE_API_KEY=k-dotenv-11251\n", {});
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), { "X-Clarice-Api-Key": "k-dotenv-11251" });
    assert.ok(!res.stderr.includes("k-dotenv-11251"), "a key nunca vai pra stderr");
  });

  // Regressão do review do #11251: máquina com a key SÓ no ambiente. O Claude
  // Code tira `CLARICE_API_KEY` do ambiente do helper (nome com KEY), então o
  // helper não acha key nenhuma. Ele precisa sair 0 com `{}` — exit 1 arriscava
  // derrubar a conexão que o `${CLARICE_API_KEY}` estático faria funcionar.
  it("env-only: sem .env e sem a var no ambiente do helper → exit 0, stdout {}, aviso em stderr", () => {
    const res = runHelperInSandbox(undefined, {});
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), {});
    assert.match(res.stderr, /CLARICE_API_KEY ausente/);
  });

  it("key com quebra de linha no .env → exit 0, stdout {}, sem ecoar o valor", () => {
    const res = runHelperInSandbox('CLARICE_API_KEY="segredo-xyz\\nX-Outro: 1"\n', {});
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), {});
    assert.match(res.stderr, /quebra de linha/);
    assert.ok(!res.stderr.includes("segredo-xyz"), "a key nunca vai pra stderr");
  });

  it(".env ilegível → exit 0, stdout {} (não derruba o header estático)", () => {
    const res = runHelperInSandbox("dir", {});
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), {});
    assert.match(res.stderr, /falha ao ler/);
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

  it("o header estático, se presente, tem o MESMO nome do dinâmico (o helper o sobrepõe)", () => {
    // Doc oficial: "Dynamic headers override any static `headers` with the
    // same name". Se ele tivesse outro nome, o servidor receberia os dois.
    for (const name of Object.keys(clarice.headers ?? {})) {
      assert.equal(name, CLARICE_MCP_HEADER);
    }
  });

  it("o header estático `${CLARICE_API_KEY}` continua declarado (load-bearing)", () => {
    // Sem trust aceito (inclusive `claude -p` headless da edição agendada) o
    // helper não roda; e na máquina com a key só no ambiente ele devolve `{}`.
    // Nos dois casos quem autentica é este header — removê-lo regride ambos.
    assert.equal(clarice.headers?.[CLARICE_MCP_HEADER], "${CLARICE_API_KEY}");
  });
});
