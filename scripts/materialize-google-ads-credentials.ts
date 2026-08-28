/**
 * scripts/materialize-google-ads-credentials.ts (#6450)
 *
 * Materializa `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` (secret Doppler, conteúdo
 * bruto da chave de Service Account) num arquivo local — o MCP `google-ads`
 * de `.mcp.json` só autentica via ADC (`GOOGLE_APPLICATION_CREDENTIALS`
 * apontando pra um ARQUIVO, nunca JSON inline). Rodar depois de
 * `npm run sync-env` (ou sempre que a chave rotacionar) e antes de abrir o
 * Claude Code — o MCP lê o env var na hora que sobe.
 *
 * Uso: `npx tsx scripts/materialize-google-ads-credentials.ts`
 *
 * Fail-soft de propósito quando a var ainda não existe: o setup do #6450 tem
 * 4 passos manuais do editor (GCP Console + Google Ads) antes do secret
 * existir no Doppler — rodar este script antes disso é o caminho normal
 * (setup incompleto), não um erro. Só falha (exit 1) se a var EXISTE mas o
 * conteúdo é JSON malformado — isso sim é config quebrada.
 *
 * Miolo puro (validação, path, transformação de texto) em
 * `scripts/lib/google-ads-credentials.ts` — este arquivo só faz I/O.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  defaultCredentialsPath,
  InvalidServiceAccountJsonError,
  parseServiceAccountJson,
  upsertEnvVar,
} from "./lib/google-ads-credentials.ts";
import { isMainModule } from "./lib/cli-args.ts";

/** Escreve `content` em `path` atomicamente (tmp + rename) — mesmo padrão de
 * `scripts/sync-env.ts`, nunca deixa o destino truncado numa falha parcial. */
function writeFileAtomic(path: string, content: string): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
}

export function main(): number {
  loadProjectEnv();

  const raw = process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.log(
      "[materialize-google-ads-credentials] GOOGLE_ADS_SERVICE_ACCOUNT_JSON ausente — " +
        "setup do #6450 ainda não concluído (service account/secret no Doppler). Nada a fazer.",
    );
    return 0;
  }

  let parsed;
  try {
    parsed = parseServiceAccountJson(raw);
  } catch (err) {
    if (err instanceof InvalidServiceAccountJsonError) {
      console.error(`[materialize-google-ads-credentials] ${err.message}`);
      return 1;
    }
    throw err;
  }

  const credPath = defaultCredentialsPath(homedir());
  mkdirSync(dirname(credPath), { recursive: true });
  writeFileAtomic(credPath, JSON.stringify(parsed, null, 2));
  console.log(`[materialize-google-ads-credentials] credencial escrita em ${credPath} (client_email=${parsed.client_email}).`);

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = resolve(root, ".env");
  if (existsSync(envPath)) {
    const current = readFileSync(envPath, "utf8");
    const updated = upsertEnvVar(current, "GOOGLE_APPLICATION_CREDENTIALS", credPath);
    if (updated !== current) {
      writeFileAtomic(envPath, updated);
      console.log("[materialize-google-ads-credentials] .env atualizado: GOOGLE_APPLICATION_CREDENTIALS aponta pro arquivo acima.");
    }
  } else {
    console.log(
      "[materialize-google-ads-credentials] .env não existe — defina GOOGLE_APPLICATION_CREDENTIALS=" +
        `${credPath} manualmente antes de abrir o Claude Code.`,
    );
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
