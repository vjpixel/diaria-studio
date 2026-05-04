import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  isRetryableStatus,
  backoffMs,
  splitFilePath,
  escapeDriveQueryString,
  resolveSubfolder,
  CONVERT_TO_DOC,
  GOOGLE_DOC_MIME,
  pushFile,
  pullFile,
  type DriveCache,
  type SyncResult,
} from "../scripts/drive-sync.ts";

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
    // Restore fetch first (no I/O, always safe).
    globalThis.fetch = originalFetch;
    // Restore creds file in a try/finally so a partial failure can't leave a
    // fake token on disk and corrupt subsequent test runs or production usage.
    try {
      if (prevCredsContent !== null) {
        writeFileSync(CREDS_PATH, prevCredsContent, "utf8");
      } else if (!credsExistedBefore && existsSync(CREDS_PATH)) {
        unlinkSync(CREDS_PATH);
      }
    } catch (restoreErr) {
      // Log but don't swallow — surface so it's visible even if the original
      // test assertion already passed.
      console.error("[drive-sync.test afterEach] failed to restore creds:", restoreErr);
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

// ── Round-trip MD ↔ Google Doc (#327) ────────────────────────────────────────

describe("CONVERT_TO_DOC whitelist (#327)", () => {
  it("contém os 6 arquivos esperados", () => {
    assert.ok(CONVERT_TO_DOC.has("01-categorized.md"));
    assert.ok(CONVERT_TO_DOC.has("02-reviewed.md"));
    assert.ok(CONVERT_TO_DOC.has("03-social.md"));
    assert.ok(CONVERT_TO_DOC.has("01-eia.md"));
    assert.ok(CONVERT_TO_DOC.has("prioritized.md"));
    assert.ok(CONVERT_TO_DOC.has("draft.md"));
  });

  it("não inclui arquivos que NÃO devem virar Doc", () => {
    assert.ok(!CONVERT_TO_DOC.has("platform.config.json"));
    assert.ok(!CONVERT_TO_DOC.has("04-d1-2x1.jpg"));
    assert.ok(!CONVERT_TO_DOC.has("_internal/01-approved.json"));
    assert.ok(!CONVERT_TO_DOC.has("01-eia-A.jpg"));
  });

  it("basenames sem subpath são detectados corretamente (subpath stripped antes)", () => {
    // pushFile usa splitFilePath e verifica CONVERT_TO_DOC.has(basename)
    // garantir que o basename sem subpath está na whitelist
    const { basename } = splitFilePath("02-reviewed.md");
    assert.ok(CONVERT_TO_DOC.has(basename));
  });

  it("arquivos em _internal/ com basename na whitelist NÃO são convertidos (subpath presente)", () => {
    // CONVERT_TO_DOC só converte top-level files. Se o mesmo basename estiver
    // em _internal/, pushFile não deve converter (verificado via subpath != "")
    const { subpath, basename } = splitFilePath("_internal/02-reviewed.md");
    assert.equal(subpath, "_internal");
    // No pushFile: convertToDoc = CONVERT_TO_DOC.has(basename) && !subpath
    // Aqui confirmamos que subpath != "" — o caller decide não converter.
    assert.ok(subpath !== "");
    // basename ainda está na whitelist (isso é o comportamento documentado)
    assert.ok(CONVERT_TO_DOC.has(basename));
  });
});

describe("GOOGLE_DOC_MIME (#327)", () => {
  it("tem o valor correto da MIME type de Google Docs", () => {
    assert.equal(GOOGLE_DOC_MIME, "application/vnd.google-apps.document");
  });
});

describe("CONVERT_TO_DOC × GOOGLE_DOC_MIME — invariante de upload (#327)", () => {
  it("todos os arquivos na whitelist são MDs — nunca imagens ou JSONs", () => {
    for (const filename of CONVERT_TO_DOC) {
      assert.ok(filename.endsWith(".md"),
        `${filename} na CONVERT_TO_DOC deve ser .md — outro tipo não seria convertível para Doc`);
    }
  });

  it("GOOGLE_DOC_MIME é string não-vazia que identifica Google Docs nativos", () => {
    assert.ok(GOOGLE_DOC_MIME.length > 0);
    assert.ok(GOOGLE_DOC_MIME.includes("google-apps.document"));
  });
});

describe("pullFile branch isGoogleDoc (#327)", () => {
  it("cache com drive_mimeType = GOOGLE_DOC_MIME indica que pull usa export endpoint", () => {
    // Verificar a lógica: isGoogleDoc = fileCache.drive_mimeType === GOOGLE_DOC_MIME
    // Testar os dois ramos como unidade pura
    const cacheWithDoc = { drive_mimeType: GOOGLE_DOC_MIME, drive_file_id: "abc", drive_modifiedTime: "" };
    const cacheWithoutDoc = { drive_mimeType: "text/markdown", drive_file_id: "abc", drive_modifiedTime: "" };
    const cacheWithoutField = { drive_file_id: "abc", drive_modifiedTime: "" };

    assert.equal(cacheWithDoc.drive_mimeType === GOOGLE_DOC_MIME, true,
      "arquivo com drive_mimeType=Doc → pull deve usar driveExportFile");
    assert.equal(cacheWithoutDoc.drive_mimeType === GOOGLE_DOC_MIME, false,
      "arquivo com drive_mimeType=markdown → pull deve usar driveDownloadFile");
    assert.equal((cacheWithoutField as { drive_mimeType?: string }).drive_mimeType === GOOGLE_DOC_MIME, false,
      "arquivo sem drive_mimeType → pull usa driveDownloadFile (backwards-compat)");
  });
});

// -- Helpers para testes pushFile/pullFile -----------------------------------

function makeSyncResult(overrides?: Partial<SyncResult>): SyncResult {
  return { mode: "push", stage: 1, edition: "260501",
    day_folder_path: "Work/Startups/diar.ia/edicoes/2605/260501",
    uploaded: [], pulled: [], warnings: [], ...overrides };
}

function makeDriveCache(yymmdd: string, files: DriveCache["editions"][string]["files"] = {}): DriveCache {
  return { editions: { [yymmdd]: { day_folder_id: "day-folder-id", files } } };
}

// -- pushFile - editor-wins check (#496) -------------------------------------

describe("pushFile — editor-wins check (#496)", () => {
  const YYMMDD = "260501";
  const DAY_FOLDER_ID = "day-folder-id";
  const FILE_ID = "drive-file-id-abc";
  const LAST_PUSH_TIME = "2026-05-01T10:00:00.000Z";
  let originalFetch: typeof globalThis.fetch;
  let credsExistedBefore: boolean;
  let prevCredsContent: string | null;
  let tmpDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    credsExistedBefore = existsSync(CREDS_PATH);
    prevCredsContent = credsExistedBefore ? readFileSync(CREDS_PATH, "utf8") : null;
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(CREDS_PATH, JSON.stringify(FAKE_CREDS), "utf8");
    tmpDir = mkdtempSync(join(tmpdir(), "drive-sync-push-"));
    writeFileSync(join(tmpDir, "02-reviewed.md"), "# Test", "utf8");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      if (prevCredsContent !== null) writeFileSync(CREDS_PATH, prevCredsContent, "utf8");
      else if (!credsExistedBefore && existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
    } catch (e) { console.error("[afterEach pushFile]", e); }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("CONFLICT: Drive mais recente que ultimo push — aborta sem upload", async () => {
    const driveNewer = "2026-05-01T12:00:00.000Z";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: LAST_PUSH_TIME, last_pushed_mtime: 0, push_count: 1 } });
    const result = makeSyncResult();
    let uploadCalled = false;
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && !s.includes("upload"))
        return makeDriveResponse({ id: FILE_ID, name: "02-reviewed.md", modifiedTime: driveNewer });
      if (s.includes("/upload/")) { uploadCalled = true; return makeDriveResponse({ id: FILE_ID, modifiedTime: driveNewer, mimeType: "text/markdown" }); }
      return makeDriveResponse({ files: [] });
    };
    await pushFile(tmpDir, "02-reviewed.md", YYMMDD, DAY_FOLDER_ID, cache, result);
    assert.equal(result.warnings.length, 1, "deve emitir 1 CONFLICT warning");
    assert.ok(result.warnings[0].error_message.includes("CONFLICT"),
      "warning deve conter CONFLICT: " + result.warnings[0].error_message);
    assert.equal(result.uploaded.length, 0, "nao deve ter feito upload");
    assert.equal(uploadCalled, false, "nao deve chamar upload endpoint");
  });

  it("sem CONFLICT: Drive com mesmo modifiedTime — faz upload", async () => {
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: LAST_PUSH_TIME, last_pushed_mtime: 0, push_count: 1 } });
    const result = makeSyncResult();
    let uploadCalled = false;
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && !s.includes("upload"))
        return makeDriveResponse({ id: FILE_ID, name: "02-reviewed.md", modifiedTime: LAST_PUSH_TIME });
      if (s.includes("/upload/")) { uploadCalled = true; return makeDriveResponse({ id: FILE_ID, modifiedTime: LAST_PUSH_TIME, mimeType: GOOGLE_DOC_MIME }); }
      return makeDriveResponse({ files: [] });
    };
    await pushFile(tmpDir, "02-reviewed.md", YYMMDD, DAY_FOLDER_ID, cache, result);
    assert.equal(result.warnings.filter((w) => w.error_message.includes("CONFLICT")).length, 0,
      "nao deve emitir CONFLICT");
    assert.equal(uploadCalled, true, "deve ter chamado upload");
  });

  it("sem CONFLICT: Drive com modifiedTime anterior — faz upload", async () => {
    const older = "2026-05-01T09:00:00.000Z";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: LAST_PUSH_TIME, last_pushed_mtime: 0, push_count: 1 } });
    const result = makeSyncResult();
    let uploadCalled = false;
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && !s.includes("upload"))
        return makeDriveResponse({ id: FILE_ID, name: "02-reviewed.md", modifiedTime: older });
      if (s.includes("/upload/")) { uploadCalled = true; return makeDriveResponse({ id: FILE_ID, modifiedTime: older, mimeType: "text/markdown" }); }
      return makeDriveResponse({ files: [] });
    };
    await pushFile(tmpDir, "02-reviewed.md", YYMMDD, DAY_FOLDER_ID, cache, result);
    assert.equal(result.warnings.filter((w) => w.error_message.includes("CONFLICT")).length, 0);
    assert.equal(uploadCalled, true);
  });

  it("primeiro push (sem drive_file_id) — ignora check e cria arquivo", async () => {
    const cache = makeDriveCache(YYMMDD, {});
    const result = makeSyncResult();
    let metaCalled = false, uploadCalled = false;
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && !s.includes("upload")) { metaCalled = true; return makeDriveResponse({ id: FILE_ID, name: "f", modifiedTime: LAST_PUSH_TIME }); }
      if (s.includes("/upload/")) { uploadCalled = true; return makeDriveResponse({ id: "new-id", modifiedTime: LAST_PUSH_TIME, mimeType: GOOGLE_DOC_MIME }); }
      return makeDriveResponse({ files: [] });
    };
    await pushFile(tmpDir, "02-reviewed.md", YYMMDD, DAY_FOLDER_ID, cache, result);
    assert.equal(metaCalled, false, "sem cache: nao deve buscar metadata");
    assert.equal(uploadCalled, true, "deve fazer upload");
  });

  it("apos push bem-sucedido: cache atualizado com novo modifiedTime e last_pushed_mtime", async () => {
    const newTime = "2026-05-01T11:00:00.000Z";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: LAST_PUSH_TIME, last_pushed_mtime: 0, push_count: 1 } });
    const result = makeSyncResult();
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && !s.includes("upload"))
        return makeDriveResponse({ id: FILE_ID, name: "02-reviewed.md", modifiedTime: LAST_PUSH_TIME });
      if (s.includes("/upload/"))
        return makeDriveResponse({ id: FILE_ID, modifiedTime: newTime, mimeType: GOOGLE_DOC_MIME });
      return makeDriveResponse({ files: [] });
    };
    await pushFile(tmpDir, "02-reviewed.md", YYMMDD, DAY_FOLDER_ID, cache, result);
    const fc = cache.editions[YYMMDD].files["02-reviewed.md"];
    assert.ok(fc, "deve ter entrada no cache");
    assert.equal(fc.drive_modifiedTime, newTime, "drive_modifiedTime atualizado");
    assert.ok(fc.last_pushed_mtime > 0, "last_pushed_mtime positivo");
    assert.equal(fc.push_count, 2, "push_count incrementado para 2");
  });
});

// -- pullFile - cache merge e download (#496) ---------------------------------

describe("pullFile — cache merge e atualizacao apos download", () => {
  const YYMMDD = "260501";
  const FILE_ID = "drive-file-id-pull";
  const CACHED_TIME = "2026-05-01T10:00:00.000Z";
  const NEWER_TIME = "2026-05-01T14:00:00.000Z";
  let originalFetch: typeof globalThis.fetch;
  let credsExistedBefore: boolean;
  let prevCredsContent: string | null;
  let tmpDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    credsExistedBefore = existsSync(CREDS_PATH);
    prevCredsContent = credsExistedBefore ? readFileSync(CREDS_PATH, "utf8") : null;
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(CREDS_PATH, JSON.stringify(FAKE_CREDS), "utf8");
    tmpDir = mkdtempSync(join(tmpdir(), "drive-sync-pull-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      if (prevCredsContent !== null) writeFileSync(CREDS_PATH, prevCredsContent, "utf8");
      else if (!credsExistedBefore && existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
    } catch (e) { console.error("[afterEach pullFile]", e); }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("Drive mais recente — baixa arquivo e atualiza cache", async () => {
    const content = "# Pulled content";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: CACHED_TIME,
      last_pushed_mtime: 0, push_count: 1, drive_mimeType: "text/markdown" } });
    const result = makeSyncResult({ mode: "pull" });
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && s.includes("fields=") && !s.includes("alt=media"))
        return makeDriveResponse({ id: FILE_ID, name: "f", modifiedTime: NEWER_TIME });
      if (s.includes("/files/" + FILE_ID) && s.includes("alt=media")) {
        const buf = Buffer.from(content, "utf8");
        return { ok: true, status: 200,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          text: async () => content, json: async () => ({}), headers: { get: () => null } } as unknown as Response;
      }
      return makeDriveResponse({ files: [] });
    };
    await pullFile(tmpDir, "02-reviewed.md", YYMMDD, cache, result);
    const fc = cache.editions[YYMMDD].files["02-reviewed.md"];
    assert.equal(fc.drive_modifiedTime, NEWER_TIME, "cache atualizado com novo modifiedTime");
    assert.ok(fc.last_pushed_mtime > 0, "last_pushed_mtime atualizado");
    assert.equal(result.pulled.length, 1);
    assert.equal(result.pulled[0].drive_modifiedTime, NEWER_TIME);
    assert.equal(result.pulled[0].overwrote_local, true);
    assert.equal(readFileSync(join(tmpDir, "02-reviewed.md"), "utf8"), content);
  });

  it("Drive com mesmo modifiedTime — no-op", async () => {
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: CACHED_TIME,
      last_pushed_mtime: 12345, push_count: 1, drive_mimeType: "text/markdown" } });
    const result = makeSyncResult({ mode: "pull" });
    let dlCalled = false;
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID)) {
        if (s.includes("alt=media")) dlCalled = true;
        return makeDriveResponse({ id: FILE_ID, name: "f", modifiedTime: CACHED_TIME });
      }
      return makeDriveResponse({ files: [] });
    };
    await pullFile(tmpDir, "02-reviewed.md", YYMMDD, cache, result);
    assert.equal(result.pulled.length, 0);
    assert.equal(dlCalled, false, "nao deve baixar");
    assert.equal(cache.editions[YYMMDD].files["02-reviewed.md"].last_pushed_mtime, 12345);
  });

  it("Drive com modifiedTime anterior ao cache — no-op", async () => {
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: CACHED_TIME,
      last_pushed_mtime: 99999, push_count: 1, drive_mimeType: "text/markdown" } });
    const result = makeSyncResult({ mode: "pull" });
    globalThis.fetch = async (url: string | URL | Request) => {
      if (String(url).includes("/files/" + FILE_ID))
        return makeDriveResponse({ id: FILE_ID, name: "f", modifiedTime: "2026-05-01T08:00:00.000Z" });
      return makeDriveResponse({ files: [] });
    };
    await pullFile(tmpDir, "02-reviewed.md", YYMMDD, cache, result);
    assert.equal(result.pulled.length, 0, "drive mais antigo: nao deve baixar");
  });

  it("arquivo sem drive_file_id no cache — no-op silencioso", async () => {
    const cache = makeDriveCache(YYMMDD, {});
    const result = makeSyncResult({ mode: "pull" });
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return makeDriveResponse({ files: [] }); };
    await pullFile(tmpDir, "02-reviewed.md", YYMMDD, cache, result);
    assert.equal(result.pulled.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(fetchCalled, false, "nao deve chamar fetch");
  });

  it("Google Doc no cache — pull usa /export, nao alt=media", async () => {
    const exported = "# Exported from Doc";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: CACHED_TIME,
      last_pushed_mtime: 0, push_count: 1, drive_mimeType: GOOGLE_DOC_MIME } });
    const result = makeSyncResult({ mode: "pull" });
    let exportCalled = false, dlCalled = false;
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && s.includes("fields="))
        return makeDriveResponse({ id: FILE_ID, name: "f", modifiedTime: NEWER_TIME });
      if (s.includes("/files/" + FILE_ID + "/export")) {
        exportCalled = true;
        const buf = Buffer.from(exported, "utf8");
        return { ok: true, status: 200,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          text: async () => exported, json: async () => ({}), headers: { get: () => null } } as unknown as Response;
      }
      if (s.includes("/files/" + FILE_ID) && s.includes("alt=media")) {
        dlCalled = true;
        return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0),
          text: async () => "forbidden", json: async () => ({}), headers: { get: () => null } } as unknown as Response;
      }
      return makeDriveResponse({ files: [] });
    };
    await pullFile(tmpDir, "02-reviewed.md", YYMMDD, cache, result);
    assert.equal(exportCalled, true, "deve usar /export endpoint");
    assert.equal(dlCalled, false, "nao deve usar alt=media");
    assert.equal(result.pulled.length, 1);
    assert.equal(readFileSync(join(tmpDir, "02-reviewed.md"), "utf8"), exported);
  });
});
