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
 *   npx tsx scripts/serve-preview.ts --file <path/para/preview.html> [--port N] [--open] [--watch] \
 *     [--persist-to <json> --field <nome>]
 *   npx tsx scripts/serve-preview.ts --stop-pid <PID>   # teardown (#3546)
 *
 * `--watch` (#8123 Fatia 1) — fallback quando o Studio /revisao não está
 * rodando: observa o diretório servido e injeta live-reload (SSE em
 * `GET /__live-reload`) na resposta HTML principal — qualquer processo que
 * reescreva o arquivo servido dispara o reload no browser, sem re-render
 * próprio (mesmo princípio "conteúdo, não código" de `review-file-watch.ts`,
 * usado pelo Studio). Sem `--watch`, comportamento idêntico ao pré-#8123.
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
import { readFileSync, existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { resolve, dirname, basename, join, extname, normalize, sep } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
// Reusa o mecanismo de persist-to já testado de upload-html-public.ts
// (#1734) em vez de duplicar a lógica de merge JSON aqui — mesmo padrão que
// esse script usa pra gravar `{campo}_url` em `04-newsletter-url.json`/
// `05-social-preview.json` (só que agora com uma URL loopback, não Worker).
import { persistFieldToJsonFile } from "./upload-html-public.ts";
import { logEvent } from "./lib/run-log.ts";

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
  /** #8123 Fatia 1 (fallback quando o Studio /revisao não está rodando):
   * observa o diretório servido (mesmo `rootDir` de `filePath`) e injeta
   * live-reload via SSE (`GET /__live-reload`) na resposta HTML principal —
   * qualquer script externo que re-renderize o arquivo (ex: re-rodar o
   * comando que gerou `preview.html`) dispara o reload no browser sem ação
   * manual. NÃO re-renderiza nada por conta própria — só reflete o que já
   * está em disco, mesmo princípio "conteúdo, não código" do watcher do
   * Studio (`review-file-watch.ts`). */
  watch?: boolean;
  /** Debounce (ms) do watcher — coalesce um burst de writes numa única
   * notificação de reload. Default 300ms, mesmo valor da issue #8123. */
  watchDebounceMs?: number;
  /** Edição (AAMMDD) a atribuir às medições de reload do watcher. Só
   *  etiqueta o log — ausente, a medição ainda é gravada (com `edition:
   *  null`), porque o número que interessa (edição→preview) não depende de
   *  saber QUAL edição era. */
  edition?: string | null;
  /** Só pra teste: aponta o run-log pra um tmpdir isolado, mesmo parâmetro
   *  que `logEvent` já expõe. Em produção nunca é passado. */
  timingLogRootDir?: string;
}

/**
 * Grava um ciclo de reload do watcher no run-log (#8123 residual).
 *
 * ## Por que aqui, e não numa instrução de playbook
 *
 * A Fatia 5 entregou `log-stage4-adjust-timing.ts`, que depende do
 * orchestrator lembrar de capturar 3 timestamps à mão e chamar o CLI ao
 * fim de cada ajuste. Medido em produção: a revisão de Stage 4 da edição
 * 260918 teve ajustes (o HTML final mudou entre o snapshot pré-gate e a
 * aprovação, registrado em `_internal/editor-requests.jsonl`) e o run-log
 * saiu com ZERO medições. A instrução vive em §4d.1, que é exatamente a
 * seção que o fast path da Fatia 2 manda **não reler** ("sem reler esta
 * seção do zero") — instrumentação que depende de lembrar, dentro do
 * trecho cujo objetivo é não ser lido.
 *
 * Este log não depende de ninguém lembrar: o watcher já sabe a hora em que
 * o arquivo mudou e a hora em que empurrou o reload. É precisamente a
 * perna "edição no disco → preview na tela" que a issue define como livre
 * de modelo — e a que a meta de ~10s mede.
 *
 * Fica de fora, por construção, a perna "pedido do editor → edição no
 * disco": essa só o orchestrator conhece, e continua com o CLI da Fatia 5.
 *
 * Best-effort absoluto: qualquer erro é engolido. Medir não pode atrasar
 * nem quebrar o reload que está sendo medido.
 */
function logPreviewReloadCycle(entry: {
  fileChangedAt: number;
  servedAt: number;
  clients: number;
  edition: string | null;
  rootDir?: string;
}): void {
  try {
    const elapsedMs = entry.servedAt - entry.fileChangedAt;
    logEvent(
      {
        edition: entry.edition,
        stage: 4,
        agent: "serve-preview",
        level: elapsedMs <= 10_000 ? "info" : "warn",
        message: "preview local: ciclo de reload do watcher",
        details: {
          file_changed_at: new Date(entry.fileChangedAt).toISOString(),
          preview_served_at: new Date(entry.servedAt).toISOString(),
          edit_to_preview_ms: elapsedMs,
          within_target_10s: elapsedMs <= 10_000,
          // 0 clientes = ninguém com a aba aberta. A medição continua
          // válida como tempo de servidor, mas não como tempo até o editor
          // VER — por isso o número fica registrado em vez de inferido.
          clients_notified: entry.clients,
        },
      },
      entry.rootDir ?? process.cwd(),
    );
  } catch {
    // Instrumentação nunca derruba o que instrumenta.
  }
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

  // #8123 Fatia 1: script injetado na resposta HTML quando `opts.watch` está
  // ligado — abre uma conexão SSE em /__live-reload e recarrega a página
  // assim que o servidor notificar uma mudança em disco. Sem efeito nenhum
  // quando `opts.watch` é falso (comportamento pré-#8123 inalterado).
  const LIVE_RELOAD_SNIPPET =
    '<script>(function(){try{var s=new EventSource("/__live-reload");' +
    "s.onmessage=function(){location.reload();};}catch(e){}})();</script>";

  const liveReloadClients = new Set<ServerResponse>();
  let fileWatcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  if (opts.watch) {
    const debounceMs = opts.watchDebounceMs ?? 300;
    // #8123 residual: instante da PRIMEIRA mudança de arquivo da rajada
    // atual. É o começo da perna "edição no disco → preview na tela" — a
    // única que a issue diz que sai do modelo por completo, e portanto a
    // única que pode ser medida sem depender de alguém lembrar de medir.
    let burstStartedAt: number | null = null;
    const notifyClients = () => {
      const servedAt = Date.now();
      let delivered = 0;
      for (const client of liveReloadClients) {
        try {
          client.write("data: reload\n\n");
          delivered++;
        } catch {
          // cliente já desconectou — 'close' abaixo já remove do Set.
        }
      }
      if (burstStartedAt != null) {
        logPreviewReloadCycle({
          fileChangedAt: burstStartedAt,
          servedAt,
          clients: delivered,
          edition: opts.edition ?? null,
          rootDir: opts.timingLogRootDir,
        });
        burstStartedAt = null;
      }
    };
    const scheduleNotify = () => {
      burstStartedAt ??= Date.now();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        notifyClients();
      }, debounceMs);
      debounceTimer.unref?.();
    };
    try {
      fileWatcher = watch(rootDir, { recursive: true }, () => scheduleNotify());
      fileWatcher.on("error", () => {
        // best-effort — sem watcher, o preview simplesmente não auto-recarrega;
        // refresh manual do browser continua funcionando normalmente.
      });
    } catch {
      // plataforma sem suporte a recursive watch — sem live-reload, degrada
      // pro comportamento pré-#8123 (refresh manual).
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      if (opts.watch && urlPath === "/__live-reload") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        liveReloadClients.add(res);
        req.on("close", () => liveReloadClients.delete(res));
        return;
      }
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
      const contentType = mimeFor(resolved);
      // #8123 Fatia 1: injeta o snippet de live-reload só nas respostas HTML
      // quando --watch está ligado — outros tipos (imagem, CSS) servidos sem
      // alteração, e sem `opts.watch` o comportamento é idêntico ao anterior.
      if (opts.watch && contentType.startsWith("text/html")) {
        const html = readFileSync(resolved, "utf8");
        const withSnippet = html.includes("</body>")
          ? html.replace("</body>", `${LIVE_RELOAD_SNIPPET}</body>`)
          : html + LIVE_RELOAD_SNIPPET;
        const body = Buffer.from(withSnippet, "utf8");
        res.writeHead(200, { "Content-Type": contentType, "Content-Length": body.length });
        res.end(body);
        return;
      }
      const body = readFileSync(resolved);
      res.writeHead(200, {
        "Content-Type": contentType,
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
        // #8123 Fatia 1: conexões SSE de /__live-reload ficam abertas
        // indefinidamente por design — sem encerrá-las aqui, `server.close()`
        // nunca chamaria o callback (aguarda TODAS as conexões fecharem).
        if (debounceTimer) clearTimeout(debounceTimer);
        try {
          fileWatcher?.close();
        } catch {
          // no-op
        }
        for (const client of liveReloadClients) {
          try {
            client.end();
          } catch {
            // no-op
          }
        }
        liveReloadClients.clear();
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}

/**
 * Best-effort: abre `url` no browser default do SO — mesmo padrão de
 * `scripts/oauth-setup.ts` (`openBrowser`). Usado só em modo `local`
 * (caller decide via `detectExecMode`); nunca chamado em `cloud`.
 *
 * `execImpl` é um seam injetável (#3902) — default é o `exec` real do
 * `node:child_process`, nenhum call site de produção muda. Testes passam um
 * stub pra nunca abrir um browser de verdade durante a suíte.
 */
export function openInBrowser(url: string, execImpl: typeof exec = exec): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  execImpl(cmd);
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
      "Uso: serve-preview.ts --file <path.html> [--port N] [--open] [--watch] [--persist-to <json> --field <nome>]\n" +
        "     serve-preview.ts --stop-pid <PID>",
    );
    process.exit(2);
  }
  const portArg = values["port"] !== undefined ? Number(values["port"]) : 0;
  if (Number.isNaN(portArg) || portArg < 0) {
    console.error(`[serve-preview] --port inválido: ${values["port"]}`);
    process.exit(2);
  }
  // #8123 Fatia 1: fallback de preview ao vivo quando o Studio /revisao não
  // está rodando — mesmo watcher+debounce+SSE, sem re-renderizar nada por
  // conta própria (só reflete o que outro processo já escreveu em disco).
  const watchFlag = flags.has("watch");

  // `--edition` só etiqueta as medições de reload do watcher no run-log
  // (#8123 residual). Sem ela a medição continua sendo gravada — o tempo
  // edição→preview não depende de saber qual edição era.
  const server = await startPreviewServer({
    filePath: file,
    port: portArg,
    watch: watchFlag,
    edition: values["edition"] ?? null,
  });

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
