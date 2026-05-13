/**
 * oauth-setup.ts
 *
 * Setup único de OAuth 2.0 para as APIs do Google (Drive + Gmail).
 * Abre o browser para o fluxo de consentimento e salva os tokens em
 * `data/.credentials.json`.
 *
 * Pré-requisitos:
 *   1. Crie um projeto no Google Cloud Console (console.cloud.google.com).
 *   2. Ative as APIs: Google Drive API + Gmail API.
 *   3. Crie credenciais OAuth 2.0 → "Desktop app".
 *   4. Baixe o JSON e exporte as variáveis de ambiente:
 *        $env:GOOGLE_CLIENT_ID="..."
 *        $env:GOOGLE_CLIENT_SECRET="..."
 *      Ou adicione ao seu .env local (não commitado).
 *   5. Execute: npx tsx scripts/oauth-setup.ts
 *
 * O script salva os tokens em `data/.credentials.json` (gitignored).
 * Após o setup, drive-sync.ts e inbox-drain.ts usam esses tokens automaticamente.
 *
 * Scopes necessários:
 *   - https://www.googleapis.com/auth/drive (Drive completo)
 *   - https://www.googleapis.com/auth/gmail.readonly (Gmail somente leitura)
 *   - https://www.googleapis.com/auth/gmail.labels (criar labels)
 */

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "node:child_process";
import { loadProjectEnv } from "./lib/env-loader.ts";

loadProjectEnv(); // #1219 — carrega .env/.env.local antes de ler process.env.

const ROOT = resolve(import.meta.dirname, "..");
const CREDENTIALS_PATH = resolve(ROOT, "data", ".credentials.json");
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.modify", // para criar labels
];

function buildAuthUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // garante que refresh_token seja retornado
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function openBrowser(url: string): void {
  // Detecta OS e abre o browser
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Troca de código falhou (${res.status}): ${body}`);
  }

  return res.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>;
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "❌ Variáveis de ambiente faltando:\n" +
        "   $env:GOOGLE_CLIENT_ID='...'\n" +
        "   $env:GOOGLE_CLIENT_SECRET='...'\n\n" +
        "Crie credenciais em: https://console.cloud.google.com/apis/credentials"
    );
    process.exit(1);
  }

  console.log("🔐 Google OAuth 2.0 Setup — Diar.ia Studio\n");
  console.log("Abrindo browser para autorização...");

  const authUrl = buildAuthUrl(clientId);
  console.log(`URL de auth:\n  ${authUrl}\n`);
  openBrowser(authUrl);

  // Servidor local para capturar o callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h2>❌ Erro: ${error}</h2><p>Feche esta janela e tente novamente.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      const authCode = url.searchParams.get("code");
      if (!authCode) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h2>❌ Código não encontrado</h2>`);
        server.close();
        reject(new Error("No code in callback"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;max-width:500px;margin:50px auto;text-align:center">
          <h2>✅ Autorização concluída!</h2>
          <p>Pode fechar esta janela e voltar ao terminal.</p>
        </body></html>
      `);
      server.close();
      resolve(authCode);
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(
        `Aguardando callback na porta ${REDIRECT_PORT}...\n` +
          "(Se o browser não abriu, cole a URL acima manualmente)\n"
      );
    });

    server.on("error", reject);
    // Timeout de 5 minutos
    setTimeout(() => {
      server.close();
      reject(new Error("Timeout aguardando autorização (5 min)"));
    }, 300_000);
  });

  console.log("✅ Código recebido. Trocando por tokens...");
  const tokens = await exchangeCode(code, clientId, clientSecret);

  if (!tokens.refresh_token) {
    console.error(
      "❌ refresh_token não retornado pelo Google.\n" +
        "Acesse https://myaccount.google.com/permissions, revogue o acesso ao app,\n" +
        "e rode o setup novamente (o parâmetro prompt=consent força o refresh_token)."
    );
    process.exit(1);
  }

  // Garantir que data/ existe
  const dataDir = resolve(ROOT, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const credentials = {
    client_id: clientId,
    client_secret: clientSecret,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_ms: Date.now() + tokens.expires_in * 1000,
  };

  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), "utf8");
  console.log(`\n✅ Tokens salvos em ${CREDENTIALS_PATH}`);
  console.log("\nSetup concluído! Próximos passos:");
  console.log("  • drive-sync.ts e inbox-drain.ts agora funcionam automaticamente.");
  console.log("  • Para testar: npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/YYMMDD/ --stage 0 --files ''");
}

main().catch((err) => {
  console.error("❌ Erro no setup:", err.message);
  process.exit(1);
});
