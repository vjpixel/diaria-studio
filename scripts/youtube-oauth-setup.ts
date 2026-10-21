/**
 * youtube-oauth-setup.ts (#10659 — vídeo diário no @diariabr)
 *
 * OAuth one-shot (authorization code + redirect de loopback) da conta dona
 * do canal @diariabr, com escopos `youtube.upload` + `youtube.readonly`.
 * Rodar na máquina do editor (abre o navegador logado na conta Google).
 *
 * Lê do ambiente (Doppler → `.env`): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * (o mesmo client "Desktop app" do oauth-setup.ts).
 *
 * Antes de gravar, confirma via `channels.list?mine=true` que o canal
 * autorizado é o @diariabr — se não for, aborta sem gravar nada.
 *
 * Grava, SEM nunca imprimir valor, no Doppler e no `.env` local:
 *   YOUTUBE_REFRESH_TOKEN        refresh token (expira em 7 dias com o app em "Testing", #1973)
 *   YOUTUBE_CHANNEL_ID           id do canal autorizado
 *   YOUTUBE_REFRESH_OBTAINED_AT  ISO — base para alarme de expiração
 *
 * Uso:  npx tsx scripts/youtube-oauth-setup.ts
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { defaultDopplerSet, persistSecrets } from "./linkedin-personal-oauth.ts";
import {
  YOUTUBE_OAUTH_ENV,
  YOUTUBE_OAUTH_REDIRECT_PORT,
  YOUTUBE_OAUTH_REDIRECT_URI,
  buildYouTubeAuthUrl,
  checkAuthorizedChannel,
  explainYouTubeApiError,
  parseChannelsResponse,
} from "./lib/youtube-oauth.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSENT_TIMEOUT_MS = 15 * 60 * 1000;

function openBrowser(url: string): void {
  // Sem cmd.exe: o `&` da query string cortaria a URL.
  if (process.platform === "win32") {
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], { shell: false, stdio: "ignore", detached: true }).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

function waitForCode(authUrl: string, state: string): Promise<string> {
  return new Promise((resolveCode, reject) => {
    let timer: NodeJS.Timeout;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", YOUTUBE_OAUTH_REDIRECT_URI);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (url.pathname !== "/youtube/callback" || (!code && !error)) {
        res.writeHead(204, { Connection: "close" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8", Connection: "close" });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:3rem">` +
          (code ? "<h1>Pronto</h1><p>Pode fechar esta aba e voltar ao terminal.</p>" : "<h1>Falhou</h1><p>Veja o terminal.</p>") +
          `</body>`,
      );
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        server.close();
        server.closeIdleConnections();
        fn();
      };
      if (error) return finish(() => reject(new Error(`consentimento negado: ${error}`)));
      if (url.searchParams.get("state") !== state) {
        return finish(() => reject(new Error("state divergente — callback descartado por segurança")));
      }
      finish(() => resolveCode(code as string));
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === "EADDRINUSE" ? new Error(`porta ${YOUTUBE_OAUTH_REDIRECT_PORT} ocupada — feche a execução anterior`) : err);
    });
    server.listen(YOUTUBE_OAUTH_REDIRECT_PORT, "127.0.0.1", () => {
      console.log("Abra esta URL no navegador e escolha a conta/canal do @diariabr (deve abrir sozinha):\n");
      console.log(authUrl + "\n");
      openBrowser(authUrl);
      timer = setTimeout(() => {
        server.close();
        reject(new Error("timeout esperando o consentimento no navegador (15 min)"));
      }, CONSENT_TIMEOUT_MS);
    });
  });
}

async function exchangeCode(code: string, clientId: string, clientSecret: string): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: YOUTUBE_OAUTH_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`troca de código falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { access_token: string; refresh_token?: string };
}

async function main(): Promise<number> {
  loadProjectEnv(ROOT);
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) {
    console.error("✖ Faltam GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET no ambiente (Doppler → `npm run sync-env`).");
    return 1;
  }
  const state = randomBytes(16).toString("hex");
  const code = await waitForCode(buildYouTubeAuthUrl(clientId, state), state);
  const tokens = await exchangeCode(code, clientId, clientSecret);
  if (!tokens.refresh_token) {
    console.error("✖ O Google não devolveu refresh_token. Revogue o app em https://myaccount.google.com/permissions e rode de novo.");
    return 1;
  }

  const chRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const chBody = await chRes.text();
  if (!chRes.ok) {
    console.error(`✖ ${explainYouTubeApiError(chRes.status, chBody)}. Nada foi gravado.`);
    return 1;
  }
  const check = checkAuthorizedChannel(parseChannelsResponse(JSON.parse(chBody)));
  if (!check.ok) {
    console.error(`✖ ${check.reason}. Nada foi gravado.`);
    return 1;
  }

  const obtainedAt = new Date().toISOString();
  const r = persistSecrets({
    secrets: {
      [YOUTUBE_OAUTH_ENV.refreshToken]: tokens.refresh_token,
      [YOUTUBE_OAUTH_ENV.channelId]: check.channel.id,
      [YOUTUBE_OAUTH_ENV.obtainedAt]: obtainedAt,
    },
    dopplerSet: defaultDopplerSet,
    envPath: resolve(ROOT, ".env"),
    readEnv: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeEnv: (p, c) => writeFileAtomic(p, c),
  });
  console.log(`✔ Canal autorizado: ${check.channel.title} (${check.channel.customUrl}, ${check.channel.id}).`);
  console.log("✔ Refresh token gravado no .env local (valor nunca impresso).");
  console.log("⚠ Com o app OAuth em modo Testing (#1973), o refresh token expira em 7 dias.");
  if (r.dopplerFailed.length > 0) {
    console.error(`✖ Doppler NÃO recebeu: ${r.dopplerFailed.join(", ")}. Doppler disse: ${r.dopplerErrors.join(" | ") || "sem stderr"}`);
    return 2;
  }
  console.log(`✔ Doppler: ${r.doppler.join(", ")}. No 300: \`npm run sync-env\`.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  // #9911: exitCode, não process.exit — no Windows o exit logo após o fetch sai 127.
  runCli(main, { onError: (e) => console.error(`✖ ${(e as Error).message}`) });
}
