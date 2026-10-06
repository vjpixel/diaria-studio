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
 *   [--detach | --ensure] [--idle-exit-min N] [--ttl-min N]   # #9678 / #9700
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
 * `--detach` (#9678) — sobe o servidor num processo DESANEXADO do chamador
 * (`spawn(..., { detached: true })` = `setsid` no Linux, novo grupo de
 * processo no Windows; stdio redirecionado pra um log em `os.tmpdir()`) e
 * SAI assim que o filho imprimir a URL. Motivo: no Stage 4 o servidor subia
 * como background task do harness (`run_in_background: true`), e o harness
 * mata essas tasks no teto de tempo (2h no máximo) — num gate longo os links
 * `127.0.0.1` morriam com o editor ainda revisando (edição 261006). Com
 * `--detach` o comando retorna em segundos e o servidor não pertence à
 * árvore de processos da task; o teardown continua sendo `--stop-pid`, com o
 * PID do FILHO (é ele que grava `{field}_pid` no `--persist-to`).
 *
 * `--ensure` (#9678) — re-servir sob demanda, idempotente: se o
 * `--persist-to`/`--field` já aponta pra um servidor vivo (PID existe E a URL
 * responde 200), só imprime o JSON dele (`reused: true`) e sai; senão sobe um
 * novo, desanexado, como `--detach`. É o comando a rodar antes de reapresentar
 * o gate, ou quando o editor diz que o link não abre.
 *
 * O servidor serve o DIRETÓRIO que contém `--file` (não só o arquivo) —
 * funciona tanto com a variante preferida `*-embedded.html` (imagens em
 * `data:` URI, standalone, sem asset externo) quanto com HTML que referencie
 * outros arquivos relativos no mesmo diretório.
 *
 * Teardown: SIGINT/SIGTERM fecha o servidor antes de sair (processo roda em
 * foreground/background até o caller matá-lo — o orchestrator dispara via
 * `--detach` e derruba o processo ao fim do gate com `--stop-pid`).
 *
 * Endurecimento contra órfãos (#9700):
 *   - `--stop-pid` valida a linha de comando do PID antes de sinalizar — só
 *     mata se for um `serve-preview` (PID reaproveitado pelo SO depois que o
 *     servidor morreu nunca é atingido). "É um serve-preview" = processo
 *     node/tsx cujo SCRIPT (1º argumento posicional) é `serve-preview.ts` —
 *     nunca substring solta (#9705: `tail -f diaria-serve-preview-*.log` ou
 *     `node --test test/serve-preview-*.test.ts` passavam). Linha de comando
 *     ilegível = NÃO sinaliza (#9705; antes sinalizava sem validar);
 *   - `--ensure` com PID vivo mas URL muda: SIGTERM no PID antigo (com a mesma
 *     validação) ANTES de subir o novo — senão o antigo ficava órfão, fora do
 *     alcance de `--stop-pid` (o persist passa a apontar pro novo);
 *   - `--detach` cujo filho não grava o ready-file a tempo: o pai mata o
 *     `child.pid` antes de lançar, em vez de deixá-lo vivo;
 *   - `--idle-exit-min N` / `--ttl-min N` (0 = desligado): o servidor sai
 *     sozinho após N minutos sem request e sem aba conectada no live-reload,
 *     ou após N minutos de vida. Filho de `--detach`/`--ensure` recebe por
 *     default `DETACHED_DEFAULT_IDLE_EXIT_MIN`/`DETACHED_DEFAULT_TTL_MIN` —
 *     se o teardown nunca rodar (sessão caiu, abort), o processo não vive até
 *     o reboot. `--ensure` re-serve sob demanda se o editor ainda precisar.
 *     Teto: `MAX_LIFETIME_MIN` (limite de 2^31-1 ms do `setTimeout`) — acima
 *     disso o timer dispararia em ~1 ms, então o valor é rejeitado (#9705).
 *
 * Programmatic (usado por testes e por outros scripts):
 *   import { startPreviewServer } from "./serve-preview.ts";
 *   const server = await startPreviewServer({ filePath: "...", port: 0 });
 *   // server.url, server.port
 *   await server.close();
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exec, execFileSync, spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  statSync,
  watch,
  openSync,
  closeSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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

/** Maior delay que `setTimeout` honra (2^31-1 ms); acima, o Node usa 1 ms. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** #9705: teto de `--idle-exit-min`/`--ttl-min` (~35.791 min ≈ 24,8 dias). */
export const MAX_LIFETIME_MIN = Math.floor(MAX_TIMEOUT_MS / 60_000);

/**
 * Pure (#9705): valida o valor de `--idle-exit-min`/`--ttl-min`. Ausente = 0
 * (desligado). Negativo, não numérico ou acima de `MAX_LIFETIME_MIN` = erro —
 * rejeitado em vez de truncado, pra quem pediu "nunca morrer" saber que o
 * pedido não foi atendido (0 é o "desligado").
 */
export function parseLifetimeMinutes(
  key: string,
  raw: string | undefined,
): { ok: true; minutes: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, minutes: 0 };
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
    return { ok: false, error: `--${key} inválido: ${raw}` };
  }
  if (n > MAX_LIFETIME_MIN) {
    return {
      ok: false,
      error: `--${key} ${raw} acima do teto de ${MAX_LIFETIME_MIN} min (limite do setTimeout) — use 0 para desligar`,
    };
  }
  return { ok: true, minutes: n };
}

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
  /** #9700: chama `onIdle` depois de `idleExitMs` sem nenhuma request E sem
   *  cliente SSE conectado (aba aberta com live-reload conta como em uso).
   *  Ausente ou `0` = nunca. */
  idleExitMs?: number;
  onIdle?: () => void;
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
/** mtime em ms do arquivo, ou `null` se ele não existe / não dá pra ler.
 *  `null` nunca conta como "mudou" — na dúvida, não medir é melhor que medir
 *  errado. */
function safeMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

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
    // mtime do ARQUIVO SERVIDO na última notificação. O watcher observa o
    // diretório inteiro de propósito (Fatia 1 — asset relativo também deve
    // disparar reload), mas MEDIR o diretório inteiro seria outra coisa: o
    // `_internal/` recebe escrita que nada tem a ver com o preview
    // (`04-newsletter-url.json` do próprio `--persist-to`, segundos depois do
    // start; `stage4-post-edit-checks.json`; `editor-requests.jsonl`;
    // cascade-status). Cada uma dessas geraria uma amostra "rapidíssima" que
    // entraria na mediana como se fosse latência de ajuste — medição
    // contaminada com aparência de correta, exatamente a classe de falha que
    // este trabalho existe pra fechar (#8313 review, achado 1).
    let lastServedMtimeMs = safeMtimeMs(filePath);
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
      // Reload sempre acontece (pode ter sido asset); a MEDIÇÃO só quando o
      // arquivo servido em si mudou.
      const mtimeNow = safeMtimeMs(filePath);
      const servedFileChanged = mtimeNow != null && mtimeNow !== lastServedMtimeMs;
      if (mtimeNow != null) lastServedMtimeMs = mtimeNow;
      if (burstStartedAt != null && servedFileChanged) {
        logPreviewReloadCycle({
          fileChangedAt: burstStartedAt,
          servedAt,
          clients: delivered,
          edition: opts.edition ?? null,
          rootDir: opts.timingLogRootDir,
        });
      }
      burstStartedAt = null;
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

  // #9700: idle-exit — o timer rearma a cada request; ao disparar com aba
  // conectada no live-reload, só rearma (a aba aberta é uso, não ociosidade).
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // #9705: acima de 2^31-1 ms o Node troca o delay por 1 ms — o servidor
  // sairia logo após subir. O CLI já rejeita; aqui o teto protege o caller
  // programático.
  const idleExitMs = Math.min(opts.idleExitMs ?? 0, MAX_TIMEOUT_MS);
  const armIdle = () => {
    if (!(idleExitMs > 0) || !opts.onIdle) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (liveReloadClients.size > 0) {
        armIdle();
        return;
      }
      opts.onIdle?.();
    }, idleExitMs);
    idleTimer.unref?.();
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    armIdle();
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
  armIdle();

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
        if (idleTimer) clearTimeout(idleTimer);
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
  const r = stopPreviewPid(pid);
  if (r.outcome === "stopped") {
    console.log(JSON.stringify({ stopped: pid }, null, 2));
  } else if (r.outcome === "unverifiable") {
    // #9705: sem linha de comando não há como provar que o PID é nosso —
    // recusa. No Linux/macOS isso quase sempre = processo já morto; no
    // Windows pode ser PowerShell lento/indisponível, e aí o idle-exit/TTL
    // do próprio servidor é a rede de segurança.
    console.error(
      `[serve-preview] WARN: linha de comando do PID ${pid} ilegível (processo morto, ou leitura indisponível) — NÃO sinalizado (#9705)`,
    );
    console.log(JSON.stringify({ skipped: pid, reason: "unverifiable" }, null, 2));
  } else if (r.outcome === "not-serve-preview") {
    // #9700: PID reaproveitado — o servidor já morreu e o SO deu o número a
    // outro processo. Nunca sinalizar; não fatal (teardown é best-effort).
    console.error(
      `[serve-preview] WARN: PID ${pid} não é um serve-preview (PID reaproveitado?) — NÃO sinalizado. cmdline: ${r.cmdline.slice(0, 200)}`,
    );
    console.log(JSON.stringify({ skipped: pid, reason: "not-serve-preview" }, null, 2));
  } else {
    console.error(`[serve-preview] WARN: falha ao encerrar PID ${pid}: ${r.error}`);
    // Não fatal — processo já morto/pid inexistente não deve travar o caller.
  }
}

/** Nome do script que identifica um servidor nosso (basename do 1º argumento
 *  posicional de um processo node/tsx — ver `isServePreviewCmdline`). */
export const SERVE_PREVIEW_SCRIPT_BASENAME = "serve-preview.ts";

/** Flags do node que consomem o PRÓXIMO argumento como valor (sem `=`). */
const NODE_VALUE_FLAGS = new Set([
  "--require",
  "-r",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--env-file-if-exists",
  "--conditions",
  "-C",
  "--input-type",
  "--title",
  "--inspect-port",
  "--debug-port",
  "--stack-trace-limit",
  "--max-old-space-size",
  "--max-semi-space-size",
  "--openssl-config",
  "--icu-data-dir",
  "--redirect-warnings",
  "--report-dir",
  "--report-directory",
  "--report-filename",
  "--diagnostic-dir",
  "--secure-heap",
  "--secure-heap-min",
  "--disable-warning",
  "--watch-path",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-name-pattern",
  "--test-skip-pattern",
]);

/** Flags em que o node NÃO roda script (código inline / modo especial). */
const NODE_NO_SCRIPT_FLAGS = new Set(["-e", "--eval", "-p", "--print", "--test", "-i", "--interactive", "-c", "--check"]);

/**
 * Pure: quebra uma linha de comando em tokens respeitando aspas duplas (o
 * formato do Windows `CommandLine` e o que `readProcessCmdline` monta no
 * Linux pra argumento com espaço). Não implementa as regras completas de
 * barra invertida do Windows — basta pra achar argv0 e o script; um caso
 * exótico mal tokenizado vira "não reconhecido" (fail-closed: não mata).
 */
export function tokenizeCmdline(cmdline: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let has = false;
  for (const ch of cmdline) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      has = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function pathBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Pure (#9705): a linha de comando é de um serve-preview? Exige (1) argv0 ser
 * node/tsx (com ou sem `.exe`/`.cmd`, com ou sem sufixo de versão) e (2) o
 * SCRIPT — 1º argumento posicional depois das flags do node — ter basename
 * `serve-preview.ts`. Substring solta não basta: o log/ready-file do
 * `--detach` se chamam `diaria-serve-preview-*`, e um `tail -f`, `grep` ou
 * `node --test test/serve-preview-*.test.ts` com PID reaproveitado passaria.
 */
export function isServePreviewCmdline(cmdline: string): boolean {
  const tokens = tokenizeCmdline(cmdline);
  if (tokens.length < 2) return false;
  const exe = pathBasename(tokens[0]).toLowerCase().replace(/\.(exe|cmd)$/, "");
  if (!/^(node|nodejs|tsx)[\d.]*$/.test(exe)) return false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      const next = tokens[i + 1];
      return next !== undefined && pathBasename(next) === SERVE_PREVIEW_SCRIPT_BASENAME;
    }
    if (t.startsWith("-")) {
      const flag = t.split("=", 1)[0];
      if (NODE_NO_SCRIPT_FLAGS.has(flag)) return false;
      if (!t.includes("=") && NODE_VALUE_FLAGS.has(flag)) i++;
      continue;
    }
    // 1º posicional = o script. Qualquer outro token (valor de `--file`,
    // argumento do script) nunca conta.
    return pathBasename(t) === SERVE_PREVIEW_SCRIPT_BASENAME;
  }
  return false;
}

/**
 * Linha de comando do PID, ou `null` se não der pra ler (processo morto,
 * plataforma sem o mecanismo, permissão). Linux: `/proc/{pid}/cmdline`;
 * macOS/BSD: `ps -p`; Windows: PowerShell `Win32_Process`. Nunca lança.
 */
export function readProcessCmdline(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      // Argumento com espaço vai entre aspas, pra `tokenizeCmdline` remontar
      // o argv exato (o `/proc` separa por NUL, sem ambiguidade).
      return (
        raw
          .split("\0")
          .filter((a) => a !== "")
          .map((a) => (/\s/.test(a) ? `"${a}"` : a))
          .join(" ")
          .trim() || null
      );
    }
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      return out.trim() || null;
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export type StopPreviewOutcome =
  | { outcome: "stopped"; cmdline: string }
  | { outcome: "not-serve-preview"; cmdline: string }
  | { outcome: "unverifiable" }
  | { outcome: "error"; error: string };

/**
 * #9700/#9705: SIGTERM no PID só se ele for comprovadamente um serve-preview
 * (`isServePreviewCmdline`). Linha de comando de outro processo = PID
 * reaproveitado → não sinaliza. Linha de comando ilegível (`null`) → também
 * NÃO sinaliza (#9705): até o #9705 sinalizava sem validar, e no Windows
 * (`TerminateProcess`, PowerShell lento/ausente) isso atingia um processo
 * alheio que tivesse herdado o PID. Vale pro `--stop-pid` e pro reap
 * automático do `--ensure` (este sem pedido humano, por isso mais grave).
 */
export function stopPreviewPid(
  pid: number,
  deps: {
    readCmdline?: (pid: number) => string | null;
    kill?: (pid: number, sig: NodeJS.Signals) => void;
  } = {},
): StopPreviewOutcome {
  const readCmdline = deps.readCmdline ?? readProcessCmdline;
  const kill = deps.kill ?? ((p: number, sig: NodeJS.Signals) => void process.kill(p, sig));
  const cmdline = readCmdline(pid);
  if (cmdline === null) return { outcome: "unverifiable" };
  if (!isServePreviewCmdline(cmdline)) {
    return { outcome: "not-serve-preview", cmdline };
  }
  try {
    kill(pid, "SIGTERM");
    return { outcome: "stopped", cmdline };
  } catch (e) {
    return { outcome: "error", error: (e as Error).message };
  }
}

// ── #9678: servidor desanexado do harness + re-serve sob demanda ──────────

/** Flags que só fazem sentido no processo PAI (o que desanexa) — nunca são
 *  repassadas ao filho, senão o filho desanexaria de novo, em loop. */
const PARENT_ONLY_FLAGS = new Set(["--detach", "--ensure"]);

/**
 * Pure: argv do processo FILHO a partir do argv do pai — remove
 * `--detach`/`--ensure` e qualquer `--ready-file` herdado, e acrescenta o
 * `--ready-file` novo (onde o filho grava o JSON de start assim que bindar).
 */
export function buildDetachedChildArgs(argv: string[], readyFile: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (PARENT_ONLY_FLAGS.has(a)) continue;
    if (a === "--ready-file") {
      i++; // descarta o valor também
      continue;
    }
    if (a.startsWith("--ready-file=")) continue;
    out.push(a);
  }
  out.push("--ready-file", readyFile);
  return out;
}

/** `true` se existe um processo com esse PID (sinal 0 não mata nada).
 *  EPERM = existe, mas é de outro usuário — conta como vivo. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `true` se a URL responde 200 dentro do timeout. Qualquer erro = `false`. */
export async function probePreviewUrl(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // Drena o corpo pra não deixar o socket pendurado.
    await res.arrayBuffer().catch(() => undefined);
    return res.status === 200;
  } catch {
    return false;
  }
}

export interface PersistedPreview {
  url: string;
  pid: number;
}

/** Lê `{field}` + `{field}_pid` do JSON de persist. `null` se faltar algo. */
export function readPersistedPreview(persistPath: string, field: string): PersistedPreview | null {
  try {
    const j = JSON.parse(readFileSync(persistPath, "utf8")) as Record<string, unknown>;
    const url = j[field];
    const pid = Number(j[`${field}_pid`]);
    if (typeof url !== "string" || !url || !Number.isInteger(pid) || pid <= 0) return null;
    return { url, pid };
  } catch {
    return null;
  }
}

/**
 * Servidor persistido ainda vivo? PID vivo E URL respondendo — os dois,
 * porque PID reaproveitado pelo SO (outro processo qualquer) responderia ao
 * sinal 0 sem servir nada, e URL respondendo com PID morto seria outro
 * servidor na mesma porta (improvável com porta efêmera, mas não impossível).
 */
export async function findLivePersistedPreview(
  persistPath: string,
  field: string,
  probe: (url: string) => Promise<boolean> = probePreviewUrl,
): Promise<PersistedPreview | null> {
  const p = readPersistedPreview(persistPath, field);
  if (!p) return null;
  if (!isPidAlive(p.pid)) return null;
  if (!(await probe(p.url))) return null;
  return p;
}

/**
 * #9700: `--ensure` achou o servidor persistido NÃO vivo. Se o PID ainda
 * existe (processo vivo mas a URL não responde — travado, ou probe que estourou
 * o timeout), encerra-o (validando que é um serve-preview) ANTES de subir o
 * novo: o persist vai passar a apontar pro novo, e o antigo ficaria órfão,
 * fora do alcance de qualquer `--stop-pid`. Devolve o PID sinalizado, ou
 * `null` se não havia nada a encerrar, o PID não era nosso, ou a linha de
 * comando não pôde ser lida (#9705: reap automático nunca mata às cegas).
 */
export function reapUnresponsivePersisted(
  persistPath: string,
  field: string,
  deps: { isAlive?: (pid: number) => boolean; stop?: (pid: number) => StopPreviewOutcome } = {},
): number | null {
  const p = readPersistedPreview(persistPath, field);
  if (!p) return null;
  if (!(deps.isAlive ?? isPidAlive)(p.pid)) return null;
  const r = (deps.stop ?? stopPreviewPid)(p.pid);
  return r.outcome === "stopped" ? p.pid : null;
}

/** Espera o filho gravar o JSON de start no `readyFile`. */
export async function waitForReadyFile(
  readyFile: string,
  timeoutMs = 20_000,
  pollMs = 100,
): Promise<{ url: string; port: number; file: string; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(readyFile)) {
      try {
        return JSON.parse(readFileSync(readyFile, "utf8"));
      } catch {
        // escrita ainda em curso (o filho grava via rename atômico, mas
        // tolera-se mesmo assim) — tenta de novo no próximo poll.
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`[serve-preview] filho desanexado não ficou pronto em ${timeoutMs}ms (${readyFile})`);
}

/** Idade a partir da qual um log `diaria-serve-preview-*.log` é podado. */
export const DETACHED_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remove logs de servidores desanexados mais velhos que `maxAgeMs` (self-review
 * #4 do PR #9685 — sem isso acumulam um por `--detach`, edição após edição).
 * Fail-soft: qualquer erro (dir ilegível, arquivo aberto no Windows) é ignorado
 * — a poda é higiene, nunca motivo pra não subir o preview. Devolve quantos
 * arquivos removeu.
 */
export function pruneOldDetachedLogs(dir: string, maxAgeMs = DETACHED_LOG_MAX_AGE_MS, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^diaria-serve-preview-.+\.log$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        rmSync(path, { force: true });
        removed++;
      }
    } catch {
      // arquivo sumiu/está aberto — segue
    }
  }
  return removed;
}

/**
 * Sobe `serve-preview.ts` como processo desanexado e devolve o JSON de start
 * do FILHO. Usa o mesmo binário Node + os mesmos `execArgv` do pai (o
 * `--import tsx` de `npx tsx` vive ali), e o path real deste módulo.
 */
/** #9700: defaults de vida do filho desanexado (minutos) — injetados quando o
 *  chamador não passa `--idle-exit-min`/`--ttl-min`. Ociosidade só conta sem
 *  aba conectada no live-reload; o TTL é o teto absoluto (gate passando de 2
 *  dias é anomalia, e `--ensure` re-serve sob demanda). */
export const DETACHED_DEFAULT_IDLE_EXIT_MIN = 12 * 60;
export const DETACHED_DEFAULT_TTL_MIN = 48 * 60;

/** Pure: acrescenta os defaults de vida ao argv do filho, sem sobrescrever o
 *  que o chamador já passou (nas duas sintaxes, `--x N` e `--x=N`). */
export function withDetachedLifetimeDefaults(childArgs: string[]): string[] {
  const has = (flag: string) => childArgs.some((a) => a === flag || a.startsWith(`${flag}=`));
  const out = [...childArgs];
  if (!has("--idle-exit-min")) out.push("--idle-exit-min", String(DETACHED_DEFAULT_IDLE_EXIT_MIN));
  if (!has("--ttl-min")) out.push("--ttl-min", String(DETACHED_DEFAULT_TTL_MIN));
  return out;
}

export interface SpawnDetachedOptions {
  /** Timeout do ready-file (default 20s, o de `waitForReadyFile`). */
  readyTimeoutMs?: number;
  /** Só pra teste: script a rodar no filho no lugar deste módulo. */
  childScript?: string;
}

export async function spawnDetachedPreview(
  argv: string[],
  opts: SpawnDetachedOptions = {},
): Promise<{
  url: string;
  port: number;
  file: string;
  pid: number;
  log: string;
}> {
  const stamp = `${process.pid}-${Date.now()}`;
  const readyFile = join(tmpdir(), `diaria-serve-preview-${stamp}.ready.json`);
  // Log FORA do diretório servido de propósito: o watcher (`--watch`) observa
  // o diretório do arquivo recursivamente, e um log escrito ali dispararia
  // reload no browser a cada linha.
  const log = join(tmpdir(), `diaria-serve-preview-${stamp}.log`);
  pruneOldDetachedLogs(tmpdir());
  const fd = openSync(log, "a");
  let exitWatch: ReturnType<typeof setInterval> | undefined;
  let childPid: number | undefined;
  let exitedEarly: number | null = null;
  try {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        opts.childScript ?? fileURLToPath(import.meta.url),
        ...withDetachedLifetimeDefaults(buildDetachedChildArgs(argv, readyFile)),
      ],
      { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, cwd: process.cwd() },
    );
    childPid = child.pid;
    child.unref();
    child.once("exit", (code) => {
      exitedEarly = code ?? -1;
    });
    const json = await Promise.race([
      waitForReadyFile(readyFile, opts.readyTimeoutMs),
      new Promise<never>((_, reject) => {
        exitWatch = setInterval(() => {
          if (exitedEarly !== null) {
            reject(
              new Error(`[serve-preview] filho desanexado saiu com código ${exitedEarly} antes de servir — ver ${log}`),
            );
          }
        }, 100);
        exitWatch.unref();
      }),
    ]);
    return { ...json, log };
  } catch (e) {
    // #9700: filho que não ficou pronto a tempo continua vivo (desanexado,
    // fora da árvore do chamador) — matar antes de lançar, senão cada
    // `--detach` repetido deixa um órfão. É o PID que ACABAMOS de spawnar,
    // então dispensa a validação de linha de comando do `--stop-pid`.
    if (childPid && exitedEarly === null) {
      try {
        process.kill(childPid, "SIGTERM");
      } catch {
        // já morreu entre o timeout e aqui
      }
    }
    throw e;
  } finally {
    // Limpa o vigia de saída precoce nos dois desfechos (ready-file venceu ou
    // o filho morreu antes) — self-review #5 do PR #9685.
    if (exitWatch) clearInterval(exitWatch);
    closeSync(fd);
    rmSync(readyFile, { force: true });
  }
}

/** Grava o JSON de start no ready-file via tmp + rename (o pai nunca lê meio arquivo). */
function writeReadyFile(readyFile: string, payload: unknown): void {
  const tmp = `${readyFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, readyFile);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values, flags } = parseCliArgs(argv);

  const stopPid = values["stop-pid"];
  if (stopPid) {
    stopByPid(stopPid);
    return;
  }

  // #9700/#9705: tempo de vida — `--idle-exit-min`/`--ttl-min` (0/ausente =
  // nunca). Validado ANTES do --detach/--ensure: no pai, o erro sai na hora
  // e claro, em vez de "filho saiu com código 2 antes de servir".
  const lifetime = (key: string): number => {
    const r = parseLifetimeMinutes(key, values[key]);
    if (!r.ok) {
      console.error(`[serve-preview] ${r.error}`);
      process.exit(2);
    }
    return r.minutes;
  };
  const idleExitMin = lifetime("idle-exit-min");
  const ttlMin = lifetime("ttl-min");

  // #9678: --ensure reusa um servidor persistido ainda vivo; senão cai no
  // mesmo caminho do --detach.
  if (flags.has("ensure")) {
    const persistTo = values["persist-to"];
    if (!persistTo || !values["file"]) {
      console.error("[serve-preview] --ensure exige --file e --persist-to (é lá que o servidor vivo é procurado)");
      process.exit(2);
    }
    const field = values["field"] ?? "url";
    const live = await findLivePersistedPreview(resolve(persistTo), field);
    if (live) {
      console.log(JSON.stringify({ url: live.url, pid: live.pid, reused: true }, null, 2));
      return;
    }
    // #9700: PID vivo sem resposta → encerra antes de sobrescrever o persist.
    const reaped = reapUnresponsivePersisted(resolve(persistTo), field);
    if (reaped !== null) {
      console.error(`[serve-preview] --ensure: PID ${reaped} vivo mas sem resposta — encerrado antes de re-servir (#9700)`);
    }
  }
  if (flags.has("detach") || flags.has("ensure")) {
    if (!values["file"]) {
      console.error("[serve-preview] --detach exige --file");
      process.exit(2);
    }
    const child = await spawnDetachedPreview(argv);
    console.log(JSON.stringify({ ...child, detached: true, reused: false }, null, 2));
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

  let selfExitReason: string | null = null;
  let shutdownImpl: () => void = () => process.exit(0);
  const exitFor = (reason: string) => {
    if (selfExitReason) return;
    selfExitReason = reason;
    console.error(`[serve-preview] encerrando sozinho: ${reason} (#9700)`);
    shutdownImpl();
  };

  // `--edition` só etiqueta as medições de reload do watcher no run-log
  // (#8123 residual). Sem ela a medição continua sendo gravada — o tempo
  // edição→preview não depende de saber qual edição era.
  const server = await startPreviewServer({
    filePath: file,
    port: portArg,
    watch: watchFlag,
    edition: values["edition"] ?? null,
    idleExitMs: idleExitMin * 60_000,
    onIdle: () => exitFor(`${idleExitMin} min sem request e sem aba conectada`),
  });
  if (ttlMin > 0) {
    setTimeout(() => exitFor(`TTL de ${ttlMin} min atingido`), ttlMin * 60_000).unref();
  }

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

  // #9678: filho de um --detach — sinaliza o pai DEPOIS do persist, pra que o
  // `{field}_pid` já esteja gravado quando o pai devolver o controle.
  const readyFile = values["ready-file"];
  if (readyFile) {
    try {
      writeReadyFile(resolve(readyFile), {
        url: server.url,
        port: server.port,
        file: server.filePath,
        pid: process.pid,
      });
    } catch (e) {
      console.error(`[serve-preview] WARN: falha ao gravar --ready-file: ${(e as Error).message}`);
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
  shutdownImpl = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[serve-preview] ${(e as Error).message}`);
    process.exit(1);
  });
}
