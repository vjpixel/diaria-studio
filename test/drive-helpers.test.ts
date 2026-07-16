import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  isRetryableStatus,
  backoffMs,
  escapeDriveQueryString,
  buildMultipartBody,
  driveFindFolderByNames,
} from "../scripts/lib/drive-helpers.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CREDS_PATH = resolve(ROOT, "data", ".credentials.json");

/** Fake credentials with expiry far in the future — avoids token refresh fetch. */
const FAKE_CREDS = {
  client_id: "fake",
  client_secret: "fake",
  access_token: "fake-token",
  refresh_token: "fake-refresh",
  expiry_ms: Date.now() + 3_600_000, // 1h
};

function makeDriveResponse(body: unknown, status = 200): Response {
  const json = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => json,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => null },
  } as unknown as Response;
}

describe("isRetryableStatus (#1308 item 2 — migrado de drive-sync)", () => {
  it("retorna true pra 429, 502, 503, 504", () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(502), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(504), true);
  });
  it("retorna false pra 200, 401, 404, 500, 501", () => {
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(500), false);
    assert.equal(isRetryableStatus(501), false);
  });
});

describe("backoffMs (#1308 item 2 — migrado de drive-sync)", () => {
  it("base exponencial 1s, 2s, 4s pra attempt 0/1/2", () => {
    const noJitter = () => 0;
    assert.equal(backoffMs(0, noJitter), 1000);
    assert.equal(backoffMs(1, noJitter), 2000);
    assert.equal(backoffMs(2, noJitter), 4000);
  });
  it("jitter ≤ 250ms", () => {
    const fullJitter = () => 1;
    assert.equal(backoffMs(0, fullJitter), 1250);
  });
});

describe("escapeDriveQueryString (#1308 item 2)", () => {
  it("escapa aspas simples", () => {
    assert.equal(escapeDriveQueryString("d'Or"), "d\\'Or");
  });
  it("escapa backslashes antes das aspas (ordem importa)", () => {
    assert.equal(escapeDriveQueryString("a\\b'c"), "a\\\\b\\'c");
  });
  it("passa strings normais intactas", () => {
    assert.equal(escapeDriveQueryString("relatorios"), "relatorios");
    assert.equal(escapeDriveQueryString("diar.ia"), "diar.ia");
  });
});

describe("buildMultipartBody (#1308 item 4)", () => {
  it("contentType inclui boundary com prefix diaria_mp_", () => {
    const r = buildMultipartBody({
      metadata: { name: "test" },
      contentType: "text/markdown",
      content: "hello",
    });
    assert.match(r.contentType, /^multipart\/related; boundary=diaria_mp_\d+_\d+$/);
  });

  it("body tem 3 partes (metadata + content + closing)", () => {
    const r = buildMultipartBody({
      metadata: { name: "foo" },
      contentType: "text/markdown; charset=UTF-8",
      content: "bar",
    });
    const boundary = (r.contentType.match(/boundary=(.+)$/) ?? [])[1];
    assert.ok(boundary, "boundary deve estar no contentType");

    const bodyStr = Buffer.from(r.body as Uint8Array).toString("utf8");
    // 2 opening boundaries (entre as partes) + 1 closing
    const opens = bodyStr.match(new RegExp(`--${boundary}\r\n`, "g")) ?? [];
    assert.equal(opens.length, 2, "deve ter 2 boundary openers");
    assert.ok(bodyStr.endsWith(`\r\n--${boundary}--`), "deve fechar com --boundary--");
  });

  it("metadata JSON aparece como primeira parte", () => {
    const r = buildMultipartBody({
      metadata: { name: "doc.md", parents: ["abc"] },
      contentType: "text/markdown",
      content: "x",
    });
    const bodyStr = Buffer.from(r.body as Uint8Array).toString("utf8");
    assert.ok(bodyStr.includes(`"name":"doc.md"`), "metadata.name deve aparecer");
    assert.ok(bodyStr.includes(`"parents":["abc"]`), "metadata.parents deve aparecer");
  });

  it("content string vira bytes utf8", () => {
    const r = buildMultipartBody({
      metadata: {},
      contentType: "text/markdown",
      content: "olá",
    });
    const bodyStr = Buffer.from(r.body as Uint8Array).toString("utf8");
    assert.ok(bodyStr.includes("olá"), "content utf8 preservado");
  });

  it("content Buffer (binário) preservado byte-a-byte", () => {
    const binaryContent = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
    const r = buildMultipartBody({
      metadata: { name: "img.jpg" },
      contentType: "image/jpeg",
      content: binaryContent,
    });
    // Procura os bytes binários no body
    const bodyBuf = Buffer.from(r.body as Uint8Array);
    const idx = bodyBuf.indexOf(binaryContent);
    assert.ok(idx > 0, `content binário deve aparecer no body (idx=${idx})`);
  });

  it("boundaries únicos entre chamadas concorrentes (counter incrementa)", () => {
    const r1 = buildMultipartBody({ metadata: {}, contentType: "text/plain", content: "a" });
    const r2 = buildMultipartBody({ metadata: {}, contentType: "text/plain", content: "b" });
    assert.notEqual(r1.contentType, r2.contentType, "boundaries devem diferir entre chamadas");
  });
});

describe("driveFindFolderByNames (#3573 — resolve pasta tolerante a rename)", () => {
  let originalFetch: typeof globalThis.fetch;
  let credsExistedBefore: boolean;
  let prevCredsContent: string | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    credsExistedBefore = existsSync(CREDS_PATH);
    prevCredsContent = credsExistedBefore ? readFileSync(CREDS_PATH, "utf8") : null;
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(CREDS_PATH, JSON.stringify(FAKE_CREDS), "utf8");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      if (prevCredsContent !== null) writeFileSync(CREDS_PATH, prevCredsContent, "utf8");
      else if (!credsExistedBefore && existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
    } catch (e) {
      console.error("[afterEach driveFindFolderByNames]", e);
    }
  });

  it("nome atual ('diar.ia.br') existe — resolve na 1a tentativa, sem consultar fallback", async () => {
    const calls: string[] = [];
    // URLSearchParams codifica espaço como '+' (decodeURIComponent não reverte);
    // por isso o matcher usa só o nome entre aspas — o '%27' vira '\'' no decode.
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = decodeURIComponent(String(url));
      if (s.includes("'diar.ia.br'")) {
        calls.push("diar.ia.br");
        return makeDriveResponse({ files: [{ id: "new-folder-id", name: "diar.ia.br", mimeType: "application/vnd.google-apps.folder", modifiedTime: "t" }] });
      }
      if (s.includes("'diar.ia'")) {
        calls.push("diar.ia");
        return makeDriveResponse({ files: [] });
      }
      return makeDriveResponse({ files: [] });
    };
    const result = await driveFindFolderByNames(["diar.ia.br", "diar.ia"], "startups-id");
    assert.deepEqual(result, { id: "new-folder-id", matchedName: "diar.ia.br" });
    assert.deepEqual(calls, ["diar.ia.br"], "não deve consultar o fallback quando o nome atual já resolve");
  });

  it("nome atual ausente, fallback legado ('diar.ia') existe — resolve via fallback (#3573 regressão)", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = decodeURIComponent(String(url));
      // 'diar.ia' (com aspa de fechamento logo após) NÃO é substring de
      // 'diar.ia.br' — a ordem de checagem + a aspa desambiguam.
      if (s.includes("'diar.ia.br'")) return makeDriveResponse({ files: [] });
      if (s.includes("'diar.ia'")) {
        return makeDriveResponse({ files: [{ id: "legacy-folder-id", name: "diar.ia", mimeType: "application/vnd.google-apps.folder", modifiedTime: "t" }] });
      }
      return makeDriveResponse({ files: [] });
    };
    const result = await driveFindFolderByNames(["diar.ia.br", "diar.ia"], "startups-id");
    assert.deepEqual(result, { id: "legacy-folder-id", matchedName: "diar.ia" });
  });

  it("nenhum dos nomes existe — retorna null (nem atual nem fallback encontrados)", async () => {
    globalThis.fetch = async () => makeDriveResponse({ files: [] });
    const result = await driveFindFolderByNames(["diar.ia.br", "diar.ia"], "startups-id");
    assert.equal(result, null);
  });
});
