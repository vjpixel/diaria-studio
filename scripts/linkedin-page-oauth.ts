/**
 * linkedin-page-oauth.ts (#8055 — token da PÁGINA diar.ia.br no LinkedIn)
 *
 * OAuth one-shot (authorization code + redirect local) do app da PÁGINA
 * (77tlvy0623oq84, Community Management API). Mesmo desenho de
 * `scripts/linkedin-personal-oauth.ts`, que é o do perfil pessoal. Rodar na
 * máquina do editor, logado no LinkedIn como admin da página.
 *
 * Lê do ambiente (Doppler → `.env`):
 *   LINKEDIN_PAGE_CLIENT_SECRET   (aba Auth do app → Primary Client Secret)
 *   LINKEDIN_PAGE_CLIENT_ID       opcional; default 77tlvy0623oq84
 *
 * Grava, SEM nunca imprimir valor, no Doppler e no `.env` local:
 *   LINKEDIN_ACCESS_TOKEN       token w_organization_social (60 dias, sem refresh)
 *   LINKEDIN_AUTHOR_URN         urn:li:organization:{id} (via organizationAcls)
 *   LINKEDIN_TOKEN_EXPIRES_AT   ISO — o `doppler-token-expiry-alarm` vigia todo *_EXPIRES_AT
 *
 * Redirect URL a cadastrar no app (aba Auth → "Authorized redirect URLs"):
 *   http://localhost:8767/linkedin/page-callback
 *
 * O Worker `linkedin-cron` não lê o Doppler: depois deste script, subir as
 * duas primeiras com `wrangler secret put` (ver #8816).
 *
 * Uso:  npx tsx scripts/linkedin-page-oauth.ts [--org urn:li:organization:{id}]
 */

import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { defaultDopplerSet, persistSecrets } from "./lib/secret-persist.ts";
import { waitForCode } from "./lib/oauth-local-redirect.ts";
import { buildAuthorizeUrl, computeExpiresAt, defaultLinkedInApiVersion, exchangeCodeForToken } from "./lib/linkedin-personal.ts";
import {
  LINKEDIN_PAGE_DEFAULT_CLIENT_ID,
  LINKEDIN_PAGE_ENV,
  LINKEDIN_PAGE_REDIRECT_PATH,
  LINKEDIN_PAGE_REDIRECT_PORT,
  LINKEDIN_PAGE_REDIRECT_URI,
  LINKEDIN_PAGE_SCOPES,
  fetchAdministeredOrgUrns,
  isOrganizationUrn,
  pickOrgUrn,
} from "./lib/linkedin-page-oauth.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

async function main(): Promise<number> {
  loadProjectEnv(ROOT);
  const clientId = (process.env[LINKEDIN_PAGE_ENV.clientId] ?? "").trim() || LINKEDIN_PAGE_DEFAULT_CLIENT_ID;
  const clientSecret = (process.env[LINKEDIN_PAGE_ENV.clientSecret] ?? "").trim();
  if (!clientSecret) {
    console.error(
      `✖ Falta ${LINKEDIN_PAGE_ENV.clientSecret} no ambiente.\n` +
        "  Copie o Primary Client Secret da aba Auth do app da página, grave no Doppler e rode `npm run sync-env`.",
    );
    return 1;
  }
  // --org validado ANTES do consentimento: errar aqui não custa uma ida ao navegador.
  const argv = process.argv.slice(2);
  const orgArg = getArg(argv, "org");
  if (hasFlag(argv, "org") && !isOrganizationUrn(orgArg)) {
    console.error(`✖ --org precisa de um valor urn:li:organization:{id} (veio "${orgArg}").`);
    return 1;
  }
  const opts = { redirectUri: LINKEDIN_PAGE_REDIRECT_URI, scopes: LINKEDIN_PAGE_SCOPES };
  const state = randomBytes(16).toString("hex");
  const code = await waitForCode({
    authUrl: buildAuthorizeUrl(clientId, state, opts),
    state,
    port: LINKEDIN_PAGE_REDIRECT_PORT,
    path: LINKEDIN_PAGE_REDIRECT_PATH,
    prompt: "Abra esta URL no navegador logado como ADMIN da página diar.ia.br (deve abrir sozinha):",
    timeoutMs: CONSENT_TIMEOUT_MS,
  });
  const token = await exchangeCodeForToken(fetch, {
    code,
    clientId,
    clientSecret,
    redirectUri: LINKEDIN_PAGE_REDIRECT_URI,
    requiredScope: "w_organization_social",
  });

  const apiVersion = (process.env.LINKEDIN_API_VERSION ?? "").trim() || defaultLinkedInApiVersion(new Date());
  let administered: string[] | null = null;
  try {
    administered = await fetchAdministeredOrgUrns(fetch, token.accessToken, apiVersion);
  } catch (e) {
    console.error(`⚠ ${(e as Error).message}`);
  }
  const picked = pickOrgUrn(administered, orgArg || undefined);
  if (!picked.ok) {
    console.error(`✖ ${picked.reason}. Nada foi gravado.`);
    return 1;
  }
  const expiresAt = computeExpiresAt(new Date(), token.expiresInSec).toISOString();

  const r = persistSecrets({
    secrets: {
      [LINKEDIN_PAGE_ENV.accessToken]: token.accessToken,
      [LINKEDIN_PAGE_ENV.authorUrn]: picked.urn,
      [LINKEDIN_PAGE_ENV.expiresAt]: expiresAt,
    },
    dopplerSet: defaultDopplerSet,
    envPath: resolve(ROOT, ".env"),
    readEnv: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeEnv: (p, c) => writeFileAtomic(p, c),
  });
  console.log(`✔ Token gravado (valor nunca impresso). Página: ${picked.urn}. Escopos: ${token.scope}. Expira em ${expiresAt}.`);
  console.log("✔ .env local atualizado (token, URN e expiração).");
  if (r.dopplerFailed.length > 0) {
    console.error(
      `✖ Doppler NÃO recebeu: ${r.dopplerFailed.join(", ")} (cwd ${process.cwd()}).\n` +
        `  Doppler disse: ${r.dopplerErrors.join(" | ") || "sem stderr"}\n` +
        "  Corrija (`doppler login`/`doppler configure`) e rode este script de novo. Até lá o próximo `npm run sync-env` desta máquina aborta (#5155).",
    );
    return 2;
  }
  console.log(`✔ Doppler: ${r.doppler.join(", ")}. Próximo passo: wrangler secret put no Worker linkedin-cron (#8816).`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`✖ ${(e as Error).message}`) });
}
