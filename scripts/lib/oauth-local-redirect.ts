/**
 * oauth-local-redirect.ts (#12172)
 *
 * Servidor de callback local do OAuth (authorization code + redirect para
 * `http://localhost:{porta}{path}`) e abertura do navegador, compartilhados
 * por `scripts/linkedin-personal-oauth.ts` e `scripts/linkedin-page-oauth.ts`.
 * Antes eram duas cópias que só mudavam porta, path e mensagem, e divergiram:
 * a do perfil pessoal escrevia "Pronto" no navegador antes de comparar o
 * `state`, então um callback rejeitado aparecia como sucesso.
 *
 * `classifyOAuthCallback` decide (puro) o que fazer com cada requisição; a
 * página HTML sai da MESMA decisão que resolve ou rejeita a promessa, então
 * "Pronto" só aparece quando o código vai de fato ser usado.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";

/** Resultado de uma requisição no servidor de callback. */
export type OAuthCallbackOutcome =
  | { kind: "ignore" } // outro path, favicon, ou sem `code`/`error`: 204, segue esperando
  | { kind: "code"; code: string }
  | { kind: "error"; message: string };

/**
 * Classifica a requisição recebida. Ordem: path/parâmetros → `error` do
 * provedor → `state` → `code`. `state` divergente rejeita mesmo com `code`.
 */
export function classifyOAuthCallback(url: URL, expectedPath: string, expectedState: string): OAuthCallbackOutcome {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (url.pathname !== expectedPath || (!code && !error)) return { kind: "ignore" };
  if (error) {
    return { kind: "error", message: `consentimento negado: ${error} ${url.searchParams.get("error_description") ?? ""}`.trimEnd() };
  }
  if (url.searchParams.get("state") !== expectedState) {
    return { kind: "error", message: "state divergente — callback descartado por segurança" };
  }
  return { kind: "code", code: code as string };
}

/** Página mostrada no navegador. "Pronto" só quando o código foi aceito. */
export function renderOAuthCallbackPage(ok: boolean): string {
  return (
    `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:3rem">` +
    (ok ? "<h1>Pronto</h1><p>Pode fechar esta aba e voltar ao terminal.</p>" : "<h1>Falhou</h1><p>Veja o terminal.</p>") +
    `</body>`
  );
}

/** Abre a URL no navegador padrão. */
export function openBrowser(url: string, spawnFn: typeof spawn = spawn): void {
  // Sem cmd.exe: o `&` da query string cortaria a URL (mesmo racional de
  // google-ads-associate-token.ts).
  if (process.platform === "win32") {
    spawnFn("rundll32", ["url.dll,FileProtocolHandler", url], { shell: false, stdio: "ignore", detached: true }).unref();
  } else {
    spawnFn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

export interface WaitForCodeOptions {
  authUrl: string;
  state: string;
  /** Porta do redirect cadastrado no app (0 = efêmera, só em teste). */
  port: number;
  /** Path do redirect cadastrado no app, ex. `/linkedin/callback`. */
  path: string;
  /** Linha impressa antes da URL (qual conta logar no navegador). */
  prompt: string;
  timeoutMs?: number;
  /** Abre a URL; default `openBrowser`. Teste injeta no-op. */
  open?: (url: string) => void;
  log?: (line: string) => void;
  /** Chamado com a porta real depois do `listen` (teste usa com `port: 0`). */
  onListening?: (port: number) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Sobe o servidor em 127.0.0.1, imprime e abre a URL de consentimento, e
 * resolve com o `code` do primeiro callback válido. Rejeita em `error` do
 * provedor, `state` divergente, porta ocupada ou timeout.
 */
export function waitForCode(opts: WaitForCodeOptions): Promise<string> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const open = opts.open ?? openBrowser;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolveCode, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const server = createServer((req, res) => {
      const outcome = classifyOAuthCallback(new URL(req.url ?? "/", "http://localhost"), opts.path, opts.state);
      if (outcome.kind === "ignore" || settled) {
        res.writeHead(204);
        res.end();
        return;
      }
      settled = true;
      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8", Connection: "close" });
      res.end(renderOAuthCallbackPage(outcome.kind === "code"));
      clearTimeout(timer);
      server.close();
      if (outcome.kind === "code") resolveCode(outcome.code);
      else reject(new Error(outcome.message));
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settled = true;
      reject(err.code === "EADDRINUSE" ? new Error(`porta ${opts.port} ocupada — feche a execução anterior`) : err);
    });
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      const realPort = typeof addr === "object" && addr ? addr.port : opts.port;
      log(`${opts.prompt}\n`);
      log(opts.authUrl + "\n");
      open(opts.authUrl);
      timer = setTimeout(() => {
        settled = true;
        server.close();
        reject(new Error("timeout esperando o consentimento no navegador"));
      }, timeoutMs);
      opts.onListening?.(realPort);
    });
  });
}
