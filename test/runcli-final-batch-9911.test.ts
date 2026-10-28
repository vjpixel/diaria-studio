/**
 * #9911, 5º lote: os 7 últimos scripts da allowlist do guard fetch +
 * process.exit migram para `runCli`, e a allowlist fica vazia.
 *
 * Ressalvas da decisão do editor (13/10/2026), cada uma travada aqui:
 *  - servidores (oauth-setup, serve-preview): sem `process.exit`, o processo
 *    só sai com o loop vazio — o teardown precisa liberar todo handle, senão
 *    o processo fica pendurado. Os testes sobem o processo de verdade e
 *    exigem que ele termine sozinho, com o código certo.
 *  - os testes que substituíam `process.exit` (clarice-engagement-cohorts-v2,
 *    publish-monthly) foram reescritos para ler o código devolvido por main();
 *    aqui fica o caminho ponta a ponta pelo processo.
 *  - verify-emails-mv: Ctrl+C aborta os fetches pagos em voo
 *    (AbortController) e sai 130, como antes; erro fatal da API sai 1.
 *
 * Só caminhos sem rede real e sem efeito fora de diretório temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ALLOWLIST, scanProcessExitAfterFetch } from "../scripts/lib/process-exit-fetch-scan.ts";
import { CliExit } from "../scripts/lib/cli-exit.ts";
import { verifyCohortList, mvOutputBase } from "../scripts/verify-emails-mv.ts";
import { exitCodeFor } from "../scripts/studio/verify-remote-tunnel.ts";
import { main as rampMain } from "../scripts/clarice-schedule-ramp.ts";
import { waitForOAuthCode } from "../scripts/oauth-setup.ts";

/** #11243: pulado só no Windows (Neo); no CI Linux e no `300` roda normal. */
const SKIP_WIN32 = process.platform === "win32" && "#11243: sinais POSIX; no Windows o SIGTERM vira TerminateProcess e o handler nunca roda";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BATCH_5 = [
  "scripts/clarice-engagement-cohorts-v2.ts",
  "scripts/clarice-schedule-ramp.ts",
  "scripts/oauth-setup.ts",
  "scripts/publish-monthly.ts",
  "scripts/serve-preview.ts",
  "scripts/studio/verify-remote-tunnel.ts",
  "scripts/verify-emails-mv.ts",
];

const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", resolve(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });

/** Silencia console.error/log durante `fn`. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const origErr = console.error;
  const origLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}

describe("5º lote migrado (#9911): allowlist vazia", () => {
  it("a allowlist está vazia e nenhum script do lote combina fetch e process.exit", () => {
    assert.equal(ALLOWLIST.size, 0, [...ALLOWLIST].join(", "));
    const r = scanProcessExitAfterFetch(ROOT);
    assert.deepEqual(r.violations, []);
    for (const f of BATCH_5) assert.equal((r.violations as string[]).includes(f), false, f);
  });
});

describe("entry points do 5º lote propagam o código (#9911)", () => {
  // Env vazia (nunca removida): loadProjectEnv não sobrescreve var já
  // presente, então um .env local não transforma o teste em chamada de rede.
  const cases: Array<[string, string, string[], Record<string, string>, number]> = [
    ["verify-remote-tunnel sem --url", "scripts/studio/verify-remote-tunnel.ts", [], { STUDIO_REMOTE_URL: "" }, 2],
    ["clarice-schedule-ramp sem --cycle", "scripts/clarice-schedule-ramp.ts", [], {}, 1],
    ["publish-monthly sem --cycle/--yymm (CliExit em parseArgs)", "scripts/publish-monthly.ts", [], {}, 1],
    ["publish-monthly com --list-id inválido (CliExit em parseArgs)", "scripts/publish-monthly.ts", ["--cycle", "2604-05", "--list-id", "abc"], {}, 1],
    ["clarice-engagement-cohorts-v2 sem BREVO_CLARICE_API_KEY", "scripts/clarice-engagement-cohorts-v2.ts", [], { BREVO_CLARICE_API_KEY: "" }, 1],
    ["verify-emails-mv sem MILLION_VERIFIER_API_KEY", "scripts/verify-emails-mv.ts", [], { MILLION_VERIFIER_API_KEY: "" }, 1],
    ["oauth-setup sem GOOGLE_CLIENT_ID (antes de abrir browser ou servidor)", "scripts/oauth-setup.ts", [], { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }, 1],
    ["serve-preview sem --file", "scripts/serve-preview.ts", [], {}, 2],
    ["serve-preview com --idle-exit-min inválido", "scripts/serve-preview.ts", ["--file", "x.html", "--idle-exit-min", "abc"], {}, 2],
  ];

  for (const [name, script, args, env, code] of cases) {
    it(`${name} sai ${code}`, () => {
      const r = run(script, args, env);
      assert.equal(r.status, code, r.stderr);
      assert.doesNotMatch(r.stderr, /CliExit\(/, "CliExit não pode vazar como erro fatal");
    });
  }
});

describe("verify-remote-tunnel: mapeamento de código (#9911)", () => {
  it("blocked 0, leaked 1, unknown 2", () => {
    assert.equal(exitCodeFor("blocked"), 0);
    assert.equal(exitCodeFor("leaked"), 1);
    assert.equal(exitCodeFor("unknown"), 2);
  });
});

describe("clarice-schedule-ramp main() devolve o código (#9911)", () => {
  it("--days com 2 rótulos devolve 1 (antes de qualquer fetch: --volumes explícito)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ramp-9911-"));
    try {
      const code = await quiet(() =>
        rampMain(["--cycle", "2606-07", "--volumes", "10,20,30", "--days", "a,b", "--data-root", dir]),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run com --volumes explícito devolve undefined (sai 0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ramp-9911-"));
    try {
      const code = await quiet(() => rampMain(["--cycle", "2606-07", "--volumes", "10,20,30", "--data-root", dir]));
      assert.equal(code, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verify-emails-mv: Ctrl+C aborta os fetches pagos (#9911)", () => {
  const rows = [
    { email: "a@x.com", name: "A" },
    { email: "b@x.com", name: "B" },
    { email: "c@x.com", name: "C" },
    { email: "d@x.com", name: "D" },
  ];
  const params = (cycleDir: string) => ({
    apiKey: "fake-key",
    cohort: "t-9911",
    cycleDir,
    rows,
    fields: ["email", "name"],
    emailKey: "email",
    allCohortRows: rows,
    concurrency: 2,
    timeout: 5,
    limit: null,
    _sleep: async () => {},
  });

  it("SIGINT aborta o fetch em voo, não inicia novos, salva o checkpoint e lança CliExit(130)", async () => {
    const cycleDir = mkdtempSync(join(tmpdir(), "mv-sigint-9911-"));
    const origFetch = globalThis.fetch;
    const calls: string[] = [];
    const abortedSignals: string[] = [];
    let hanging = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const email = new URL(String(input)).searchParams.get("email") ?? "";
      calls.push(email);
      if (email === "a@x.com") {
        return new Response(JSON.stringify({ email, result: "ok", resultcode: 1, quality: "good", credits: 10 }), {
          status: 200,
        });
      }
      // Os demais ficam pendurados até o sinal abortar (requisição paga em voo).
      return new Promise<Response>((_, reject) => {
        hanging++;
        if (hanging === 2) setImmediate(() => process.emit("SIGINT"));
        init?.signal?.addEventListener("abort", () => {
          abortedSignals.push(email);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as typeof fetch;
    const listenersBefore = process.listenerCount("SIGINT");
    try {
      await quiet(async () => {
        await assert.rejects(verifyCohortList(params(cycleDir)), (e: unknown) => e instanceof CliExit && e.code === 130);
      });
      // Os 2 fetches em voo foram abortados; o 4º e-mail nunca foi pedido.
      assert.deepEqual(abortedSignals.sort(), ["b@x.com", "c@x.com"]);
      assert.equal(calls.includes("d@x.com"), false, "nenhum fetch novo depois do Ctrl+C");
      // Sem retry depois da interrupção: cada e-mail pedido uma vez só.
      assert.equal(calls.length, 3);
      // Checkpoint com o resultado já pago; nenhum CSV de saída parcial.
      const base = mvOutputBase("t-9911");
      const cp = JSON.parse(readFileSync(join(cycleDir, `.mv-cache-${base}.json`), "utf8"));
      assert.deepEqual(Object.keys(cp), ["a@x.com"]);
      assert.equal(existsSync(join(cycleDir, `${base}-verified.csv`)), false);
      assert.equal(process.listenerCount("SIGINT"), listenersBefore, "handler de SIGINT removido");
    } finally {
      globalThis.fetch = origFetch;
      rmSync(cycleDir, { recursive: true, force: true });
    }
  });

  it("erro fatal da API (401) lança CliExit(1) e remove os handlers de sinal", async () => {
    const cycleDir = mkdtempSync(join(tmpdir(), "mv-fatal-9911-"));
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const before = process.listenerCount("SIGTERM");
    try {
      await quiet(async () => {
        await assert.rejects(verifyCohortList(params(cycleDir)), (e: unknown) => e instanceof CliExit && e.code === 1);
      });
      assert.equal(process.listenerCount("SIGTERM"), before);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(cycleDir, { recursive: true, force: true });
    }
  });
});

describe("oauth-setup: o callback libera os handles (#9911)", () => {
  it("resolve com o code e fecha o servidor", async () => {
    let port = 0;
    const p = waitForOAuthCode(0, {
      onListening: (pt) => {
        port = pt;
        void fetch(`http://127.0.0.1:${pt}/oauth/callback?code=abc123`).then((r) => r.text());
      },
    });
    assert.equal(await p, "abc123");
    // Servidor fechado: nova conexão é recusada.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/oauth/callback?code=x`));
  });

  it("processo que só espera o callback termina sozinho (sem timer de 5 min nem socket pendurado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oauth-9911-"));
    try {
      const mod = pathToFileURL(resolve(ROOT, "scripts/oauth-setup.ts")).href;
      const fixture = join(dir, "wait.ts");
      writeFileSync(
        fixture,
        `import { request } from "node:http";\n` +
          `import { waitForOAuthCode } from ${JSON.stringify(mod)};\n` +
          `const q = process.argv[2];\n` +
          `waitForOAuthCode(0, { onListening: (p) => { request("http://127.0.0.1:" + p + "/oauth/callback?" + q, (r) => r.resume()).end(); } })\n` +
          `  .then((c) => { process.exitCode = c === "ok" ? 0 : 3; }, () => { process.exitCode = 4; });\n`,
      );
      for (const [query, code] of [["code=ok", 0], ["error=access_denied", 4]] as const) {
        const t0 = Date.now();
        const r = spawnSync(process.execPath, ["--import", "tsx", fixture, query], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 20_000,
        });
        assert.equal(r.signal, null, `processo pendurado (morto pelo timeout): ${r.stderr}`);
        assert.equal(r.status, code, r.stderr);
        assert.ok(Date.now() - t0 < 20_000);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("serve-preview: teardown por sinal sai 0 sem process.exit (#9911)", { skip: SKIP_WIN32 }, () => {
  for (const watch of [false, true]) {
    it(`SIGTERM encerra o servidor${watch ? " com --watch" : ""} e o processo sai 0`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "serve-preview-9911-"));
      const file = join(dir, "p.html");
      writeFileSync(file, "<html><body>ok</body></html>");
      const args = [resolve(ROOT, "scripts/serve-preview.ts"), "--file", file, ...(watch ? ["--watch"] : [])];
      const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      try {
        // Espera o JSON de start (servidor no ar) e faz 1 request de verdade.
        const url = await new Promise<string>((res, rej) => {
          const t = setTimeout(() => rej(new Error(`servidor não subiu: ${err}`)), 20_000);
          child.stdout.on("data", () => {
            const m = out.match(/"url":\s*"([^"]+)"/);
            if (m) {
              clearTimeout(t);
              res(m[1]);
            }
          });
        });
        const resp = await fetch(url);
        assert.equal(resp.status, 200);
        await resp.text();
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
          child.once("exit", (code, signal) => res({ code, signal })),
        );
        child.kill("SIGTERM");
        const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 15_000).unref());
        const r = await Promise.race([exit, timeout]);
        assert.notEqual(r, "timeout", `processo não saiu depois do SIGTERM: ${err}`);
        assert.deepEqual(r, { code: 0, signal: null }, err);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
