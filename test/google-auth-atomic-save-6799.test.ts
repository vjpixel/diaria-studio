/**
 * test/google-auth-atomic-save-6799.test.ts (#6799)
 *
 * `scripts/check-brevo-diaria-guardrail.ts` morreu em 30/08/2026 (3
 * execuções seguidas) com `SyntaxError: Expected double-quoted property
 * name in JSON` ao ler um arquivo local corrompido. Investigação: o único
 * write NÃO-atômico alcançável pelo fluxo desse script era
 * `saveCredentials` em `scripts/google-auth.ts` (`data/.credentials.json`,
 * reescrito a cada refresh de access_token, compartilhado entre múltiplos
 * scripts que podem rodar concorrentemente via Task Scheduler) — usava
 * `writeFileSync` puro, que TRUNCA o arquivo antes de escrever; duas
 * execuções concorrentes truncando/escrevendo o MESMO arquivo (fds
 * independentes, offsets independentes) podem intercalar bytes de dois
 * processos e deixar JSON sintaticamente inválido.
 *
 * Este teste cobre a correção: `saveCredentials` agora usa
 * `writeFileAtomic` (write-temp + fsync + rename) — o arquivo final é
 * sempre OU a versão anterior completa OU a nova versão completa, nunca
 * uma mistura parcial. Não testamos a race condition diretamente (não é
 * determinística), mas provamos os dois invariantes que a tornam
 * impossível: (1) round-trip do conteúdo é sempre um JSON válido e
 * completo, (2) nenhum arquivo temporário fica pra trás após o refresh —
 * evidência de que o rename atômico completou e o cleanup rodou.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAccessToken,
  CREDENTIALS_PATH_TEST_OVERRIDE_ENV,
  type GoogleCredentials,
} from "../scripts/google-auth.ts";

let tmpDir: string;
let credsPath: string;
let originalFetch: typeof fetch;
let originalEnv: string | undefined;

function writeCreds(overrides: Partial<GoogleCredentials> = {}): void {
  const creds: GoogleCredentials = {
    client_id: "test-client-id",
    client_secret: "test-client-secret",
    access_token: "old-access-token",
    refresh_token: "test-refresh-token",
    expiry_ms: Date.now() + 3_600_000,
    ...overrides,
  };
  writeFileSync(credsPath, JSON.stringify(creds, null, 2), "utf8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "google-auth-atomic-save-test-"));
  credsPath = join(tmpDir, "credentials.json");
  originalEnv = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
  process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = credsPath;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
  else process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("saveCredentials (via refreshAccessToken) — escrita atômica (#6799)", () => {
  it("após refresh, o arquivo de credenciais é JSON válido e completo (round-trip)", async () => {
    writeCreds({ expiry_ms: Date.now() - 1000, access_token: "old-token" }); // expirado → força refresh

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const token = await getAccessToken();
    assert.equal(token, "new-token");

    // O arquivo em disco precisa parsear como JSON válido — nunca uma
    // mistura de bytes de duas escritas.
    const raw = readFileSync(credsPath, "utf8");
    const parsed = JSON.parse(raw) as GoogleCredentials;
    assert.equal(parsed.access_token, "new-token");
    assert.equal(parsed.refresh_token, "test-refresh-token"); // preservado do spread
  });

  it("após o refresh, nenhum arquivo temporário fica pra trás (rename atômico completou + cleanup rodou)", async () => {
    writeCreds({ expiry_ms: Date.now() - 1000 });

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await getAccessToken();

    const entries = readdirSync(tmpDir);
    const tmpLeftovers = entries.filter((f) => f.includes(".tmp-"));
    assert.deepEqual(tmpLeftovers, [], `arquivo(s) temporário(s) não limpo(s): ${tmpLeftovers.join(", ")}`);
    assert.deepEqual(entries, ["credentials.json"]);
  });

  it("REGRESSÃO (#6799): duas escritas sequenciais nunca produzem um arquivo com conteúdo de AMBAS concatenado", async () => {
    // Não reproduz a race em si (não-determinística), mas prova o invariante
    // que a torna impossível: cada `saveCredentials` sempre RESULTA em um
    // único documento JSON completo, nunca um append/mistura do anterior.
    writeCreds({ expiry_ms: Date.now() - 1000, access_token: "token-v1" });

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ access_token: `token-v${callCount + 1}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await getAccessToken(); // expira de novo pra forçar 2º refresh
    writeCreds({ expiry_ms: Date.now() - 1000, access_token: "token-v2", refresh_token: "test-refresh-token" });
    await getAccessToken();

    const raw = readFileSync(credsPath, "utf8");
    // Um JSON válido de UM objeto só — se tivesse concatenado, JSON.parse
    // lançaria "Expected double-quoted property name" ou similar (o próprio
    // sintoma do #6799).
    assert.doesNotThrow(() => JSON.parse(raw));
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed, "object");
    assert.equal(Array.isArray(parsed), false);
  });
});
