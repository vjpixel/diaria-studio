/**
 * scripts/google-ads-associate-token.ts (#5262)
 *
 * Fecha o pré-requisito escondido da verificação de marca: associar o
 * developer token da Google Ads API ao projeto Google Cloud. Ver
 * scripts/lib/google-ads-associate.ts para o racional (a chamada PODE falhar
 * e ainda assim associar) e docs/google-ads-api-setup.md para o contexto.
 *
 * Dois modos:
 *
 *   npx tsx scripts/google-ads-associate-token.ts --auth
 *     Roda o consentimento OAuth uma única vez, num servidor de loopback
 *     local, e grava o refresh token DIRETO no Doppler. O valor nunca é
 *     impresso — decisão deliberada: um segredo impresso vaza pro scrollback
 *     do terminal, pro log da sessão e pra qualquer transcript.
 *
 *   npx tsx scripts/google-ads-associate-token.ts
 *     Faz UMA chamada à API e classifica o resultado. Com o token no nível
 *     "Conta de teste", o esperado é DEVELOPER_TOKEN_NOT_APPROVED — e isso é
 *     SUCESSO (exit 0), porque a associação já aconteceu.
 *
 * Requer no ambiente (via `doppler run --` ou `.env`):
 *   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN
 *   GOOGLE_ADS_REFRESH_TOKEN (produzido pelo --auth)
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID (MCC), GOOGLE_ADS_CUSTOMER_ID (anunciante)
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  classifyAssociationResponse,
  buildAssociationRequest,
  normalizeCustomerId,
} from "./lib/google-ads-associate.ts";

const SCOPE = "https://www.googleapis.com/auth/adwords";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const LOOPBACK_PORT = 8787;
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}`;

/** Versão da API. Sobrescrevível — o Google publica versão nova a cada ~3 meses. */
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? "v21";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ Falta ${name} no ambiente.`);
    console.error("  Rode via Doppler:  doppler run -- npx tsx scripts/google-ads-associate-token.ts");
    process.exit(1);
  }
  return value;
}

/**
 * Grava o refresh token no Doppler sem passar pelo stdout. Se o CLI do
 * Doppler não estiver disponível, o script FALHA em vez de imprimir o valor
 * como plano B — imprimir seria a saída fácil e a errada.
 */
function saveRefreshTokenToDoppler(refreshToken: string): void {
  const result = spawnSync(
    "doppler",
    ["secrets", "set", "GOOGLE_ADS_REFRESH_TOKEN", "--silent"],
    { input: refreshToken, encoding: "utf8", shell: process.platform === "win32" },
  );

  if (result.error || result.status !== 0) {
    console.error("✖ Não consegui gravar no Doppler.");
    console.error(`  ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
    console.error("");
    console.error("  O refresh token NÃO foi impresso de propósito (segredo não vai pro terminal).");
    console.error("  Instale/autentique o CLI (`doppler login`) e rode o --auth de novo.");
    process.exit(1);
  }

  console.log("✔ GOOGLE_ADS_REFRESH_TOKEN gravado no Doppler (valor nunca impresso).");
}

async function runConsentFlow(): Promise<void> {
  const clientId = required("GOOGLE_ADS_CLIENT_ID");
  const clientSecret = required("GOOGLE_ADS_CLIENT_SECRET");
  const state = randomBytes(16).toString("hex");

  const authUrl =
    `${AUTH_ENDPOINT}?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
    `&access_type=offline&prompt=consent&state=${state}`;

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      const received = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const receivedState = url.searchParams.get("state");

      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:3rem">` +
          (received
            ? "<h1>Pronto</h1><p>Pode fechar esta aba e voltar ao terminal.</p>"
            : `<h1>Falhou</h1><p>${error ?? "sem código"}</p>`) +
          `</body>`,
      );
      server.close();

      if (error) return reject(new Error(`consentimento negado: ${error}`));
      // Guarda contra um request forjado chegando no loopback durante a janela
      // em que o servidor está aberto.
      if (receivedState !== state) return reject(new Error("state divergente — requisição ignorada"));
      if (!received) return reject(new Error("callback sem parâmetro `code`"));
      resolve(received);
    });

    server.listen(LOOPBACK_PORT, "127.0.0.1", () => {
      console.log("Abra esta URL no navegador (deve abrir sozinha):\n");
      console.log(authUrl + "\n");
      const opener =
        process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [authUrl], { shell: true, stdio: "ignore", detached: true }).unref();
    });
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const payload = (await res.json()) as { refresh_token?: string; error_description?: string };
  if (!res.ok || !payload.refresh_token) {
    console.error(`✖ Troca do código falhou: ${payload.error_description ?? res.status}`);
    process.exit(1);
  }

  saveRefreshTokenToDoppler(payload.refresh_token);
}

async function accessTokenFromRefresh(): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required("GOOGLE_ADS_CLIENT_ID"),
      client_secret: required("GOOGLE_ADS_CLIENT_SECRET"),
      refresh_token: required("GOOGLE_ADS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });

  const payload = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !payload.access_token) {
    console.error(`✖ Não consegui renovar o access token: ${payload.error_description ?? res.status}`);
    console.error("  Se o refresh token ainda não existe, rode antes:  --auth");
    process.exit(1);
  }
  return payload.access_token;
}

async function associate(): Promise<void> {
  const accessToken = await accessTokenFromRefresh();
  const { url, body } = buildAssociationRequest({
    apiVersion: API_VERSION,
    customerId: normalizeCustomerId(required("GOOGLE_ADS_CUSTOMER_ID")),
    loginCustomerId: normalizeCustomerId(required("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),
  });

  console.log(`→ ${API_VERSION} · POST googleAds:searchStream`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": required("GOOGLE_ADS_DEVELOPER_TOKEN"),
      "login-customer-id": normalizeCustomerId(required("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),
      "Content-Type": "application/json",
    },
    body,
  });

  const text = await res.text();
  const outcome = classifyAssociationResponse(res.status, text);

  console.log("");
  if (outcome.kind === "associated") {
    console.log(`✔ Token associado ao projeto — ${outcome.reason}`);
    console.log("");
    console.log("  Nada mais a fazer aqui. O próximo marco é a fila do Basic Access.");
    process.exit(0);
  }

  console.error(`✖ Associação não confirmada — ${outcome.reason}`);
  console.error("");
  console.error("  Resposta bruta (primeiros 600 caracteres):");
  console.error("  " + text.slice(0, 600).replace(/\n/g, "\n  "));
  process.exit(1);
}

const wantsAuth = process.argv.includes("--auth");
await (wantsAuth ? runConsentFlow() : associate());
