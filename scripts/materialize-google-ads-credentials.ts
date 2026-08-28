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
 * **Achado ao vivo (#6450, 28/08/2026) — round-trip Doppler→`.env`→dotenv
 * corrompe este secret especificamente.** `doppler secrets download` grava
 * o JSON multi-linha no `.env` com aspas internas escapadas; `dotenv@16.6.1`
 * (`env-loader.ts`) desescapa `\n`/`\r` em TODO o valor entre aspas duplas —
 * inclusive os `\n` que fazem parte da `private_key` (o bloco PEM tem
 * newlines escapados como parte da própria string JSON). O resultado é um
 * JSON estruturalmente quebrado que nenhum unescape posterior conserta. Por
 * isso, se `process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON` (via `.env`) falhar
 * o parse, este script tenta buscar o valor direto do Doppler CLI
 * (`fetchFromDopplerDirectly`, sem passar pelo `.env`) antes de desistir —
 * esse caminho não sofre o round-trip e devolve o JSON íntegro.
 *
 * Miolo puro (validação, path, transformação de texto) em
 * `scripts/lib/google-ads-credentials.ts` — este arquivo só faz I/O.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  defaultCredentialsPath,
  InvalidServiceAccountJsonError,
  parseServiceAccountJsonWithFallback,
  upsertEnvVar,
} from "./lib/google-ads-credentials.ts";
import { isMainModule } from "./lib/cli-args.ts";

/** Busca o secret direto do Doppler CLI, sem passar pelo `.env`/dotenv
 * (achado ao vivo, #6450, 28/08/2026): `doppler secrets download` grava o
 * JSON multi-linha no `.env` com as aspas internas escapadas (`\"`), mas
 * `dotenv@16.6.1` faz `value.replace(/\\n/g, '\n')` em TODO o valor entre
 * aspas duplas — não só nas quebras de linha "de fora" do JSON, mas também
 * nos `\n` que fazem parte da `private_key` (o bloco PEM tem newlines
 * escapados como parte da string JSON). O round-trip Doppler→`.env`→dotenv
 * corrompe a estrutura do JSON de um jeito que nenhum unescape posterior
 * conserta (não é só `\"` faltando — os `\n` internos da private_key viram
 * quebras de linha REAIS antes do JSON.parse rodar). `doppler secrets get
 * --plain` devolve o valor puro, sem esse round-trip — confirmado ao vivo
 * que resolve. Fail-soft: qualquer erro (Doppler CLI ausente, não
 * logado, offline) retorna `null`, e o chamador segue com o erro original
 * do `.env` — nunca lança daqui. */
function fetchFromDopplerDirectly(): string | null {
  try {
    return execFileSync("doppler", ["secrets", "get", "GOOGLE_ADS_SERVICE_ACCOUNT_JSON", "--plain"], {
      encoding: "utf8",
    }).replace(/\r?\n$/, ""); // remove só o newline final que o CLI acrescenta, preserva os internos do PEM
  } catch {
    return null;
  }
}

/** Escreve `content` em `path` atomicamente (tmp + rename) — mesmo padrão de
 * `scripts/sync-env.ts`, nunca deixa o destino truncado numa falha parcial.
 * `mode` (achado do fleet review, #6450): sem ele o arquivo herda o umask
 * padrão do processo (tipicamente 0644 em Linux) — inaceitável pra um
 * arquivo com `private_key` num servidor multiusuário como o `helios`.
 * `renameSync` preserva o mode do arquivo de origem (`.tmp`), então basta
 * setar no `writeFileSync`. */
function writeFileAtomic(path: string, content: string, mode?: number): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content, mode !== undefined ? { encoding: "utf8", mode } : "utf8");
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
    const result = parseServiceAccountJsonWithFallback(raw, fetchFromDopplerDirectly);
    parsed = result.parsed;
    if (result.source === "fallback") {
      console.log(
        "[materialize-google-ads-credentials] valor de .env estava corrompido (round-trip dotenv) — usado o valor direto do Doppler CLI.",
      );
    }
  } catch (err) {
    if (err instanceof InvalidServiceAccountJsonError) {
      console.error(`[materialize-google-ads-credentials] ${err.message}`);
      return 1;
    }
    throw err;
  }

  const credPath = defaultCredentialsPath(homedir());
  mkdirSync(dirname(credPath), { recursive: true, mode: 0o700 });
  writeFileAtomic(credPath, JSON.stringify(parsed, null, 2), 0o600);
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
