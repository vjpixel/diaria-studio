/**
 * serve-preview.ts (#3546)
 *
 * Servidor HTTP local efêmero (loopback-only) para o editor revisar o
 * preview HTML da newsletter/social ANTES do gate humano do Stage 4 —
 * substitui `scripts/upload-html-public.ts` (Worker Cloudflare) no caminho
 * de REVISÃO, tanto na diária (`orchestrator-stage-4.md` §4b) quanto no
 * mensal (`diaria-mensal/SKILL.md` Etapa 4). Elimina consumo de cota
 * Workers KV e dependência de rede pra uma etapa puramente local.
 *
 * NÃO usar no caminho de PUBLICAÇÃO real (Etapa 5) — esse continua subindo
 * pro Beehiiv/Worker via `upload-html-public.ts`, que fica intacto.
 *
 * Uso (CLI):
 *   npx tsx scripts/serve-preview.ts --file <path/para/preview.html> [--port N] [--open] \
 *     [--persist-to <json> --field <nome>]
 *   npx tsx scripts/serve-preview.ts --stop-pid <PID>   # teardown (#3546)
 *
 * `--port` omitido ou `0` = porta efêmera OS-assigned (evita colisão entre
 * edições/sessões concorrentes). `--open` tenta abrir o browser default do
 * SO (mesmo padrão de `scripts/oauth-setup.ts`) — só em modo `local`
 * (`scripts/lib/exec-mode.ts`); em `cloud` (container efêmero, sem editor
 * sentado no terminal) o arquivo é servido/logado mas a abertura é pulada.
 * `--persist-to`/`--field` gravam a URL (e o PID, campo `{field}_pid`) num
 * JSON dedicado — mesmo mecanismo de `upload-html-public.ts` (#1734),
 * reusado via `persistFieldToJsonFile`. `--stop-pid <PID>` encerra um
 * servidor iniciado anteriormente (teardown pós-gate).
 *
 * O servidor serve o DIRETÓRIO que contém `--file` (não só o arquivo) —
 * funciona tanto com a variante preferida `*-embedded.html` (imagens em
 * `data:` URI, standalone, sem asset externo) quanto com HTML que referencie
 * outros arquivos relativos no mesmo diretório.
 *
 * Teardown: SIGINT/SIGTERM fecha o servidor antes de sair (processo roda em
 * foreground/background até o caller matá-lo — o orchestrator dispara via
 * `run_in_background` e derruba o processo ao fim do gate).
 *
 * Programmatic (usado por testes e por outros scripts):
 *   import { startPreviewServer } from "./serve-preview.ts";
 *   const server = await startPreviewServer({ filePath: "...", port: 0 });
 *   // server.url, server.port
 *   await server.close();
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename, join, extname, normalize, sep } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
// Reusa o mecanismo de persist-to já testado de upload-html-public.ts
// (#1734) em vez de duplicar a lógica de merge JSON aqui — mesmo padrão que
// esse script usa pra gravar `{campo}_url` em `04-newsletter-url.json`/
// `05-social-preview.json` (só que agora com uma URL loopback, não Worker).
import { persistFieldToJsonFile } from "./upload-html-public.ts";

// #3546: SEMPRE loopback — nunca 0.0.0.0, nunca exposto na rede local.
const HOST = "127.0.0.1";

const EXT_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function mimeFor(path: string): string {
  return EXT_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface PreviewServerOptions {
  /** Path (absoluto ou relativo ao cwd) do HTML a servir. */
  filePath: string;
  /** Porta fixa; omitida ou `0` = porta efêmera OS-assigned. */
  port?: number;
}

export interface PreviewServer {
  /** URL completa pro arquivo servido (ex: http://127.0.0.1:54321/preview.html). */
  url: string;
  port: number;
  filePath: string;
  /** Fecha o servidor — idempotente, seguro chamar múltiplas vezes. */
  close: () => Promise<void>;
}

/**
 * Sobe um servidor HTTP efêmero, loopback-only, servindo o diretório que
 * contém `filePath`. Path traversal bloqueado: qualquer request resolvendo
 * fora do diretório-raiz retorna 403.
 */
export async function startPreviewServer(
  opts: PreviewServerOptions,
): Promise<PreviewServer> {
  const filePath = resolve(opts.filePath);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`[serve-preview] arquivo não encontrado: ${filePath}`);
  }
  const rootDir = dirname(filePath);
  const fileName = basename(filePath);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const relPath = urlPath === "/" ? fileName : urlPath.replace(/^\/+/, "");
      const resolved = normalize(join(rootDir, relPath));
      // Guard de path traversal: `resolved` precisa estar DENTRO de rootDir —
      // normalize sozinho não bloqueia um "../../etc" que escapa do diretório.
      if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const body = readFileSync(resolved);
      res.writeHead(200, {
        "Content-Type": mimeFor(resolved),
        "Content-Length": body.length,
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Internal error: ${(e as Error).message}`);
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, HOST, () => resolvePromise());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  const url = `http://${HOST}:${port}/${encodeURIComponent(fileName)}`;

  let closed = false;
  return {
    url,
    port,
    filePath,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        if (closed) {
          resolveClose();
          return;
        }
        closed = true;
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}

/**
 * Best-effort: abre `url` no browser default do SO — mesmo padrão de
 * `scripts/oauth-setup.ts` (`openBrowser`). Usado só em modo `local`
 * (caller decide via `detectExecMode`); nunca chamado em `cloud`.
 */
export function openInBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

/**
 * `--stop-pid <PID>`: teardown do servidor de preview a partir do PID gravado
 * no start (#3546 critério de aceite — "teardown do servidor local após o
 * gate"). `process.kill` é cross-platform no Node (mapeia pra TerminateProcess
 * no Windows via libuv) — mais confiável que `kill`/`taskkill` via Bash tool,
 * que varia entre Git Bash e cmd.exe. Idempotente: PID já morto = warn, não
 * fatal (o orchestrator pode chamar isso mais de uma vez em paths de retry).
 */
function stopByPid(pidArg: string): void {
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`[serve-preview] --stop-pid inválido: ${pidArg}`);
    process.exitCode = 2;
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(JSON.stringify({ stopped: pid }, null, 2));
  } catch (e) {
    console.error(`[serve-preview] WARN: falha ao encerrar PID ${pid}: ${(e as Error).message}`);
    // Não fatal — processo já morto/pid inexistente não deve travar o caller.
  }
}

async function main(): Promise<void> {
  const { values, flags } = parseCliArgs(process.argv.slice(2));

  const stopPid = values["stop-pid"];
  if (stopPid) {
    stopByPid(stopPid);
    return;
  }

  const file = values["file"];
  if (!file) {
    console.error(
      "Uso: serve-preview.ts --file <path.html> [--port N] [--open] [--persist-to <json> --field <nome>]\n" +
        "     serve-preview.ts --stop-pid <PID>",
    );
    process.exit(2);
  }
  const portArg = values["port"] !== undefined ? Number(values["port"]) : 0;
  if (Number.isNaN(portArg) || portArg < 0) {
    console.error(`[serve-preview] --port inválido: ${values["port"]}`);
    process.exit(2);
  }

  const server = await startPreviewServer({ filePath: file, port: portArg });

  console.log(
    JSON.stringify(
      { url: server.url, port: server.port, file: server.filePath, pid: process.pid },
      null,
      2,
    ),
  );

  // #1734/#3546: --persist-to grava a URL (e o PID, pra teardown posterior)
  // num JSON dedicado — mesmo padrão de upload-html-public.ts, só que a URL
  // agora é loopback em vez de Worker-hosted.
  const persistTo = values["persist-to"];
  const persistField = values["field"] ?? "url";
  if (persistTo) {
    try {
      const persistPath = resolve(persistTo);
      persistFieldToJsonFile(persistPath, persistField, server.url);
      persistFieldToJsonFile(persistPath, `${persistField}_pid`, String(process.pid));
    } catch (e) {
      console.error(
        `[serve-preview] WARN: servidor OK mas persist falhou (${(e as Error).message}). ` +
          `URL não registrada em ${persistTo}, mas está live: ${server.url}`,
      );
    }
  }

  if (flags.has("open")) {
    const mode = detectExecMode();
    if (mode === "local") {
      openInBrowser(server.url);
    } else {
      console.error(
        "[serve-preview] --open ignorado: sessão cloud (sem editor/Chrome local) — arquivo servido, não aberto.",
      );
    }
  }

  // Teardown gracioso (#3546 critério de aceite): SIGINT/SIGTERM fecha o
  // servidor antes de sair. O processo fica vivo até o caller derrubá-lo —
  // orchestrator dispara via `run_in_background` e mata ao fim do gate.
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[serve-preview] ${(e as Error).message}`);
    process.exit(1);
  });
}
