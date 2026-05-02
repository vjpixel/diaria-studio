import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { isRetryableStatus, backoffMs, splitFilePath, escapeDriveQueryString, resolveSubfolder } from "../scripts/drive-sync.ts";

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

describe("isRetryableStatus (#121)", () => {
  it("aceita transient HTTP errors comuns do Drive API", () => {
    assert.equal(isRetryableStatus(429), true); // rate limit
    assert.equal(isRetryableStatus(502), true); // bad gateway
    assert.equal(isRetryableStatus(503), true); // service unavailable
    assert.equal(isRetryableStatus(504), true); // gateway timeout
  });

  it("rejeita erros não-transientes — não retentar", () => {
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(201), false);
    assert.equal(isRetryableStatus(400), false); // bad request — config bug, retry não resolve
    assert.equal(isRetryableStatus(401), false); // auth — gFetch base trata refresh
    assert.equal(isRetryableStatus(403), false); // forbidden — permissão fixa
    assert.equal(isRetryableStatus(404), false); // not found
    assert.equal(isRetryableStatus(500), false); // internal — geralmente bug do Drive, não transient
  });

  it("aceita 0 e negativos sem crashar", () => {
    assert.equal(isRetryableStatus(0), false);
    assert.equal(isRetryableStatus(-1), false);
  });
});

describe("backoffMs — exponential com jitter (#121)", () => {
  it("primeira tentativa: 1000ms + jitter (0-250ms)", () => {
    // Random source = 0 → sem jitter
    assert.equal(backoffMs(0, () => 0), 1000);
    // Random source = 1 → jitter máximo
    assert.equal(backoffMs(0, () => 1), 1250);
  });

  it("segunda tentativa: 2000ms + jitter", () => {
    assert.equal(backoffMs(1, () => 0), 2000);
    assert.equal(backoffMs(1, () => 1), 2250);
  });

  it("terceira tentativa: 4000ms + jitter", () => {
    assert.equal(backoffMs(2, () => 0), 4000);
    assert.equal(backoffMs(2, () => 0.5), 4125);
  });

  it("escala exponencialmente (8s, 16s, 32s) — caso extremo", () => {
    assert.equal(backoffMs(3, () => 0), 8000);
    assert.equal(backoffMs(4, () => 0), 16000);
    assert.equal(backoffMs(5, () => 0), 32000);
  });

  it("Math.random é o default", () => {
    // Não deve crashar sem injection
    const result = backoffMs(0);
    assert.ok(result >= 1000 && result <= 1250);
  });
});

describe("splitFilePath (#253)", () => {
  it("filename sem `/`: subpath vazio, basename = filename", () => {
    assert.deepEqual(splitFilePath("02-reviewed.md"), {
      subpath: "",
      basename: "02-reviewed.md",
    });
  });

  it("`_internal/foo.md`: subpath e basename", () => {
    assert.deepEqual(splitFilePath("_internal/02-clarice-diff.md"), {
      subpath: "_internal",
      basename: "02-clarice-diff.md",
    });
  });

  it("subpasta aninhada: split na última barra", () => {
    assert.deepEqual(splitFilePath("_internal/sub/foo.json"), {
      subpath: "_internal/sub",
      basename: "foo.json",
    });
  });

  it("backslashes do Windows são normalizados pra forward slashes", () => {
    assert.deepEqual(splitFilePath("_internal\\foo.md"), {
      subpath: "_internal",
      basename: "foo.md",
    });
  });

  it("filename só com basename + extensão complexa", () => {
    assert.deepEqual(splitFilePath("04-d1-2x1.jpg"), {
      subpath: "",
      basename: "04-d1-2x1.jpg",
    });
  });

  it("não esquenta com filename vazio", () => {
    assert.deepEqual(splitFilePath(""), { subpath: "", basename: "" });
  });
});

describe("escapeDriveQueryString (#282)", () => {
  it("string sem aspas simples passa sem alteração", () => {
    assert.equal(escapeDriveQueryString("01-categorized.md"), "01-categorized.md");
    assert.equal(escapeDriveQueryString("_internal"), "_internal");
  });

  it("aspa simples é escapada como \\'", () => {
    assert.equal(escapeDriveQueryString("it's a test"), "it\\'s a test");
  });

  it("múltiplas aspas simples são todas escapadas", () => {
    assert.equal(escapeDriveQueryString("it's 'fine'"), "it\\'s \\'fine\\'");
  });

  it("backslash é escapado primeiro (defesa contra double-escape)", () => {
    assert.equal(escapeDriveQueryString("foo\\bar"), "foo\\\\bar");
  });

  it("string vazia passa sem alteração", () => {
    assert.equal(escapeDriveQueryString(""), "");
  });
});

describe("resolveSubfolder (#281)", () => {
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
    if (prevCredsContent !== null) {
      writeFileSync(CREDS_PATH, prevCredsContent, "utf8");
    } else if (!credsExistedBefore && existsSync(CREDS_PATH)) {
      unlinkSync(CREDS_PATH);
    }
  });

  function makeCache(yymmdd: string, dayFolderId = "day-folder-id"): {
    cache: { editions: Record<string, { day_folder_id: string; files: Record<string, unknown>; subfolder_ids?: Record<string, string> }> };
    yymmdd: string;
    dayFolderId: string;
  } {
    return {
      cache: { editions: { [yymmdd]: { day_folder_id: dayFolderId, files: {} } } },
      yymmdd,
      dayFolderId,
    };
  }

  it("subpath simples '_internal' — cria pasta e cacheia em subfolder_ids", async () => {
    const { cache, yymmdd, dayFolderId } = makeCache("260428");
    let listCalled = false;
    let createCalled = false;
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/files?") && urlStr.includes("_internal")) {
        listCalled = true;
        return makeDriveResponse({ files: [] }); // not found → create
      }
      if (urlStr.includes("/files") && opts?.method === "POST") {
        createCalled = true;
        return makeDriveResponse({ id: "new-internal-id" });
      }
      return makeDriveResponse({ files: [] });
    };
    const id = await resolveSubfolder(cache as any, yymmdd, dayFolderId, "_internal");
    assert.equal(id, "new-internal-id");
    assert.equal(cache.editions[yymmdd].subfolder_ids?.["_internal"], "new-internal-id");
    assert.ok(listCalled, "should call Drive list");
    assert.ok(createCalled, "should call Drive create");
  });

  it("subpath aninhado '_internal/sub' — cria _internal depois sub dentro", async () => {
    const { cache, yymmdd, dayFolderId } = makeCache("260428");
    const callLog: string[] = [];
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/files?")) {
        if (urlStr.includes("_internal")) callLog.push("list:_internal");
        else if (urlStr.includes("sub")) callLog.push("list:sub");
        return makeDriveResponse({ files: [] });
      }
      if (urlStr.includes("/files") && opts?.method === "POST") {
        const body = JSON.parse(String(opts.body ?? "{}"));
        callLog.push(`create:${body.name}`);
        return makeDriveResponse({ id: `id-${body.name}` });
      }
      return makeDriveResponse({ files: [] });
    };
    const id = await resolveSubfolder(cache as any, yymmdd, dayFolderId, "_internal/sub");
    assert.equal(id, "id-sub");
    assert.equal(cache.editions[yymmdd].subfolder_ids?.["_internal"], "id-_internal");
    assert.equal(cache.editions[yymmdd].subfolder_ids?.["_internal/sub"], "id-sub");
    assert.ok(callLog.includes("create:_internal"), "deve criar _internal");
    assert.ok(callLog.includes("create:sub"), "deve criar sub");
  });

  it("cache hit — não recria pasta, reusa ID cacheado", async () => {
    const { cache, yymmdd, dayFolderId } = makeCache("260428");
    cache.editions[yymmdd].subfolder_ids = { "_internal": "cached-id" };
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return makeDriveResponse({ files: [] });
    };
    const id = await resolveSubfolder(cache as any, yymmdd, dayFolderId, "_internal");
    assert.equal(id, "cached-id");
    assert.equal(fetchCallCount, 0, "não deve chamar fetch quando cache hit");
  });
});
