/**
 * test/google-ads-credentials-6450.test.ts (#6450)
 *
 * Unit do miolo puro de `scripts/lib/google-ads-credentials.ts` — o
 * materializador de `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` em arquivo local (o
 * MCP `google-ads` só aceita ADC via ARQUIVO, nunca JSON inline). Cobre
 * validação (rejeita JSON malformado/incompleto, nunca aceita "presente"
 * como "utilizável"), o path fixo por máquina, e o upsert idempotente da
 * linha `GOOGLE_APPLICATION_CREDENTIALS` num `.env`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultCredentialsPath,
  InvalidServiceAccountJsonError,
  parseServiceAccountJson,
  parseServiceAccountJsonWithFallback,
  upsertEnvVar,
} from "../scripts/lib/google-ads-credentials.ts";

const VALID_SA = JSON.stringify({
  type: "service_account",
  project_id: "velvety-tube-505505-d1",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  client_email: "google-ads-mcp@velvety-tube-505505-d1.iam.gserviceaccount.com",
});

describe("parseServiceAccountJson (#6450)", () => {
  it("JSON válido com client_email + private_key => parseia normalmente", () => {
    const parsed = parseServiceAccountJson(VALID_SA);
    assert.equal(parsed.client_email, "google-ads-mcp@velvety-tube-505505-d1.iam.gserviceaccount.com");
    assert.equal(parsed.project_id, "velvety-tube-505505-d1");
  });

  it("não é JSON (string crua) => InvalidServiceAccountJsonError, nunca aceita em silêncio", () => {
    assert.throws(() => parseServiceAccountJson("isto não é json"), InvalidServiceAccountJsonError);
  });

  it("JSON válido mas é um array => InvalidServiceAccountJsonError", () => {
    assert.throws(() => parseServiceAccountJson("[1,2,3]"), InvalidServiceAccountJsonError);
  });

  it("JSON válido mas sem client_email => InvalidServiceAccountJsonError", () => {
    const obj = JSON.parse(VALID_SA);
    delete obj.client_email;
    assert.throws(() => parseServiceAccountJson(JSON.stringify(obj)), InvalidServiceAccountJsonError);
  });

  it("JSON válido mas sem private_key => InvalidServiceAccountJsonError", () => {
    const obj = JSON.parse(VALID_SA);
    delete obj.private_key;
    assert.throws(() => parseServiceAccountJson(JSON.stringify(obj)), InvalidServiceAccountJsonError);
  });

  it("client_email vazio ('') conta como ausente — nunca aceita placeholder vazio", () => {
    const obj = JSON.parse(VALID_SA);
    obj.client_email = "";
    assert.throws(() => parseServiceAccountJson(JSON.stringify(obj)), InvalidServiceAccountJsonError);
  });
});

describe("parseServiceAccountJsonWithFallback (#6450, achado ao vivo 28/08/2026)", () => {
  it("raw válido direto => usa raw, nunca chama o fallback", () => {
    let fallbackCalled = false;
    const result = parseServiceAccountJsonWithFallback(VALID_SA, () => {
      fallbackCalled = true;
      return VALID_SA;
    });
    assert.equal(result.source, "env");
    assert.equal(fallbackCalled, false, "fallback não deve rodar quando o raw já parseia");
    assert.equal(result.parsed.client_email, "google-ads-mcp@velvety-tube-505505-d1.iam.gserviceaccount.com");
  });

  it("raw corrompido (round-trip dotenv) mas fallback devolve JSON íntegro => usa o fallback", () => {
    // Reproduz o achado ao vivo: dotenv desescapa \n em TODO o valor,
    // inclusive dentro da private_key — o "raw" fica com uma quebra de
    // linha real no meio de uma string JSON, o que quebra o parse de forma
    // que nenhum unescape simples de aspas conserta.
    const corrupted = '{\n  "client_email": "a@b.com",\n  "private_key": "-----BEGIN\nBROKEN-----"\n}';
    const result = parseServiceAccountJsonWithFallback(corrupted, () => VALID_SA);
    assert.equal(result.source, "fallback");
    assert.equal(result.parsed.client_email, "google-ads-mcp@velvety-tube-505505-d1.iam.gserviceaccount.com");
  });

  it("raw corrompido e fetchFallback retorna null (Doppler CLI indisponível) => relança o erro ORIGINAL do raw", () => {
    assert.throws(
      () => parseServiceAccountJsonWithFallback("não é json", () => null),
      (err: unknown) => {
        assert.ok(err instanceof InvalidServiceAccountJsonError);
        assert.match((err as Error).message, /não é JSON válido/);
        return true;
      },
    );
  });

  it("raw corrompido e o fallback TAMBÉM está quebrado => lança o erro do fallback (mais informativo)", () => {
    assert.throws(
      () => parseServiceAccountJsonWithFallback("não é json", () => "também não é json"),
      InvalidServiceAccountJsonError,
    );
  });
});

describe("defaultCredentialsPath (#6450)", () => {
  it("monta ~/.config/diaria/google-ads-sa.json a partir do homeDir injetado", () => {
    const path = defaultCredentialsPath("/home/vjpixel");
    assert.match(path, /\.config[\\/]diaria[\\/]google-ads-sa\.json$/);
    assert.ok(path.startsWith("/home/vjpixel") || path.includes("home"));
  });
});

describe("upsertEnvVar (#6450)", () => {
  it("chave ausente => acrescenta ao final, com linha em branco antes se preciso", () => {
    const content = "FOO=1\nBAR=2";
    const result = upsertEnvVar(content, "GOOGLE_APPLICATION_CREDENTIALS", "/home/x/sa.json");
    assert.equal(result, "FOO=1\nBAR=2\n\nGOOGLE_APPLICATION_CREDENTIALS=/home/x/sa.json");
  });

  it("chave já presente => substitui SÓ essa linha, preserva ordem/vizinhas", () => {
    const content = "FOO=1\nGOOGLE_APPLICATION_CREDENTIALS=\nBAR=2";
    const result = upsertEnvVar(content, "GOOGLE_APPLICATION_CREDENTIALS", "/home/x/sa.json");
    assert.equal(result, "FOO=1\nGOOGLE_APPLICATION_CREDENTIALS=/home/x/sa.json\nBAR=2");
  });

  it("chave presente 2x (arquivo malformado) => atualiza só a 1ª ocorrência, nunca duplica mais", () => {
    const content = "GOOGLE_APPLICATION_CREDENTIALS=old1\nGOOGLE_APPLICATION_CREDENTIALS=old2";
    const result = upsertEnvVar(content, "GOOGLE_APPLICATION_CREDENTIALS", "/home/x/sa.json");
    assert.equal(result, "GOOGLE_APPLICATION_CREDENTIALS=/home/x/sa.json\nGOOGLE_APPLICATION_CREDENTIALS=old2");
  });

  it("conteúdo vazio => cria a chave sozinha, sem linha em branco espúria no início", () => {
    const result = upsertEnvVar("", "GOOGLE_APPLICATION_CREDENTIALS", "/home/x/sa.json");
    assert.equal(result, "GOOGLE_APPLICATION_CREDENTIALS=/home/x/sa.json");
  });

  it("é idempotente — aplicar 2x com o mesmo valor não muda o resultado da 1ª aplicação", () => {
    const once = upsertEnvVar("FOO=1", "GOOGLE_APPLICATION_CREDENTIALS", "/home/x/sa.json");
    const twice = upsertEnvVar(once, "GOOGLE_APPLICATION_CREDENTIALS", "/home/x/sa.json");
    assert.equal(once, twice);
  });
});
