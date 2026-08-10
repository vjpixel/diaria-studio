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
 * Scopes necessários — LISTA NÃO-AUTORITATIVA. A fonte de verdade é o array
 * `SCOPES` abaixo, comentado entrada por entrada. Esta lista já ficou defasada
 * duas vezes (não citava `postmaster.domain` do #4539 nem
 * `postmaster.traffic.readonly` do #4704 — corrigido em 260806); trate-a como
 * resumo de leitura, não como inventário:
 *   - https://www.googleapis.com/auth/drive (Drive completo)
 *   - https://www.googleapis.com/auth/gmail.readonly (Gmail somente leitura)
 *   - https://www.googleapis.com/auth/gmail.labels (criar labels)
 *   - https://www.googleapis.com/auth/gmail.modify (criar labels)
 *   - https://www.googleapis.com/auth/webmasters (#1989 leitura: GSC / seo-pull;
 *     #4546 escrita: submeter sitemap dos subdomínios de curadoria)
 *   - https://www.googleapis.com/auth/postmaster.readonly (#4063: Gmail Postmaster
 *     Tools v1 — spamRate diário que alimenta o circuit breaker de spam da Rampa)
 *   - https://www.googleapis.com/auth/postmaster.domain (#4539: registrar/verificar
 *     domínio no Postmaster — `domains.create`/`:verify`, só existe na v2)
 *   - https://www.googleapis.com/auth/postmaster.traffic.readonly (#4704:
 *     `domainStats:query` da v2 — spam por CAMPANHA via FEEDBACK_LOOP_SPAM_RATE,
 *     que a v1 não expõe)
 *   - https://www.googleapis.com/auth/gmail.send (#4064: alarme de guardrail
 *     furado do ramp Clarice — `scripts/clarice-guardrail-alarm.ts` envia
 *     e-mail ao editor via `scripts/lib/gmail-send.ts`, chamada direta à Gmail
 *     API `users.messages.send` — nenhum script roda dentro de uma sessão
 *     Claude Code com o MCP Gmail conectado, então `create_draft`/MCP não
 *     serve aqui. `gmail.readonly`/`gmail.modify` (já concedidos acima) NÃO
 *     incluem enviar mensagens — precisa deste scope à parte.)
 */

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "node:child_process";
import { loadProjectEnv } from "./lib/env-loader.ts";

loadProjectEnv(); // #1219 — carrega .env antes de ler process.env.

const ROOT = resolve(import.meta.dirname, "..");
const CREDENTIALS_PATH = resolve(ROOT, "data", ".credentials.json");
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;

// A invariante "os 3 scopes de Postmaster SOMAM entre si, nenhum substitui o
// outro" é travada por `test/postmaster-register-domain-4539.test.ts` (o path
// citado aqui até 260806 era `test/oauth-scopes-4539.test.ts`, que nunca
// existiu — o comentário prometia uma garantia mecânica sem apontar pra ela),
// que lê ESTE ARQUIVO COMO TEXTO em vez de importar `SCOPES`. Importar não é opção:
// `main()` roda incondicionalmente no fim do módulo, então um import abriria
// o browser e subiria o servidor da porta 8765 dentro do CI.
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.modify", // para criar labels
  // #1989 (leitura): GSC Search Analytics + URL Inspection — `seo-pull.ts` e
  // `seo-index-check.ts`. #4546 (escrita): submeter os sitemaps próprios dos
  // Workers de curadoria via `PUT /sites/{site}/sitemaps/{feedpath}`, que o
  // `.readonly` recusa. O scope SEM sufixo é superset do `.readonly`, então
  // substitui em vez de somar — manter os dois só duplicaria o consentimento.
  // Trocar isto EXIGE re-rodar `oauth-setup.ts` e reaprovar no browser: o
  // token existente em `data/.credentials.json` foi emitido com o scope antigo
  // e não ganha escrita sozinho (falha só na hora do PUT, com 403).
  "https://www.googleapis.com/auth/webmasters",
  // #4063/#4154: Gmail Postmaster Tools. A Brevo só enxerga reclamações de
  // FBL e subconta o spam em ~50× (73% da base é Gmail, e o "marcar como
  // spam" do Gmail não passa por FBL). O breaker de spam da Rampa lê o
  // spamRate diário daqui (scripts/postmaster-spam-sync.ts). A API precisa
  // estar HABILITADA no projeto GCP deste OAuth client (console.cloud.google.com
  // → APIs → Gmail Postmaster Tools API → Ativar) além deste scope — as duas
  // coisas são independentes; faltar uma dá 403 SERVICE_DISABLED mesmo com o
  // scope concedido (achado #4154, 260730).
  "https://www.googleapis.com/auth/postmaster.readonly",
  // #4539: registrar um domínio novo no Postmaster (`domains.create`) exige a
  // API **v2** — a v1 que `postmaster-spam-sync.ts` usa é read-only
  // (`domains.get`/`domains.list`/`trafficStats`) e não tem método de criação.
  // A v2 pede `.../auth/postmaster` OU `.../auth/postmaster.domain`; usamos o
  // segundo (mais estreito — gestão de domínio, sem abrir o resto).
  //
  // SOMA ao `.readonly` acima, não substitui: diferente do par
  // `webmasters`/`webmasters.readonly` (bloco anterior), aqui os dois scopes
  // são eixos DIFERENTES (gestão de domínio vs. leitura de trafficStats), não
  // superset/subset — remover o `.readonly` quebraria o sync diário de
  // spamRate que alimenta o breaker da Rampa.
  //
  // Mesma armadilha do #4546 anotada no bloco `webmasters`: o token já emitido
  // em `data/.credentials.json` NÃO ganha este scope sozinho — sem re-rodar
  // este script e reaprovar no browser, a falha só aparece no POST, com 403.
  "https://www.googleapis.com/auth/postmaster.domain",
  // #4704: ler `trafficStats` pela API **v2** (`domainStats:query`), que a v1
  // não tem. É o que desbloqueia spam POR CAMPANHA — as métricas
  // `FEEDBACK_LOOP_ID`/`FEEDBACK_LOOP_SPAM_RATE` só existem na v2, e o
  // identificador vem do header `Feedback-ID` que a Brevo já manda
  // (`{conta}_{campanha}`). A v2 aceita `.../auth/postmaster` OU
  // `.../auth/postmaster.traffic.readonly`; usamos o segundo (mais estreito —
  // só leitura de estatística, sem abrir gestão de domínio nem usuários).
  //
  // SOMA aos dois de Postmaster acima, não substitui: `postmaster.readonly` é
  // o eixo da v1 (`trafficStats` por data, que o sync diário usa hoje),
  // `postmaster.domain` é gestão de domínio, e este é leitura de estatística
  // na v2 — três eixos distintos, nenhum superset do outro.
  //
  // Mesma armadilha dos blocos acima, confirmada AO VIVO em 260806: com o token
  // atual, `GET /v2/domains` responde 200 mas `POST /v2/{d}/domainStats:query`
  // devolve 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`. O token já emitido em
  // `data/.credentials.json` NÃO ganha este scope sozinho — exige re-rodar
  // este script e reaprovar no browser.
  "https://www.googleapis.com/auth/postmaster.traffic.readonly",
  // #4064: enviar o e-mail de alarme de guardrail furado do ramp Clarice
  // (`scripts/clarice-guardrail-alarm.ts`) via Gmail API direta — rodando fora
  // de uma sessão Claude Code (Task Scheduler), sem MCP Gmail disponível.
  "https://www.googleapis.com/auth/gmail.send",
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

  console.log("🔐 Google OAuth 2.0 Setup — diar.ia.br Studio\n");
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
    // #1973: stamp pra o health-check avisar antes do limite de 7d (app Testing).
    refresh_obtained_ms: Date.now(),
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
