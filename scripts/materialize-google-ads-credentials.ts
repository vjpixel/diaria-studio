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
  applyServiceAccountEnvUpdates,
  defaultCredentialsPath,
  InvalidServiceAccountJsonError,
  parseServiceAccountJsonWithFallback,
} from "./lib/google-ads-credentials.ts";
import { isMainModule } from "./lib/cli-args.ts";

/** Timeout do fallback `doppler secrets get` (#6704) — mesmo valor do #6630
 * pro runner de lock, mesma classe de falha: `doppler` sem sessão válida
 * (token expirado, prompt interativo, retry de rede) pode pendurar
 * indefinidamente. Numa task agendada não-interativa (helios), sem timeout o
 * processo trava pra sempre e o `catch {}` fail-soft abaixo nunca roda porque
 * a chamada nunca retorna — o guard "fail-soft" só existe se a chamada de
 * fato conseguir FALHAR em vez de travar. */
export const DOPPLER_FETCH_TIMEOUT_MS = 60_000;

/** Opções do `execFileSync` da chamada ao Doppler — extraído como função pura
 * (#6704) exatamente para poder testar timeout/stdio SEM nunca invocar
 * `execFileSync` de verdade: mockar `execFileSync` via `node:test` foi
 * tentado e descartado porque a binding nomeada importada de
 * `node:child_process` não reflete a substituição do mock, e a chamada real
 * acaba rodando por baixo — contra o Doppler de verdade da máquina. Isolar a
 * MONTAGEM do objeto de opções (zero I/O) elimina esse risco por completo. */
export function buildDopplerFetchExecOptions(): {
  encoding: "utf8";
  timeout: number;
  stdio: ["ignore", "pipe", "pipe"];
} {
  return { encoding: "utf8", timeout: DOPPLER_FETCH_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] };
}

/** Fail-soft genérico: roda `fn`, devolve `null` em qualquer erro (nunca
 * propaga). Extraído (#6704) só para poder testar a POLÍTICA de fail-soft
 * (erro => null, sucesso => valor) isoladamente, sem acoplar o teste a
 * `execFileSync`/Doppler de verdade. */
export function tryOrNull<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

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
 * logado, offline, timeout) retorna `null`, e o chamador segue com o erro
 * original do `.env` — nunca lança daqui.
 *
 * `timeout`/`stdio` (#6704, achado do fleet review): sem `timeout`, uma
 * sessão Doppler inválida pode pendurar o CLI indefinidamente (prompt
 * interativo ou retry de rede) — numa task agendada não-interativa isso
 * trava o script pra sempre, nunca cai no `catch`. `stdio: ["ignore", ...]`
 * garante que o processo nunca herda stdin do script — sem isso, um CLI que
 * decida abrir um prompt teria onde escrever/ler, mascarando o problema em
 * vez de falhar rápido. */
export function fetchFromDopplerDirectly(): string | null {
  return tryOrNull(() =>
    execFileSync(
      "doppler",
      ["secrets", "get", "GOOGLE_ADS_SERVICE_ACCOUNT_JSON", "--plain"],
      buildDopplerFetchExecOptions(),
    ).replace(/\r?\n$/, ""),
  ); // remove só o newline final que o CLI acrescenta, preserva os internos do PEM
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
  let source: "env" | "fallback";
  try {
    const result = parseServiceAccountJsonWithFallback(raw, fetchFromDopplerDirectly);
    parsed = result.parsed;
    source = result.source;
    if (source === "fallback") {
      // Warn (não log de sucesso silencioso, #6704): até o bloco abaixo
      // reescrever o .env (se for seguro fazê-lo — ver guard do '#' em
      // applyServiceAccountEnvUpdates), GOOGLE_ADS_SERVICE_ACCOUNT_JSON
      // ainda está corrompido nele — qualquer outro consumidor que leia via
      // env-loader.ts (não só este script) segue quebrado. `npm run
      // sync-env` NÃO resolve isto (o round-trip Doppler→.env→dotenv é a
      // própria causa da corrupção). Mensagem deliberadamente NÃO promete a
      // reescrita aqui — o resultado real (consertado, pulado por '#', ou
      // .env ausente) é logado mais abaixo, onde já se sabe qual foi.
      console.warn(
        "[materialize-google-ads-credentials] GOOGLE_ADS_SERVICE_ACCOUNT_JSON em .env estava corrompido " +
          "(round-trip dotenv, ver docstring) — usado o valor direto do Doppler CLI para esta execução.",
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
    const { content: updated, rewroteServiceAccountJson, rewriteSkippedUnsafe } = applyServiceAccountEnvUpdates(
      current,
      credPath,
      source,
      parsed,
    );
    if (rewriteSkippedUnsafe) {
      // #6704, achado do fleet review: o dotenv instalado corta valor
      // não-citado no 1º `#` que encontrar, em qualquer posição — se algum
      // campo do JSON contiver `#`, reescrever sem aspas trocaria a
      // corrupção conhecida (#6450) por uma corrupção NOVA e silenciosa.
      // Avisa e deixa o `.env` como estava — pior que consertado, mas nunca
      // pior que já era.
      console.warn(
        "[materialize-google-ads-credentials] GOOGLE_ADS_SERVICE_ACCOUNT_JSON contém '#' — " +
          "reescrita sem aspas foi PULADA de propósito (dotenv corta valor não-citado no 1º '#', " +
          "trocaria uma corrupção por outra). O .env segue corrompido para outros consumidores; " +
          "esta execução já tem a credencial correta via fallback do Doppler CLI.",
      );
    }
    if (updated !== current) {
      writeFileAtomic(envPath, updated);
      console.log("[materialize-google-ads-credentials] .env atualizado: GOOGLE_APPLICATION_CREDENTIALS aponta pro arquivo acima.");
      if (rewroteServiceAccountJson) {
        console.log(
          "[materialize-google-ads-credentials] GOOGLE_ADS_SERVICE_ACCOUNT_JSON reescrito em .env sem aspas — " +
            "consertado para os próximos loads via env-loader.ts. Processos já em execução com o .env antigo " +
            "carregado (sessões de terminal, MCP já subido) continuam com o valor corrompido em memória até reiniciarem.",
        );
      }
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
