/**
 * publish-weekly-social-subprocess-env-guard-6222.test.ts (#6222)
 *
 * `test/publish-weekly-social.test.ts` tem um teste que spawna
 * `scripts/publish-weekly-social.ts` como SUBPROCESSO real (fora do alcance
 * do `MockAgent`/`installNetworkRequestGuard` do processo pai) e zera
 * explicitamente as env vars de credencial antes do spawn — sem isso, um
 * `.env` real herdado via `...process.env` deixaria credenciais reais
 * (Facebook, Cloudflare, Worker LinkedIn/Instagram) vazarem pro subprocesso
 * caso algum código sob teste chegasse a tentar publicar de verdade (ver
 * PR #6268).
 *
 * Esse zeramento é uma LISTA escrita à mão — nada impede que um novo
 * `process.env.ALGO_TOKEN` seja adicionado a `publish-weekly-social.ts` (ou
 * a `cloudflare-kv-upload.ts`, de onde ele lê `CLOUDFLARE_*`) sem que
 * alguém lembre de estender a lista zerada no teste de subprocesso — a
 * MESMA classe de lacuna silenciosa que causou o vazamento original
 * (#6222: `clarice-engagement-cohorts-v2` também "esquecia" um caminho de
 * rede fora do mock óbvio).
 *
 * Este guard fecha essa lacuna mecanicamente: varre os arquivos-fonte que
 * `publish-weekly-social.ts` usa para credenciais, extrai todo
 * `process.env.NOME_EM_MAIUSCULO` que pareça uma credencial (TOKEN, KEY,
 * SECRET, ACCESS, ACCOUNT_ID, PASSWORD) e falha se algum desses nomes não
 * aparecer na lista zerada em `test/publish-weekly-social.test.ts`. Nunca
 * precisa de rede real nem de `data/`/`.env` — 100% estático.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Arquivos-fonte que publish-weekly-social.ts consulta para credenciais de
// publicação (Facebook direto + Cloudflare KV via cloudflare-kv-upload.ts).
// worker-queue-client.ts recebe URL/token como argumento (já cobertos pelas
// vars DIARIA_LINKEDIN_CRON_* abaixo) — não lê process.env diretamente.
const CREDENTIAL_SOURCE_FILES = [
  "scripts/publish-weekly-social.ts",
  "scripts/lib/cloudflare-kv-upload.ts",
];

const CREDENTIAL_NAME_PATTERN = /TOKEN|KEY|SECRET|ACCESS|ACCOUNT_ID|PASSWORD/;
const ENV_READ_PATTERN = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g;

function findCredentialEnvVarsReadBy(relPath: string): Set<string> {
  const source = readFileSync(resolve(__ROOT, relPath), "utf8");
  const found = new Set<string>();
  for (const match of source.matchAll(ENV_READ_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name && CREDENTIAL_NAME_PATTERN.test(name)) found.add(name);
  }
  return found;
}

function findEnvVarsClearedInSubprocessTest(): Set<string> {
  const source = readFileSync(resolve(__ROOT, "test/publish-weekly-social.test.ts"), "utf8");
  const cleared = new Set<string>();
  // Mesmo padrão exato usado na env object literal do spawnSync (#6222):
  // `NOME_EM_MAIUSCULO: "",` — linha própria, valor vazio.
  for (const match of source.matchAll(/^\s*([A-Z][A-Z0-9_]*): "",?$/gm)) {
    cleared.add(match[1]);
  }
  return cleared;
}

describe("guard: subprocesso de publish-weekly-social zera TODA credencial que lê (#6222)", () => {
  it("cada process.env.*TOKEN/KEY/SECRET/ACCESS/ACCOUNT_ID/PASSWORD lido por publish-weekly-social.ts (direto ou via cloudflare-kv-upload.ts) está na lista zerada antes do spawn", () => {
    const cleared = findEnvVarsClearedInSubprocessTest();
    assert.ok(cleared.size > 0, "a varredura não achou nenhuma var zerada — guard virou no-op, revisar o regex/arquivo");

    const missing: string[] = [];
    for (const file of CREDENTIAL_SOURCE_FILES) {
      const credentialVars = findCredentialEnvVarsReadBy(file);
      for (const name of credentialVars) {
        if (!cleared.has(name)) missing.push(`${name} (lido por ${file})`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `credencial(is) lida(s) em produção mas NÃO zerada(s) no teste de subprocesso ` +
        `(test/publish-weekly-social.test.ts, bloco spawnSync #6222) — um .env real ` +
        `herdado vazaria essa credencial pro subprocesso: ${missing.join(", ")}`,
    );
  });

  it("a varredura de fato encontra credenciais nos arquivos-fonte (guard não vira no-op silencioso)", () => {
    let total = 0;
    for (const file of CREDENTIAL_SOURCE_FILES) {
      total += findCredentialEnvVarsReadBy(file).size;
    }
    assert.ok(total > 0, "nenhuma credencial encontrada nos arquivos-fonte — o padrão/lista de arquivos pode ter ficado obsoleto");
  });
});
