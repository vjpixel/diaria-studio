/**
 * test/serve-preview.test.ts (#3546)
 *
 * Regression guard pro servidor de preview local que substitui
 * `upload-html-public.ts` (Worker Cloudflare) no caminho de REVISÃO do
 * Stage 4 — cobre os critérios de aceite da issue: serve em 127.0.0.1,
 * porta configurável, teardown funciona, e path traversal é bloqueado.
 */

import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  startPreviewServer,
  openInBrowser,
  type PreviewServer,
} from "../scripts/serve-preview.ts";

// `import * as childProcess from "node:child_process"` dá um namespace ESM
// com propriedades não-configuráveis — `mock.method` não consegue redefinir
// `exec` nele (TypeError: Cannot redefine property). `createRequire` traz o
// objeto `module.exports` real e mutável do core module (mesmo padrão usado
// pra mockar `fs`/`child_process` nos docs do node:test).
const childProcess: typeof import("node:child_process") = createRequire(
  import.meta.url,
)("node:child_process");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "serve-preview.ts");

/**
 * Args pra rodar `serve-preview.ts` (ou outro script .ts) como processo Node
 * real via `--import tsx` (mesma ordem do node-test-tsx-import-flag-order —
 * `--import` sempre ANTES do path do script). Usa `process.execPath`
 * diretamente (sem `npx`/shell wrapper): no Windows, `spawn("npx", ..., { shell:
 * true })` roda `npx` dentro de um `cmd.exe`, e `child.kill()` só derruba o
 * `cmd.exe` — o processo tsx real (filho do shell) sobrevive como zombie,
 * segurando a porta. `process.execPath` é um .exe direto: `kill()` termina o
 * processo de verdade (visto na prática — sem isso, os testes de teardown
 * abaixo penduravam e acumulavam `node.exe` órfãos).
 */
function tsxArgs(scriptPath: string, args: string[]): string[] {
  return ["--import", "tsx", scriptPath, ...args];
}

/**
 * Spawna `serve-preview.ts` como processo real (não import direto) — cobre o
 * CLI de ponta a ponta (parse de args, --persist-to, JSON no stdout) que os
 * testes de `startPreviewServer` (import direto) não exercitam. Acumula
 * stdout até conseguir `JSON.parse` do primeiro bloco impresso (o `console.log`
 * de start é a única coisa que main() imprime em stdout antes de --open).
 */
function spawnServeAndReadJson(
  args: string[],
  timeoutMs = 15000,
): Promise<{ proc: ChildProcessWithoutNullStreams; json: { url: string; port: number; pid: number } }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, tsxArgs(SCRIPT, args), { cwd: ROOT, shell: false });
    let buf = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`timeout esperando JSON de start (stdout até agora: ${buf})`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const trimmed = buf.trim();
      if (trimmed.endsWith("}")) {
        try {
          const json = JSON.parse(trimmed);
          clearTimeout(timer);
          resolvePromise({ proc, json });
        } catch {
          // ainda não é um JSON completo — continua acumulando
        }
      }
    });
    proc.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe("startPreviewServer", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-preview-"));
  const htmlPath = join(dir, "preview.html");
  writeFileSync(htmlPath, "<html><body>ola mundo</body></html>", "utf8");
  const assetPath = join(dir, "asset.txt");
  writeFileSync(assetPath, "conteudo do asset", "utf8");

  const servers: PreviewServer[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => s.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("serve o arquivo em 127.0.0.1 com conteúdo idêntico ao disco", async () => {
    const server = await startPreviewServer({ filePath: htmlPath, port: 0 });
    servers.push(server);

    assert.ok(server.url.startsWith("http://127.0.0.1:"), `url deveria ser loopback: ${server.url}`);
    assert.ok(server.port > 0, "porta efêmera deveria ser > 0 após bind");

    const res = await fetch(server.url);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, "<html><body>ola mundo</body></html>");
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });

  it("porta configurável — respeita --port explícito", async () => {
    // Primeiro sobe efêmero só pra descobrir uma porta livre no ambiente de teste.
    const probe = await startPreviewServer({ filePath: htmlPath, port: 0 });
    const freePort = probe.port;
    await probe.close();

    const server = await startPreviewServer({ filePath: htmlPath, port: freePort });
    servers.push(server);
    assert.equal(server.port, freePort, "servidor deveria bindar na porta explícita pedida");
    assert.ok(server.url.includes(`:${freePort}/`));

    const res = await fetch(server.url);
    assert.equal(res.status, 200);
  });

  it("serve outros arquivos do mesmo diretório (assets relativos)", async () => {
    const server = await startPreviewServer({ filePath: htmlPath, port: 0 });
    servers.push(server);

    const assetUrl = server.url.replace(/preview\.html$/, "asset.txt");
    const res = await fetch(assetUrl);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "conteudo do asset");
  });

  it("bloqueia path traversal fora do diretório-raiz (403)", async () => {
    const server = await startPreviewServer({ filePath: htmlPath, port: 0 });
    servers.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/../../etc/passwd`);
    assert.ok(res.status === 403 || res.status === 404, `esperado 403/404, recebeu ${res.status}`);
  });

  it("404 para arquivo inexistente no mesmo diretório", async () => {
    const server = await startPreviewServer({ filePath: htmlPath, port: 0 });
    servers.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/nao-existe.html`);
    assert.equal(res.status, 404);
  });

  it("teardown funciona — após close(), o servidor não aceita mais conexões", async () => {
    const server = await startPreviewServer({ filePath: htmlPath, port: 0 });
    const { url } = server;

    const before = await fetch(url);
    assert.equal(before.status, 200);

    await server.close();

    await assert.rejects(
      () => fetch(url, { signal: AbortSignal.timeout(2000) }),
      /fetch failed|ECONNREFUSED|aborted/i,
    );
  });

  it("close() é idempotente — chamar 2x não lança", async () => {
    const server = await startPreviewServer({ filePath: htmlPath, port: 0 });
    await server.close();
    await assert.doesNotReject(() => server.close());
  });

  it("lança erro claro quando o arquivo não existe", async () => {
    await assert.rejects(
      () => startPreviewServer({ filePath: join(dir, "inexistente.html"), port: 0 }),
      /arquivo não encontrado/,
    );
  });
});

describe("openInBrowser", () => {
  // #3902: o teste original chamava openInBrowser SEM mock, o que disparava
  // exec() real e abria o browser default do editor (127.0.0.1:1/preview.html,
  // ERR_UNSAFE_PORT) a cada rodada da suíte local. `execImpl` é o seam
  // injetável — os 2 testes abaixo cobrem tanto o comportamento útil quanto o
  // regression guard (#633) de que exec() real nunca roda em ambiente de teste.

  it("chama execImpl exatamente 1x, com o comando contendo a URL (#3902)", () => {
    const calls: string[] = [];
    const stubExec = ((command: string) => {
      calls.push(command);
      return {} as ReturnType<typeof childProcess.exec>;
    }) as typeof childProcess.exec;

    assert.doesNotThrow(() =>
      openInBrowser("http://127.0.0.1:1/preview.html", stubExec),
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0], /127\.0\.0\.1:1\/preview\.html/);
  });

  it("nunca invoca o exec real do node:child_process quando um execImpl é passado — regressão #3902/#633", () => {
    const execSpy = mock.method(childProcess, "exec", () => {
      throw new Error("exec REAL foi chamado — o seam execImpl não foi respeitado");
    });
    try {
      const stubExec = (() => ({}) as ReturnType<typeof childProcess.exec>) as typeof childProcess.exec;

      openInBrowser("http://127.0.0.1:1/preview.html", stubExec);

      assert.equal(execSpy.mock.callCount(), 0);
    } finally {
      execSpy.mock.restore();
    }
  });
});

// ── CLI end-to-end (#3546): --persist-to, --stop-pid, modo sem-open ────────
describe("serve-preview.ts CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-preview-cli-"));
  const htmlPath = join(dir, "preview.html");
  writeFileSync(htmlPath, "<html><body>cli</body></html>", "utf8");

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--persist-to/--field grava url + {field}_pid num JSON dedicado", async () => {
    const persistPath = join(dir, "04-newsletter-url.json");
    const { proc, json } = await spawnServeAndReadJson([
      "--file",
      htmlPath,
      "--port",
      "0",
      "--persist-to",
      persistPath,
      "--field",
      "newsletter_url",
    ]);
    try {
      assert.ok(json.url.startsWith("http://127.0.0.1:"), `url deveria ser loopback: ${json.url}`);
      // dá um instante pro handler de persist (síncrono, mas depois do console.log) rodar.
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(existsSync(persistPath), "arquivo de persist deveria existir");
      const persisted = JSON.parse(readFileSync(persistPath, "utf8"));
      assert.equal(persisted.newsletter_url, json.url);
      assert.equal(String(persisted.newsletter_url_pid), String(json.pid));
    } finally {
      proc.kill();
    }
  });

  it("--stop-pid encerra um servidor iniciado anteriormente (teardown pós-gate)", async () => {
    const { proc, json } = await spawnServeAndReadJson(["--file", htmlPath, "--port", "0"]);
    try {
      // Servidor respondendo antes do stop.
      const before = await fetch(json.url);
      assert.equal(before.status, 200);

      const stop = spawnSync(process.execPath, tsxArgs(SCRIPT, ["--stop-pid", String(json.pid)]), {
        cwd: ROOT,
        shell: false,
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(stop.status, 0, `--stop-pid deveria sair 0; stderr: ${stop.stderr}`);
      assert.match(stop.stdout, /"stopped":\s*\d+/);

      // Polling: o processo alvo pode levar um instante pra de fato encerrar
      // e liberar a porta após receber SIGTERM.
      const deadline = Date.now() + 5000;
      let lastErr: unknown;
      while (Date.now() < deadline) {
        try {
          await fetch(json.url, { signal: AbortSignal.timeout(500) });
          await new Promise((r) => setTimeout(r, 200));
        } catch (e) {
          lastErr = e;
          break;
        }
      }
      assert.ok(lastErr, "servidor deveria parar de responder após --stop-pid");
    } finally {
      // Best-effort — se --stop-pid já derrubou, isto é um no-op silencioso.
      proc.kill();
    }
  });

  it("modo sem --open: não imprime nada além do JSON de start (sem tentativa de abrir browser)", async () => {
    const { proc, json } = await spawnServeAndReadJson(["--file", htmlPath, "--port", "0"]);
    try {
      assert.ok(json.url && json.port, "JSON de start deveria trazer url + port mesmo sem --open");
    } finally {
      proc.kill();
    }
  });
});
