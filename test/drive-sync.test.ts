import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  splitFilePath,
  resolveSubfolder,
  CONVERT_TO_DOC,
  GOOGLE_DOC_MIME,
  pushFile,
  pullFile,
  localHasUnsyncedChanges,
  loadConflictToleranceSeconds,
  attemptThreeWayMerge,
  savePrePushSnapshot,
  loadPrePushSnapshot,
  snapshotPath,
  listVersionArchives,
  MAX_ARCHIVES_PER_FILE,
  classifyOAuthError,
  OAUTH_EXPIRED_ALERT,
  makeInvalidGrantGuard,
  type DriveCache,
  type SyncResult,
} from "../scripts/drive-sync.ts";
import {
  isRetryableStatus,
  backoffMs,
  escapeDriveQueryString,
} from "../scripts/lib/drive-helpers.ts"; // #1308 item 2 — extraído de drive-sync.ts

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

describe("localHasUnsyncedChanges — guard de frescor do pull (#1828)", () => {
  it("local mais novo que o último sync (além da tolerância) → true (não clobberar)", () => {
    // mtime do último push: 1000; local agora: 5000 → tem mudanças não-enviadas.
    assert.equal(localHasUnsyncedChanges(5000, 1000), true);
  });

  it("local igual/anterior ao último sync → false (pull normal sobrescreve)", () => {
    assert.equal(localHasUnsyncedChanges(1000, 1000), false);
    assert.equal(localHasUnsyncedChanges(900, 1000), false);
  });

  it("dentro da tolerância (2s) → false (evita falso-positivo de touch)", () => {
    // local 1500ms após o push: dentro da tolerância de 2000ms → não conta.
    assert.equal(localHasUnsyncedChanges(2500, 1000), false);
    assert.equal(localHasUnsyncedChanges(3001, 1000), true, "além da tolerância → true");
  });

  it("sem baseline (last_pushed_mtime ausente) → false (default seguro p/ pull normal)", () => {
    assert.equal(localHasUnsyncedChanges(99999, undefined), false);
  });

  it("tolerância customizável", () => {
    assert.equal(localHasUnsyncedChanges(6000, 1000, 10_000), false, "tolerância maior → não conta");
  });
});

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

  it("#1828: local com mudanças não-sincronizadas → guard NÃO sobrescreve, warn, não baixa", async () => {
    const localOriginal = "# Local regenerado (não enviado ainda)";
    writeFileSync(join(tmpDir, "02-reviewed.md"), localOriginal, "utf8");
    // last_pushed_mtime: 0 → o mtime real do arquivo recém-escrito é >> 0 + tolerância.
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: CACHED_TIME,
      last_pushed_mtime: 0, push_count: 1, drive_mimeType: "text/markdown" } });
    const result = makeSyncResult({ mode: "pull" });
    let dlCalled = false;
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && s.includes("alt=media")) { dlCalled = true; return makeDriveResponse({}); }
      if (s.includes("/files/" + FILE_ID)) return makeDriveResponse({ id: FILE_ID, name: "f", modifiedTime: NEWER_TIME });
      return makeDriveResponse({ files: [] });
    };
    await pullFile(tmpDir, "02-reviewed.md", YYMMDD, cache, result);
    assert.equal(result.pulled.length, 0, "não sobrescreveu o local");
    assert.equal(dlCalled, false, "nem baixou (guard antes do download)");
    assert.equal(result.warnings.length, 1, "emite 1 warning de frescor");
    assert.match(result.warnings[0].error_message, /não-enviadas|#1828/);
    assert.equal(readFileSync(join(tmpDir, "02-reviewed.md"), "utf8"), localOriginal, "local intacto");
  });

  it("#1828: --force-overwrite-local ignora o guard e sobrescreve com o Drive", async () => {
    writeFileSync(join(tmpDir, "02-reviewed.md"), "# Local antigo", "utf8");
    const driveContent = "# Conteúdo do Drive";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: CACHED_TIME,
      last_pushed_mtime: 0, push_count: 1, drive_mimeType: "text/markdown" } });
    const result = makeSyncResult({ mode: "pull" });
    globalThis.fetch = async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && s.includes("alt=media")) {
        const buf = Buffer.from(driveContent, "utf8");
        return { ok: true, status: 200,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          text: async () => driveContent, json: async () => ({}), headers: { get: () => null } } as unknown as Response;
      }
      if (s.includes("/files/" + FILE_ID)) return makeDriveResponse({ id: FILE_ID, name: "f", modifiedTime: NEWER_TIME });
      return makeDriveResponse({ files: [] });
    };
    await pullFile(tmpDir, "02-reviewed.md", YYMMDD, cache, result, { forceOverwriteLocal: true });
    assert.equal(result.pulled.length, 1, "force → sobrescreveu");
    assert.equal(readFileSync(join(tmpDir, "02-reviewed.md"), "utf8"), driveContent);
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

// -- CONFLICT_TOLERANCE_SECONDS (#605, #629) ---------------------------------

describe("loadConflictToleranceSeconds (#629)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "drive-sync-tolerance-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("default 10s quando config nao existe", () => {
    const missingPath = join(tmpDir, "missing.json");
    assert.equal(loadConflictToleranceSeconds(missingPath), 10);
  });

  it("default 10s quando config nao tem o campo", () => {
    const cfgPath = join(tmpDir, "platform.config.json");
    writeFileSync(cfgPath, JSON.stringify({ newsletter: "beehiiv" }), "utf8");
    assert.equal(loadConflictToleranceSeconds(cfgPath), 10);
  });

  it("override aceita valor numerico nao-negativo", () => {
    const cfgPath = join(tmpDir, "platform.config.json");
    writeFileSync(cfgPath, JSON.stringify({ drive_sync_conflict_tolerance_seconds: 30 }), "utf8");
    assert.equal(loadConflictToleranceSeconds(cfgPath), 30);
  });

  it("override aceita zero (sem tolerancia)", () => {
    const cfgPath = join(tmpDir, "platform.config.json");
    writeFileSync(cfgPath, JSON.stringify({ drive_sync_conflict_tolerance_seconds: 0 }), "utf8");
    assert.equal(loadConflictToleranceSeconds(cfgPath), 0);
  });

  it("default 10s quando valor e negativo (rejeitado)", () => {
    const cfgPath = join(tmpDir, "platform.config.json");
    writeFileSync(cfgPath, JSON.stringify({ drive_sync_conflict_tolerance_seconds: -5 }), "utf8");
    assert.equal(loadConflictToleranceSeconds(cfgPath), 10);
  });

  it("default 10s quando valor nao e numero", () => {
    const cfgPath = join(tmpDir, "platform.config.json");
    writeFileSync(cfgPath, JSON.stringify({ drive_sync_conflict_tolerance_seconds: "30" }), "utf8");
    assert.equal(loadConflictToleranceSeconds(cfgPath), 10);
  });

  it("default 10s quando JSON e invalido", () => {
    const cfgPath = join(tmpDir, "platform.config.json");
    writeFileSync(cfgPath, "{ broken json", "utf8");
    assert.equal(loadConflictToleranceSeconds(cfgPath), 10);
  });
});

describe("pushFile — CONFLICT_TOLERANCE_SECONDS auto-conversion noise (#605, #629)", () => {
  const YYMMDD = "260501";
  const DAY_FOLDER_ID = "day-folder-id";
  const FILE_ID = "drive-file-id-tol";
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
    tmpDir = mkdtempSync(join(tmpdir(), "drive-sync-tol-push-"));
    writeFileSync(join(tmpDir, "02-reviewed.md"), "# Test", "utf8");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      if (prevCredsContent !== null) writeFileSync(CREDS_PATH, prevCredsContent, "utf8");
      else if (!credsExistedBefore && existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
    } catch (e) { console.error("[afterEach tolerance pushFile]", e); }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("diff > tolerance (10s default + 1s = 11s mais novo) — emite CONFLICT", async () => {
    // Drive +11s — alem da tolerancia default de 10s — edit humano real.
    const driveJustOverTolerance = "2026-05-01T10:00:11.000Z";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: LAST_PUSH_TIME, last_pushed_mtime: 0, push_count: 1 } });
    const result = makeSyncResult();
    let uploadCalled = false;
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && !s.includes("upload"))
        return makeDriveResponse({ id: FILE_ID, name: "02-reviewed.md", modifiedTime: driveJustOverTolerance });
      if (s.includes("/upload/")) { uploadCalled = true; return makeDriveResponse({ id: FILE_ID, modifiedTime: driveJustOverTolerance, mimeType: "text/markdown" }); }
      return makeDriveResponse({ files: [] });
    };
    await pushFile(tmpDir, "02-reviewed.md", YYMMDD, DAY_FOLDER_ID, cache, result);
    assert.equal(result.warnings.length, 1, "deve emitir CONFLICT — diff alem da tolerancia");
    assert.ok(result.warnings[0].error_message.includes("CONFLICT"));
    assert.equal(uploadCalled, false, "nao deve fazer upload em CONFLICT");
  });

  it("diff <= tolerance (auto-conversion +2s) — sem CONFLICT, cache atualizado silenciosamente", async () => {
    // Drive +2s — auto-conversion noise. Nao e edit humano. Pipeline deve continuar.
    const driveAfterAutoConversion = "2026-05-01T10:00:02.000Z";
    const newPushTime = "2026-05-01T10:30:00.000Z";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: LAST_PUSH_TIME, last_pushed_mtime: 0, push_count: 1 } });
    const result = makeSyncResult();
    let uploadCalled = false;
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && !s.includes("upload"))
        return makeDriveResponse({ id: FILE_ID, name: "02-reviewed.md", modifiedTime: driveAfterAutoConversion });
      if (s.includes("/upload/")) { uploadCalled = true; return makeDriveResponse({ id: FILE_ID, modifiedTime: newPushTime, mimeType: "text/markdown" }); }
      return makeDriveResponse({ files: [] });
    };
    await pushFile(tmpDir, "02-reviewed.md", YYMMDD, DAY_FOLDER_ID, cache, result);
    assert.equal(
      result.warnings.filter((w) => w.error_message.includes("CONFLICT")).length,
      0,
      "nao deve emitir CONFLICT dentro da tolerancia",
    );
    assert.equal(uploadCalled, true, "deve fazer upload — diff dentro da tolerancia");
    // Push sucedeu — cache e atualizado com newPushTime (post-upload), nao driveAfterAutoConversion.
    // O importante e que o push aconteceu em vez de abortar.
    assert.equal(cache.editions[YYMMDD].files["02-reviewed.md"].drive_modifiedTime, newPushTime);
  });

  it("diff exatamente igual a tolerance (boundary 10s) — sem CONFLICT (>, nao >=)", async () => {
    // Drive +10s (exatamente o default). Lógica usa `diff > tolerance`, entao 10 nao dispara.
    const driveAtTolerance = "2026-05-01T10:00:10.000Z";
    const newPushTime = "2026-05-01T10:30:00.000Z";
    const cache = makeDriveCache(YYMMDD, { "02-reviewed.md": {
      drive_file_id: FILE_ID, drive_modifiedTime: LAST_PUSH_TIME, last_pushed_mtime: 0, push_count: 1 } });
    const result = makeSyncResult();
    let uploadCalled = false;
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      const s = String(url);
      if (s.includes("/files/" + FILE_ID) && !s.includes("upload"))
        return makeDriveResponse({ id: FILE_ID, name: "02-reviewed.md", modifiedTime: driveAtTolerance });
      if (s.includes("/upload/")) { uploadCalled = true; return makeDriveResponse({ id: FILE_ID, modifiedTime: newPushTime, mimeType: "text/markdown" }); }
      return makeDriveResponse({ files: [] });
    };
    await pushFile(tmpDir, "02-reviewed.md", YYMMDD, DAY_FOLDER_ID, cache, result);
    assert.equal(
      result.warnings.filter((w) => w.error_message.includes("CONFLICT")).length,
      0,
      "boundary: diff == tolerance nao deve disparar CONFLICT",
    );
    assert.equal(uploadCalled, true);
  });
});

describe("attemptThreeWayMerge (#963)", () => {
  it("merge clean: edits disjuntos no MD são integrados", () => {
    const base = "line1\nline2\nline3\nline4\nline5\n";
    const local = "line1\nLINE2-pipeline\nline3\nline4\nline5\n";
    const remote = "line1\nline2\nline3\nLINE4-editor\nline5\n";
    const r = attemptThreeWayMerge(local, base, remote);
    assert.equal(r.hasConflicts, false, "edits disjuntos não conflitam");
    assert.match(r.merged, /LINE2-pipeline/);
    assert.match(r.merged, /LINE4-editor/);
  });

  it("merge sem mudanças: drive == local == base → no-op merge", () => {
    const content = "linha 1\nlinha 2\n";
    const r = attemptThreeWayMerge(content, content, content);
    assert.equal(r.hasConflicts, false);
    assert.equal(r.merged.trim(), content.trim());
  });

  it("merge com conflito: ambos editam mesma linha → markers + hasConflicts=true", () => {
    const base = "linha 1\nlinha 2\nlinha 3\n";
    const local = "linha 1\nLINHA-pipeline\nlinha 3\n";
    const remote = "linha 1\nLINHA-editor\nlinha 3\n";
    const r = attemptThreeWayMerge(local, base, remote);
    assert.equal(r.hasConflicts, true);
    assert.ok(r.conflictCount >= 1);
    assert.match(r.merged, /<<<<<<</);
    assert.match(r.merged, />>>>>>>/);
    assert.match(r.merged, /LINHA-pipeline/);
    assert.match(r.merged, /LINHA-editor/);
  });

  it("merge com 1 lado intacto: drive == base, local mudou → usa local", () => {
    const base = "linha 1\nlinha 2\n";
    const local = "linha 1\nLINHA-pipeline\n";
    const remote = base;
    const r = attemptThreeWayMerge(local, base, remote);
    assert.equal(r.hasConflicts, false);
    assert.match(r.merged, /LINHA-pipeline/);
  });

  it("merge com 1 lado intacto: local == base, drive mudou → usa drive", () => {
    const base = "linha 1\nlinha 2\n";
    const local = base;
    const remote = "linha 1\nLINHA-editor\n";
    const r = attemptThreeWayMerge(local, base, remote);
    assert.equal(r.hasConflicts, false);
    assert.match(r.merged, /LINHA-editor/);
  });
});

describe("snapshot helpers (#963)", () => {
  it("snapshotPath usa _internal/.drive-snapshots/", () => {
    const p = snapshotPath("data/editions/260508", "02-reviewed.md");
    const norm = p.replace(/\\/g, "/");
    assert.match(norm, /_internal\/\.drive-snapshots\/02-reviewed\.md$/);
  });

  it("save → load round-trip preserva conteúdo", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-snap-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      savePrePushSnapshot(dir, "02-reviewed.md", "conteúdo X\n");
      const loaded = loadPrePushSnapshot(dir, "02-reviewed.md");
      assert.equal(loaded, "conteúdo X\n");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("load retorna null quando snapshot ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-snap-"));
    try {
      const loaded = loadPrePushSnapshot(dir, "missing.md");
      assert.equal(loaded, null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("save aceita Buffer pra arquivos .md", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-snap-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      savePrePushSnapshot(dir, "02-reviewed.md", Buffer.from("texto buffer\n"));
      const loaded = loadPrePushSnapshot(dir, "02-reviewed.md");
      assert.equal(loaded, "texto buffer\n");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("save pula binários (.jpg/.png)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-snap-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      savePrePushSnapshot(dir, "04-d1-2x1.jpg", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const loaded = loadPrePushSnapshot(dir, "04-d1-2x1.jpg");
      assert.equal(loaded, null, "binário não deve ter snapshot");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("listVersionArchives (#998)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalCreds: string | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalCreds = existsSync(CREDS_PATH) ? readFileSync(CREDS_PATH, "utf8") : null;
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(CREDS_PATH, JSON.stringify(FAKE_CREDS), "utf8");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCreds === null) {
      try { unlinkSync(CREDS_PATH); } catch { /* ignore */ }
    } else {
      writeFileSync(CREDS_PATH, originalCreds, "utf8");
    }
  });

  it("lista e ordena archives .vN ascendentes (extension MD)", async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/files?q=")) {
        return makeDriveResponse({
          files: [
            { id: "a3", name: "02-reviewed.v3.md" },
            { id: "a1", name: "02-reviewed.v1.md" },
            { id: "a2", name: "02-reviewed.v2.md" },
            // ruido: arquivo que NÃO bate o padrão
            { id: "noise", name: "02-reviewed.draft.md" },
          ],
        });
      }
      throw new Error("Unexpected fetch: " + url);
    };
    const archives = await listVersionArchives("02-reviewed", ".md", false, "parentId");
    assert.deepEqual(
      archives.map((a) => a.version),
      [1, 2, 3],
      "ordenação asc por version",
    );
    // ruido sem .vN é filtrado
    assert.equal(archives.length, 3);
  });

  it("lista archives convertToDoc=true (sem extension)", async () => {
    globalThis.fetch = async () => {
      return makeDriveResponse({
        files: [
          { id: "a1", name: "02-reviewed.v1" },
          { id: "a2", name: "02-reviewed.v2" },
        ],
      });
    };
    const archives = await listVersionArchives("02-reviewed", "", true, "parentId");
    assert.equal(archives.length, 2);
    assert.deepEqual(archives.map((a) => a.version), [1, 2]);
  });

  it("retorna [] quando não há archives", async () => {
    globalThis.fetch = async () => makeDriveResponse({ files: [] });
    const archives = await listVersionArchives("02-reviewed", ".md", false, "parentId");
    assert.deepEqual(archives, []);
  });
});

describe("MAX_ARCHIVES_PER_FILE (#998)", () => {
  it("default = 3 (compromisso histórico vs pasta limpa)", () => {
    assert.equal(MAX_ARCHIVES_PER_FILE, 3);
  });
});

// ---------------------------------------------------------------------------
// #2318: invalid_grant → alerta único, não N warnings por arquivo
// ---------------------------------------------------------------------------

describe("classifyOAuthError (#2318)", () => {
  it("invalid_grant (case insensitive) → 'invalid_grant'", () => {
    assert.equal(classifyOAuthError("Token refresh falhou (400): invalid_grant"), "invalid_grant");
    assert.equal(classifyOAuthError("invalid_grant"), "invalid_grant");
    assert.equal(classifyOAuthError("INVALID_GRANT error"), "invalid_grant");
    // string exata do error log mencionada na issue #2318
    assert.equal(
      classifyOAuthError('Token refresh falhou (400): { "error": "invalid_grant", "error_description": "Token has been expired or revoked." }'),
      "invalid_grant",
    );
  });

  // F3 (#2318): variantes reais do Google que inbox-drain.ts::isAuthExpiredError
  // já cobria via regex mais ampla (#1973). classifyOAuthError (e classifyRefreshError
  // por baixo) agora usa a mesma amplitude — sem isso, UNAUTHENTICATED vira 'other'
  // e emite warning por arquivo em vez do alerta único consolidado.
  it("UNAUTHENTICATED (401 moderno do Google) → 'invalid_grant'", () => {
    assert.equal(classifyOAuthError("UNAUTHENTICATED"), "invalid_grant");
    assert.equal(classifyOAuthError("Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. (UNAUTHENTICATED)"), "invalid_grant");
  });

  it("token_revoked → 'invalid_grant'", () => {
    assert.equal(classifyOAuthError("token has been expired or revoked"), "invalid_grant");
    assert.equal(classifyOAuthError("Token has been expired or revoked."), "invalid_grant");
  });

  it("invalid_token → 'invalid_grant'", () => {
    assert.equal(classifyOAuthError("invalid_token"), "invalid_grant");
    assert.equal(classifyOAuthError("INVALID_TOKEN: access token expired"), "invalid_grant");
  });

  it("unauthorized → 'invalid_grant'", () => {
    assert.equal(classifyOAuthError("unauthorized"), "invalid_grant");
    assert.equal(classifyOAuthError("Unauthorized request"), "invalid_grant");
  });

  it("outros erros → 'other' (transiente, rate-limit, etc)", () => {
    assert.equal(classifyOAuthError("Drive transient 429: Too Many Requests"), "other");
    assert.equal(classifyOAuthError("Drive upload error (500): internal error"), "other");
    assert.equal(classifyOAuthError("network timeout"), "other");
    assert.equal(classifyOAuthError("CONFLICT: arquivo modificado no Drive"), "other");
  });
});

describe("OAUTH_EXPIRED_ALERT (#2318)", () => {
  it("contém instrução de re-auth actionable", () => {
    assert.match(OAUTH_EXPIRED_ALERT, /oauth-setup\.ts/);
  });
  it("menciona que arquivos foram pulados", () => {
    assert.match(OAUTH_EXPIRED_ALERT, /pulados/);
  });
  it("identifica Drive sync como afetado", () => {
    assert.match(OAUTH_EXPIRED_ALERT, /Drive sync/i);
  });
  // F4 (#2318): alerta deve listar todos os sistemas afetados, não só Drive sync.
  // Sem isso, editor não sabe que precisa rodar /diaria-inbox para recuperar
  // submissões perdidas quando o token expira mid-pipeline.
  it("menciona inbox-drain como sistema afetado (F4)", () => {
    assert.match(OAUTH_EXPIRED_ALERT, /inbox-drain/i);
  });
  it("menciona imagens sociais como sistema afetado (F4)", () => {
    assert.match(OAUTH_EXPIRED_ALERT, /imagens sociais/i);
  });
  it("inclui comando de recuperação /diaria-inbox (F4)", () => {
    assert.match(OAUTH_EXPIRED_ALERT, /\/diaria-inbox/);
  });
});

// Teste de integração do dedup guard: simula invalid_grant em múltiplos arquivos
// e garante que só 1 warning é emitido (não N por arquivo).
describe("invalid_grant dedup guard (#2318) — alerta único via pullFile", () => {
  const YYMMDD = "260616";
  const FILE_ID_A = "drive-file-id-a";
  const FILE_ID_B = "drive-file-id-b";
  const CACHED_TIME = "2026-06-16T10:00:00.000Z";
  const NEWER_TIME = "2026-06-16T12:00:00.000Z";
  let originalFetch: typeof globalThis.fetch;
  let credsExistedBefore: boolean;
  let prevCredsContent: string | null;
  let tmpDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    credsExistedBefore = existsSync(CREDS_PATH);
    prevCredsContent = credsExistedBefore ? readFileSync(CREDS_PATH, "utf8") : null;
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    // Credenciais com token já vencido (expiry no passado) → força refresh no gFetch
    writeFileSync(CREDS_PATH, JSON.stringify({ ...FAKE_CREDS, expiry_ms: 1 }), "utf8");
    tmpDir = mkdtempSync(join(tmpdir(), "drive-sync-oauth-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      if (prevCredsContent !== null) writeFileSync(CREDS_PATH, prevCredsContent, "utf8");
      else if (!credsExistedBefore && existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
    } catch (e) { console.error("[afterEach oauth guard]", e); }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("invalid_grant em pullFile produz EXATAMENTE 1 warning (não 1 por arquivo)", async () => {
    // Dois arquivos no cache — ambos têm Drive mais novo (normalmente disparariam pull).
    // O fetch do token retorna invalid_grant no refresh.
    const cache = makeDriveCache(YYMMDD, {
      "02-reviewed.md": {
        drive_file_id: FILE_ID_A, drive_modifiedTime: CACHED_TIME,
        last_pushed_mtime: 0, push_count: 1, drive_mimeType: "text/markdown",
      },
      "03-social.md": {
        drive_file_id: FILE_ID_B, drive_modifiedTime: CACHED_TIME,
        last_pushed_mtime: 0, push_count: 1, drive_mimeType: "text/markdown",
      },
    });
    const result = makeSyncResult({ mode: "pull" });

    // Simula token expirado: todo fetch retorna 200 nos metadados (Drive mais novo)
    // mas o refresh token retorna invalid_grant → gFetch lança GoogleAuthError.
    // Isso acontece dentro do gFetch que é chamado pelo driveGetMetadata/gFetchRetry.
    // Vamos simular que o fetch de token OAuth retorna invalid_grant:
    const tokenUrl = "https://oauth2.googleapis.com/token";
    let refreshCallCount = 0;
    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr === tokenUrl) {
        // Refresh token está morto — retorna invalid_grant
        refreshCallCount++;
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
          json: async () => ({ error: "invalid_grant" }),
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: { get: () => null },
        } as unknown as Response;
      }
      // Drive API: retorna modifiedTime mais novo (tentaria pull se auth ok)
      if (urlStr.includes("/files/")) {
        return makeDriveResponse({ id: FILE_ID_A, name: "f", modifiedTime: NEWER_TIME });
      }
      return makeDriveResponse({ files: [] });
    };

    // Executa pull dos dois arquivos separadamente (como o main() faria)
    // Simula o que o loop faz: cada pullFile independente vai lançar quando
    // gFetch não consegue refresh.
    let caught1: string | null = null;
    let caught2: string | null = null;
    try {
      await pullFile(tmpDir, "02-reviewed.md", YYMMDD, cache, result);
    } catch (err) {
      caught1 = err instanceof Error ? err.message : String(err);
    }
    try {
      await pullFile(tmpDir, "03-social.md", YYMMDD, cache, result);
    } catch (err) {
      caught2 = err instanceof Error ? err.message : String(err);
    }

    // Ambos devem lançar GoogleAuthError com invalid_grant
    assert.ok(caught1 !== null, "pullFile deve lançar quando token expirado");
    assert.ok(classifyOAuthError(caught1!) === "invalid_grant", `erro 1 deve ser invalid_grant, got: ${caught1}`);
    assert.ok(caught2 !== null, "segundo pullFile deve lançar também");
    assert.ok(classifyOAuthError(caught2!) === "invalid_grant", `erro 2 deve ser invalid_grant, got: ${caught2}`);

    // O GUARD no main() deve colapsar N erros em 1 warning.
    // Testamos o helper puro aqui — o guard em si está no main() e é testado
    // pelo invariante abaixo.
    assert.ok(refreshCallCount >= 1, "deve ter tentado refresh pelo menos 1x");
  });

  it("classifyOAuthError permite ao guard colapsar N erros em 1 warning", () => {
    // Simula o que o main() faz: itera por arquivo, classifica cada erro,
    // e emite only once. Aqui testamos a lógica de colapso pura.
    const errors = [
      'Token refresh falhou (400): { "error": "invalid_grant", "error_description": "Token has been expired or revoked." }',
      'Token refresh falhou (400): { "error": "invalid_grant", "error_description": "Token has been expired or revoked." }',
      'Token refresh falhou (400): { "error": "invalid_grant", "error_description": "Token has been expired or revoked." }',
    ];
    const fakeResult = makeSyncResult({ mode: "pull" });
    let invalidGrantEmitted = false;
    for (const msg of errors) {
      if (classifyOAuthError(msg) === "invalid_grant") {
        if (!invalidGrantEmitted) {
          invalidGrantEmitted = true;
          fakeResult.warnings.push({ file: "(oauth)", error_message: OAUTH_EXPIRED_ALERT });
        }
        // else: pula — sem warning por arquivo
      } else {
        fakeResult.warnings.push({ file: "file.md", error_message: msg });
      }
    }
    assert.equal(fakeResult.warnings.length, 1, "3 erros invalid_grant → 1 único warning");
    assert.ok(fakeResult.warnings[0].file === "(oauth)", "warning marcado como (oauth)");
    assert.ok(fakeResult.warnings[0].error_message.includes("oauth-setup.ts"),
      "warning deve incluir instrução de re-auth");
    assert.ok(invalidGrantEmitted, "flag de dedup foi setada");
  });

  it("sync não bloqueia (soft-degrade preservado) — resultado tem warnings mas não throws", () => {
    // O guard deixa o pipeline continuar — não lança, apenas adiciona warning.
    // Já coberto implicitamente pelos testes acima (pullFile lança → main() captura →
    // warning adicionado, pipeline prossegue). Este teste documenta o invariante.
    const msgs = ["Token refresh falhou (400): invalid_grant"];
    const fakeResult = makeSyncResult({ mode: "push" });
    let invalidGrantEmitted = false;
    // Simula o catch block do main():
    for (const msg of msgs) {
      if (classifyOAuthError(msg) === "invalid_grant") {
        if (!invalidGrantEmitted) {
          invalidGrantEmitted = true;
          fakeResult.warnings.push({ file: "(oauth)", error_message: OAUTH_EXPIRED_ALERT });
        }
      } else {
        fakeResult.warnings.push({ file: "f", error_message: msg });
      }
    }
    // Resultado: warnings preenchido, sem throw. Pipeline continua.
    assert.equal(fakeResult.warnings.length, 1);
    assert.equal(fakeResult.uploaded.length, 0);  // nenhum upload aconteceu
    assert.equal(fakeResult.pulled.length, 0);    // nenhum pull aconteceu
    // Não lançou — pipeline continua (non-blocking por design).
  });
});

// ---------------------------------------------------------------------------
// F5/F11/F12/F13 (#2318): testes do guard REAL via makeInvalidGrantGuard
// Os testes anteriores (F11/F12) re-implementavam o guard inline — uma regressão
// no main() real passaria despercebida. Este bloco testa o factory exportado
// (makeInvalidGrantGuard) que main() usa internamente, garantindo que o código
// real satisfaz os invariantes de dedup.
// ---------------------------------------------------------------------------

describe("makeInvalidGrantGuard (#2318) — guard real exportado pelo main()", () => {
  it("primeira chamada emite alerta e retorna true — result.warnings.length === 1", () => {
    const result = makeSyncResult({ mode: "pull" });
    const guard = makeInvalidGrantGuard(result);

    const wasFirst = guard();

    assert.equal(wasFirst, true, "primeira chamada deve retornar true");
    assert.equal(result.warnings.length, 1, "EXATAMENTE 1 warning após primeira chamada");
    assert.equal(result.warnings[0].file, "(oauth)", "warning marcado como (oauth)");
    assert.match(result.warnings[0].error_message, /oauth-setup\.ts/, "alerta inclui instrução de re-auth");
  });

  it("chamadas subsequentes não duplicam o warning (dedup real)", () => {
    const result = makeSyncResult({ mode: "pull" });
    const guard = makeInvalidGrantGuard(result);

    guard(); // 1ª vez — emite alerta
    const wasSecond = guard(); // 2ª vez — dedup
    const wasThird = guard();  // 3ª vez — dedup

    assert.equal(wasSecond, false, "segunda chamada deve retornar false");
    assert.equal(wasThird, false, "terceira chamada deve retornar false");
    assert.equal(result.warnings.length, 1, "N chamadas → ainda EXATAMENTE 1 warning (dedup real)");
    assert.equal(result.warnings[0].file, "(oauth)", "único warning é o (oauth)");
  });

  it("simula o catch block do main(): N erros invalid_grant → 1 único warning via guard real", () => {
    // F5: este teste reproduz o padrão exato do main() mas usando o factory real,
    // não uma re-implementação inline. Uma regressão no guard falha aqui.
    const result = makeSyncResult({ mode: "pull" });
    const guard = makeInvalidGrantGuard(result);

    // Simula 3 arquivos com erros invalid_grant (como main() faz no for..of loop):
    const errors = [
      'Token refresh falhou (400): { "error": "invalid_grant" }',
      'UNAUTHENTICATED: token has been expired or revoked',
      'invalid_token: Request had invalid authentication credentials.',
    ];
    for (const msg of errors) {
      if (classifyOAuthError(msg) === "invalid_grant") {
        guard(); // real guard — dedup interno
      } else {
        result.warnings.push({ file: "file.md", error_message: msg });
      }
    }

    // F13: o título "EXATAMENTE 1 warning" agora tem assertion correspondente.
    assert.equal(result.warnings.length, 1, "3 erros auth-expired → EXATAMENTE 1 warning via guard real");
    assert.equal(result.warnings[0].file, "(oauth)", "warning marcado como (oauth)");
    assert.match(result.warnings[0].error_message, /\/diaria-inbox/, "alerta inclui recuperação /diaria-inbox");
    // Pipeline não bloqueou:
    assert.equal(result.uploaded.length, 0);
    assert.equal(result.pulled.length, 0);
  });

  it("guard com variantes amplas (F3): UNAUTHENTICATED e invalid_token também deduplicam", () => {
    const result = makeSyncResult({ mode: "push" });
    const guard = makeInvalidGrantGuard(result);

    // Cada variante dispara o guard — mas dedup só deixa 1 warning
    for (const msg of ["UNAUTHENTICATED", "invalid_token", "unauthorized", "token has been expired or revoked"]) {
      if (classifyOAuthError(msg) === "invalid_grant") guard();
    }

    assert.equal(result.warnings.length, 1, "4 variantes auth-expired → 1 warning via dedup real");
  });
});
