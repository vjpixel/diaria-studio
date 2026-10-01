/**
 * #8994 — wrappers dos MCPs stdio `google-ads` e `doppler`. Regressão:
 * `.mcp.json` interpolava `${VAR}` do ambiente do harness, que nunca carrega
 * o `.env` do projeto — o doppler subia com token vazio (CONNECTION_CLOSED)
 * e o google-ads subia sem credencial e via `pipx run --spec` lento
 * (CONNECT_TIMEOUT 30s). Testa só o núcleo puro; não sobe servidor real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  GOOGLE_ADS_ENV_KEYS,
  GOOGLE_ADS_MCP_SPEC,
  PROJECT_ROOT,
  buildSpawnSpec,
  envWithProjectKeys,
  findOnPath,
  mergeEnvNoOverride,
  pickKeys,
  readEnvFile,
  resolveDopplerLaunch,
  resolveGoogleAdsLaunch,
} from "../scripts/mcp/mcp-wrapper-core.mjs";

describe("mergeEnvNoOverride (#8994)", () => {
  it("não sobrescreve var já presente e não vazia", () => {
    const out = mergeEnvNoOverride({ A: "env" }, { A: "file", B: "file" });
    assert.deepEqual(out, { A: "env", B: "file" });
  });
  it("var presente mas VAZIA (${VAR} não resolvido) é preenchida pelo .env", () => {
    assert.equal(mergeEnvNoOverride({ A: "" }, { A: "file" }).A, "file");
  });
  it("não muta o objeto base", () => {
    const base = { A: "x" };
    mergeEnvNoOverride(base, { B: "y" });
    assert.deepEqual(base, { A: "x" });
  });
});

describe("pickKeys / readEnvFile / envWithProjectKeys (#8994)", () => {
  it("pickKeys só repassa as chaves pedidas (menor privilégio)", () => {
    assert.deepEqual(pickKeys({ A: "1", SECRET: "2" }, ["A", "Z"]), { A: "1" });
  });
  it("readEnvFile ausente → {}", () => {
    assert.deepEqual(readEnvFile("/nao/existe/.env", { exists: () => false }), {});
  });
  it("readEnvFile parseia formato dotenv", () => {
    const vars = readEnvFile("x", { exists: () => true, read: () => "# c\nA=1\nB=\"dois\"\n" });
    assert.deepEqual(vars, { A: "1", B: "dois" });
  });
  it("envWithProjectKeys preenche só as chaves pedidas, sem sobrescrever o ambiente", () => {
    const out = envWithProjectKeys(GOOGLE_ADS_ENV_KEYS, {
      root: "/r",
      env: { PATH: "/bin", GOOGLE_ADS_CUSTOMER_ID: "do-ambiente" },
      readFile: () => ({
        GOOGLE_ADS_CUSTOMER_ID: "do-arquivo",
        GOOGLE_ADS_DEVELOPER_TOKEN: "tok",
        BREVO_API_KEY: "nao-deve-vazar",
      }),
    });
    assert.equal(out.GOOGLE_ADS_CUSTOMER_ID, "do-ambiente");
    assert.equal(out.GOOGLE_ADS_DEVELOPER_TOKEN, "tok");
    assert.equal(out.BREVO_API_KEY, undefined);
    assert.equal(out.PATH, "/bin");
  });
});

describe("findOnPath (#8994)", () => {
  it("posix: acha no PATH", () => {
    const hit = findOnPath("google-ads-mcp", {
      env: { PATH: "/a:/b" },
      platform: "linux",
      exists: (p: string) => p === "/b/google-ads-mcp",
    });
    assert.equal(hit, "/b/google-ads-mcp");
  });
  it("win32: usa PATHEXT e ignora o nome sem extensão", () => {
    const seen: string[] = [];
    const hit = findOnPath("npx", {
      env: { Path: "C:\\node", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      exists: (p: string) => {
        seen.push(p);
        return p === "C:\\node\\npx.cmd" || p === "C:\\node\\npx";
      },
    });
    assert.equal(hit, "C:\\node\\npx.cmd");
    assert.ok(!seen.includes("C:\\node\\npx"));
  });
  it("ausente → null", () => {
    assert.equal(findOnPath("x", { env: { PATH: "/a" }, platform: "linux", exists: () => false }), null);
  });
});

describe("resolveGoogleAdsLaunch (#8994)", () => {
  it("prefere o binário instalado, sem aviso", () => {
    const r = resolveGoogleAdsLaunch({ find: (n: string) => (n === "google-ads-mcp" ? "/bin/google-ads-mcp" : "/bin/pipx") });
    assert.deepEqual(r, { command: "/bin/google-ads-mcp", args: [], warning: null });
  });
  it("binário ausente → pipx run --spec com aviso recomendando pipx install", () => {
    const r = resolveGoogleAdsLaunch({ find: (n: string) => (n === "pipx" ? "/bin/pipx" : null) });
    assert.equal(r.command, "/bin/pipx");
    assert.deepEqual(r.args, ["run", "--spec", GOOGLE_ADS_MCP_SPEC, "google-ads-mcp"]);
    assert.match(r.warning, /pipx install git\+https:\/\/github\.com\/googleads\/google-ads-mcp\.git/);
  });
  it("nem binário nem pipx → erro", () => {
    assert.ok(resolveGoogleAdsLaunch({ find: () => null }).error);
  });
});

describe("resolveDopplerLaunch (#8994)", () => {
  it("token ausente → erro claro, não sobe servidor", () => {
    const r = resolveDopplerLaunch({}, { find: () => "/bin/npx" });
    assert.match(r.error, /DOPPLER_MCP_TOKEN ausente — adicione ao \.env/);
    assert.equal(r.command, undefined);
  });
  it("token vazio conta como ausente", () => {
    assert.ok(resolveDopplerLaunch({ DOPPLER_MCP_TOKEN: "" }, { find: () => "/bin/npx" }).error);
  });
  it("não cai para um DOPPLER_TOKEN pré-existente (escopo mais amplo)", () => {
    assert.ok(resolveDopplerLaunch({ DOPPLER_TOKEN: "amplo" }, { find: () => "/bin/npx" }).error);
  });
  it("token presente → npx read-only com DOPPLER_TOKEN no filho", () => {
    const r = resolveDopplerLaunch({ DOPPLER_MCP_TOKEN: "t" }, { find: () => "/bin/npx" });
    assert.equal(r.command, "/bin/npx");
    assert.deepEqual(r.args, ["-y", "@dopplerhq/mcp-server", "--read-only"]);
    assert.deepEqual(r.childEnv, { DOPPLER_TOKEN: "t" });
  });
});

describe("buildSpawnSpec (#8994)", () => {
  it("win32 + .cmd passa por cmd.exe com caminho entre aspas", () => {
    const s = buildSpawnSpec("C:\\Program Files\\nodejs\\npx.cmd", ["-y", "pkg"], {
      platform: "win32",
      env: { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
    });
    assert.equal(s.command, "C:\\WINDOWS\\system32\\cmd.exe");
    assert.deepEqual(s.args, ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npx.cmd" -y pkg"']);
    assert.equal(s.options.windowsVerbatimArguments, true);
  });
  it(".exe e posix spawnam direto", () => {
    assert.deepEqual(buildSpawnSpec("C:\\x\\a.exe", ["b"], { platform: "win32", env: {} }), {
      command: "C:\\x\\a.exe",
      args: ["b"],
      options: {},
    });
    assert.equal(buildSpawnSpec("/bin/a", [], { platform: "linux", env: {} }).command, "/bin/a");
  });
});

describe(".mcp.json aponta pros wrappers (#8994)", () => {
  const cfg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, ".mcp.json"), "utf8"));
  it("google-ads e doppler usam node + wrapper, sem env ${VAR} interpolado pelo harness", () => {
    assert.deepEqual(cfg.mcpServers["google-ads"], { command: "node", args: ["scripts/mcp/run-google-ads-mcp.mjs"] });
    assert.deepEqual(cfg.mcpServers.doppler, { command: "node", args: ["scripts/mcp/run-doppler-mcp.mjs"] });
  });
});

describe("run-doppler-mcp.mjs sem token (#8994)", () => {
  it("sai ≠0, mensagem em stderr, stdout vazio (canal MCP intocado)", () => {
    // root sem .env de verdade não é injetável no entrypoint; zera o token no
    // ambiente e só roda se o .env do checkout também não tiver um.
    const envFile = readEnvFile(join(PROJECT_ROOT, ".env"));
    if (envFile.DOPPLER_MCP_TOKEN) return; // máquina provisionada — caso coberto pelos testes puros
    const env = { ...process.env, DOPPLER_MCP_TOKEN: "" };
    const r = spawnSync(process.execPath, [join(PROJECT_ROOT, "scripts/mcp/run-doppler-mcp.mjs")], {
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /DOPPLER_MCP_TOKEN ausente/);
  });
});
