/**
 * linkedin-personal-oauth.ts (#9568 — LinkedIn PESSOAL automatizado)
 *
 * OAuth one-shot (authorization code + redirect local) do app LinkedIn
 * PESSOAL — o app separado com "Share on LinkedIn" + "Sign In with LinkedIn
 * using OpenID Connect", nunca o app da página (77tlvy0623oq84). Rodar na
 * máquina do editor (abre o navegador logado na conta pessoal).
 *
 * Lê do ambiente (Doppler → `.env`):
 *   LINKEDIN_PERSONAL_CLIENT_ID, LINKEDIN_PERSONAL_CLIENT_SECRET
 *
 * Grava, SEM nunca imprimir valor:
 *   LINKEDIN_PERSONAL_ACCESS_TOKEN      token `w_member_social` (60 dias, sem refresh)
 *   LINKEDIN_PERSONAL_PERSON_URN        urn:li:person:{sub} (via /v2/userinfo)
 *   LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT  ISO — lido pelo alarme de expiração
 * no Doppler (fonte da verdade, é de lá que o `300` puxa via `npm run
 * sync-env`) e no `.env` local (pra valer já nesta máquina).
 *
 * Redirect URL a cadastrar no app (aba Auth → "Authorized redirect URLs"):
 *   http://localhost:8766/linkedin/callback
 *
 * Uso:  npx tsx scripts/linkedin-personal-oauth.ts
 * Re-rodar a cada ~60 dias (o alarme `Diaria-LinkedIn-Personal` avisa 14 dias antes).
 * Passo a passo completo: docs/linkedin-personal-setup.md
 */

import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { defaultDopplerSet, persistSecrets } from "./lib/secret-persist.ts";
import { waitForCode } from "./lib/oauth-local-redirect.ts";
import {
  LINKEDIN_PERSONAL_ENV,
  LINKEDIN_PERSONAL_REDIRECT_PATH,
  LINKEDIN_PERSONAL_REDIRECT_PORT,
  buildAuthorizeUrl,
  computeExpiresAt,
  exchangeCodeForToken,
  fetchPersonUrn,
} from "./lib/linkedin-personal.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

async function main(): Promise<number> {
  loadProjectEnv(ROOT);
  const clientId = (process.env[LINKEDIN_PERSONAL_ENV.clientId] ?? "").trim();
  const clientSecret = (process.env[LINKEDIN_PERSONAL_ENV.clientSecret] ?? "").trim();
  if (!clientId || !clientSecret) {
    console.error(
      `✖ Faltam ${LINKEDIN_PERSONAL_ENV.clientId}/${LINKEDIN_PERSONAL_ENV.clientSecret} no ambiente.\n` +
        "  Crie o app (docs/linkedin-personal-setup.md), grave os dois no Doppler e rode `npm run sync-env`.",
    );
    return 1;
  }
  const state = randomBytes(16).toString("hex");
  const code = await waitForCode({
    authUrl: buildAuthorizeUrl(clientId, state),
    state,
    port: LINKEDIN_PERSONAL_REDIRECT_PORT,
    path: LINKEDIN_PERSONAL_REDIRECT_PATH,
    prompt: "Abra esta URL no navegador logado na sua conta PESSOAL do LinkedIn (deve abrir sozinha):",
    timeoutMs: CONSENT_TIMEOUT_MS,
  });
  const token = await exchangeCodeForToken(fetch, { code, clientId, clientSecret });
  const personUrn = await fetchPersonUrn(fetch, token.accessToken);
  const expiresAt = computeExpiresAt(new Date(), token.expiresInSec).toISOString();

  const r = persistSecrets({
    secrets: {
      [LINKEDIN_PERSONAL_ENV.accessToken]: token.accessToken,
      [LINKEDIN_PERSONAL_ENV.personUrn]: personUrn,
      [LINKEDIN_PERSONAL_ENV.expiresAt]: expiresAt,
    },
    dopplerSet: defaultDopplerSet,
    envPath: resolve(ROOT, ".env"),
    readEnv: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeEnv: (p, c) => writeFileAtomic(p, c),
  });
  console.log(`✔ Token gravado (valor nunca impresso). URN: ${personUrn}. Expira em ${expiresAt}.`);
  console.log("✔ .env local atualizado (token, URN e expiração).");
  if (r.dopplerFailed.length > 0) {
    console.error(
      `✖ Doppler NÃO recebeu: ${r.dopplerFailed.join(", ")} (cwd ${process.cwd()}).\n` +
        `  Doppler disse: ${r.dopplerErrors.join(" | ") || "sem stderr"}\n` +
        "  Causas comuns: `doppler login` vencido, ou este diretório sem `doppler setup` (projeto/config errado — confira `doppler configure`).\n" +
        "  O 300 não vai ver o token até ele subir pro vault: corrija e rode este script de novo (ou cole no dashboard).\n" +
        "  Atenção: as 3 chaves ficaram só no .env local, e o próximo `npm run sync-env` nesta máquina aborta (LocalOnlyEnvKeysError, #5155) até o vault ter as mesmas chaves.",
    );
    return 2;
  }
  console.log(`✔ Doppler: ${r.doppler.join(", ")}. No 300: \`npm run sync-env\`.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  // #9911: exitCode, não process.exit — no Windows o exit logo após o fetch sai 127.
  runCli(main, { onError: (e) => console.error(`✖ ${(e as Error).message}`) });
}
