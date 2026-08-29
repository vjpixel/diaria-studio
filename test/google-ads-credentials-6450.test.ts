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
  applyServiceAccountEnvUpdates,
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

describe("applyServiceAccountEnvUpdates (#6704)", () => {
  const parsed = JSON.parse(VALID_SA);

  it("source='env' (raw já parseou direto) => só atualiza GOOGLE_APPLICATION_CREDENTIALS, NUNCA reescreve GOOGLE_ADS_SERVICE_ACCOUNT_JSON", () => {
    const current =
      'GOOGLE_ADS_SERVICE_ACCOUNT_JSON="{\\"client_email\\":\\"a@b.com\\"}"\nGOOGLE_APPLICATION_CREDENTIALS=old';
    const result = applyServiceAccountEnvUpdates(current, "/home/x/sa.json", "env", parsed);
    assert.equal(result.rewroteServiceAccountJson, false);
    assert.equal(result.rewriteSkippedUnsafe, false);
    assert.match(result.content, /^GOOGLE_ADS_SERVICE_ACCOUNT_JSON="\{\\"client_email\\":\\"a@b\.com\\"\}"$/m);
    assert.match(result.content, /GOOGLE_APPLICATION_CREDENTIALS=\/home\/x\/sa\.json/);
  });

  it("source='fallback' mas o JSON contém '#' (ex: URL com fragmento) => NÃO reescreve, sinaliza rewriteSkippedUnsafe (#6704, achado do fleet review)", () => {
    // dotenv corta valor NÃO-citado no 1º '#' que encontrar, em qualquer
    // posição (regex real do dotenv@16.6.1: `[^#\r\n]+`) — reescrever sem
    // aspas aqui trocaria a corrupção conhecida (#6450) por uma corrupção
    // NOVA e silenciosa. O guard tem que recusar a reescrita nesse caso.
    const dangerous = { ...parsed, client_x509_cert_url: "https://example.com/cert#fragment" };
    const current = "GOOGLE_ADS_SERVICE_ACCOUNT_JSON=old\nGOOGLE_APPLICATION_CREDENTIALS=old";
    const result = applyServiceAccountEnvUpdates(current, "/home/x/sa.json", "fallback", dangerous);
    assert.equal(result.rewroteServiceAccountJson, false, "não deve reescrever quando o JSON contém '#'");
    assert.equal(result.rewriteSkippedUnsafe, true);
    // a linha original (ainda corrompida) permanece intocada — pior que
    // consertado, mas nunca pior do que já estava
    assert.match(result.content, /^GOOGLE_ADS_SERVICE_ACCOUNT_JSON=old$/m);
    // GOOGLE_APPLICATION_CREDENTIALS continua sendo atualizado normalmente
    assert.match(result.content, /GOOGLE_APPLICATION_CREDENTIALS=\/home\/x\/sa\.json/);
  });

  it("source='fallback' (raw estava corrompido) => reescreve GOOGLE_ADS_SERVICE_ACCOUNT_JSON SEM aspas ao redor", () => {
    const current =
      'GOOGLE_ADS_SERVICE_ACCOUNT_JSON="broken multi\nline value"\nGOOGLE_APPLICATION_CREDENTIALS=old';
    const result = applyServiceAccountEnvUpdates(current, "/home/x/sa.json", "fallback", parsed);
    assert.equal(result.rewroteServiceAccountJson, true);
    const line = result.content
      .split("\n")
      .find((l) => l.startsWith("GOOGLE_ADS_SERVICE_ACCOUNT_JSON="));
    assert.ok(line, "linha GOOGLE_ADS_SERVICE_ACCOUNT_JSON deve existir no resultado");
    const value = line!.slice("GOOGLE_ADS_SERVICE_ACCOUNT_JSON=".length);
    assert.ok(!value.startsWith('"'), "valor reescrito não deve começar com aspas — dotenv só desescapa valores citados");
    assert.ok(!value.endsWith('"'), "valor reescrito não deve terminar com aspas");
    // O valor reescrito precisa ser o JSON compacto (1 linha física) e
    // parsear de volta pro objeto original — é isso que garante que o
    // PRÓXIMO load via env-loader.ts (dotenv, sem unescape em valor não
    // citado) devolve o JSON íntegro.
    assert.deepEqual(JSON.parse(value), parsed);
  });

  it("reescrita sem aspas sobrevive a um round-trip via dotenv — não seria mais desescapada (achado #6704)", () => {
    const current = "FOO=1";
    const result = applyServiceAccountEnvUpdates(current, "/home/x/sa.json", "fallback", parsed);
    const line = result.content
      .split("\n")
      .find((l) => l.startsWith("GOOGLE_ADS_SERVICE_ACCOUNT_JSON="))!;
    const value = line.slice("GOOGLE_ADS_SERVICE_ACCOUNT_JSON=".length);
    // Reproduz a regra de unescape do dotenv (`value.replace(/\\n/g, '\n')`)
    // só quando o valor está entre aspas duplas — como o valor NÃO está
    // entre aspas, simulamos que o dotenv o copia literalmente (sem regex de
    // unescape) e confirmamos que o JSON.parse ainda funciona.
    assert.deepEqual(JSON.parse(value), parsed);
  });

  it("é idempotente em source='fallback' — aplicar 2x produz a mesma linha reescrita", () => {
    const once = applyServiceAccountEnvUpdates("FOO=1", "/home/x/sa.json", "fallback", parsed);
    const twice = applyServiceAccountEnvUpdates(once.content, "/home/x/sa.json", "fallback", parsed);
    assert.equal(once.content, twice.content);
  });
});

describe("Doppler fetch — timeout/stdio das opções de exec (#6704)", () => {
  // NUNCA chamar `fetchFromDopplerDirectly()`/`execFileSync` de verdade aqui
  // (guard do overnight: nunca tocar Doppler real nem credenciais reais).
  // `buildDopplerFetchExecOptions()` é puro — só monta o objeto de opções,
  // zero I/O — então o teste confere o valor exato sem nunca invocar um
  // subprocesso. Mockar `execFileSync` via `node:test`'s `mock.method` foi
  // tentado e descartado: a binding nomeada que o script importa de
  // `node:child_process` não reflete a substituição (nem via namespace nem
  // via default import), então o mock nunca interceptava — e a chamada real
  // rodava por baixo, contra o Doppler de verdade da máquina. Ver nota no PR.
  it("timeout = 60s (mesmo valor do #6630) e stdin ignorado", async () => {
    const mod = await import("../scripts/materialize-google-ads-credentials.ts");
    assert.equal(mod.DOPPLER_FETCH_TIMEOUT_MS, 60_000, "timeout deve ser 60s, mesmo valor do #6630");

    const options = mod.buildDopplerFetchExecOptions();
    assert.equal(options.timeout, mod.DOPPLER_FETCH_TIMEOUT_MS);
    assert.deepEqual(
      options.stdio,
      ["ignore", "pipe", "pipe"],
      "stdin deve ser ignorado — nunca herdar stdin do script (sem espaço pra prompt interativo travar)",
    );
  });
});

describe("tryOrNull — fail-soft genérico (#6704)", () => {
  it("função lança => retorna null, nunca propaga", async () => {
    const mod = await import("../scripts/materialize-google-ads-credentials.ts");
    assert.equal(
      mod.tryOrNull(() => {
        throw new Error("boom");
      }),
      null,
    );
  });

  it("função retorna normalmente => devolve o valor, sem alterar", async () => {
    const mod = await import("../scripts/materialize-google-ads-credentials.ts");
    assert.equal(
      mod.tryOrNull(() => "valor"),
      "valor",
    );
  });
});
