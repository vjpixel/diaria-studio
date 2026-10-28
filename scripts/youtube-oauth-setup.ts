/**
 * youtube-oauth-setup.ts (#10659 — vídeo diário no @diariabr)
 *
 * OAuth one-shot (authorization code + redirect de loopback) da conta dona
 * do canal @diariabr, com escopos `youtube.upload` + `youtube.readonly` +
 * `youtube.force-ssl` (este desde #11384, para o `captions.insert` da legenda
 * SRT: token gerado antes não envia legenda — rodar o setup de novo uma vez).
 * Rodar na máquina do editor (abre o navegador logado na conta Google).
 *
 * Lê do ambiente (Doppler → `.env`): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * (o mesmo client "Desktop app" do oauth-setup.ts).
 *
 * Antes de gravar, confirma via `channels.list?mine=true` que o canal
 * autorizado é o @diariabr — se não for, aborta sem gravar nada. A regra de
 * "não grava" mora em `decidePersist` (`scripts/lib/youtube-oauth.ts`,
 * testada caso a caso, #10786).
 *
 * Grava, SEM nunca imprimir valor, no Doppler e no `.env` local:
 *   YOUTUBE_REFRESH_TOKEN        refresh token (app OAuth em produção desde 22/10/2026, #10785: não vence em 7 dias)
 *   YOUTUBE_CHANNEL_ID           id do canal autorizado
 *   YOUTUBE_REFRESH_OBTAINED_AT  ISO — quando o token foi gerado (informativo)
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
import { defaultDopplerSet, persistSecrets } from "./lib/secret-persist.ts";
import {
  YOUTUBE_OAUTH_ENV,
  YOUTUBE_OAUTH_REDIRECT_PORT,
  YOUTUBE_OAUTH_REDIRECT_URI,
  buildYouTubeAuthUrl,
  classifyCallback,
  decidePersist,
  missingOptionalScopes,
  type YouTubeTokenResponse,
} from "./lib/youtube-oauth.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSENT_TIMEOUT_MS = 15 * 60 * 1000;
const HTTP_TIMEOUT_MS = 30_000;

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
      const outcome = classifyCallback(new URL(req.url ?? "/", YOUTUBE_OAUTH_REDIRECT_URI), state);
      if (outcome.kind === "ignore") {
        res.writeHead(204, { Connection: "close" });
        res.end();
        return;
      }
      if (outcome.kind === "bad-state") {
        // #10786: descarta e continua esperando o callback legítimo.
        res.writeHead(400, { "Content-Type": "text/plain;charset=utf-8", Connection: "close" });
        res.end("state divergente: callback descartado");
        console.error("⚠ Callback com state divergente descartado; seguindo à espera do consentimento.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8", Connection: "close" });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:3rem">` +
          (outcome.kind === "code" ? "<h1>Pronto</h1><p>Pode fechar esta aba e voltar ao terminal.</p>" : "<h1>Falhou</h1><p>Veja o terminal.</p>") +
          `</body>`,
      );
      clearTimeout(timer);
      server.close();
      server.closeIdleConnections();
      if (outcome.kind === "denied") {
        reject(new Error(`consentimento negado: ${outcome.error} ${outcome.description}`.trim()));
        return;
      }
      resolveCode(outcome.code);
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
        server.closeIdleConnections();
        reject(new Error("timeout esperando o consentimento no navegador (15 min)"));
      }, CONSENT_TIMEOUT_MS);
    });
  });
}

async function exchangeCode(code: string, clientId: string, clientSecret: string): Promise<YouTubeTokenResponse> {
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
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`troca de código falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as YouTubeTokenResponse;
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
  // Sem refresh token não adianta consultar o canal: decidePersist recusa antes.
  let channelsStatus = 0;
  let channelsBody = "";
  if (tokens.refresh_token) {
    const chRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    channelsStatus = chRes.status;
    channelsBody = await chRes.text();
  }
  const decision = decidePersist({ tokens, channelsStatus, channelsBody });
  if (!decision.persist) {
    console.error(`✖ ${decision.reason}. Nada foi gravado.`);
    return 1;
  }

  const obtainedAt = new Date().toISOString();
  const r = persistSecrets({
    secrets: {
      [YOUTUBE_OAUTH_ENV.refreshToken]: decision.refreshToken,
      [YOUTUBE_OAUTH_ENV.channelId]: decision.channel.id,
      [YOUTUBE_OAUTH_ENV.obtainedAt]: obtainedAt,
    },
    dopplerSet: defaultDopplerSet,
    envPath: resolve(ROOT, ".env"),
    readEnv: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeEnv: (p, c) => writeFileAtomic(p, c),
  });
  const ch = decision.channel;
  console.log(`✔ Canal autorizado: ${ch.title} (${ch.customUrl}, ${ch.id}).`);
  const optionalMissing = missingOptionalScopes(tokens.scope);
  if (optionalMissing.length > 0) {
    console.error(
      `⚠ O consentimento não concedeu ${optionalMissing.join(", ")}: o vídeo sobe, mas a legenda SRT não (#11384). ` +
        "Rode o setup de novo deixando todos os escopos marcados.",
    );
  }
  // #10786: o resultado do Doppler vem antes do ".env gravado" — a ordem
  // inversa parecia sucesso logo antes da falha (exit 2).
  if (r.dopplerFailed.length > 0) {
    console.error(`✖ Doppler NÃO recebeu: ${r.dopplerFailed.join(", ")}. Doppler disse: ${r.dopplerErrors.join(" | ") || "sem stderr"}`);
    console.error("  O refresh token ficou só no .env local (valor nunca impresso); o 300 não o vê até subir pro vault.");
    return 2;
  }
  console.log(`✔ Doppler: ${r.doppler.join(", ")}. No 300: \`npm run sync-env\`.`);
  console.log("✔ Refresh token gravado também no .env local (valor nunca impresso).");
  return 0;
}

if (isMainModule(import.meta.url)) {
  // #9911: exitCode, não process.exit — no Windows o exit logo após o fetch sai 127.
  runCli(main, { onError: (e) => console.error(`✖ ${(e as Error).message}`) });
}
