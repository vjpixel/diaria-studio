/**
 * #11786: round-trip MD → Google Doc → MD do drive-sync corrompia o draft.md
 * mensal sem nenhuma edição humana — `US$` virava `US\$`, espaços no fim de
 * linha, linha em branco entre `Curadorias:`/`Da diar.ia.br:` e suas listas
 * (FATAL no lint #6881) e a imagem remota do box virava `[image1]` com base64
 * embutido (14 KB → 2,6 MB).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeDocExportMarkdown,
  collapseLabelListGap,
  restoreInlineImages,
} from "../scripts/lib/doc-export-normalize.ts";
import { unescapeMarkdown } from "../scripts/lib/markdown-unescape.ts";
import { pullFile, pushFile, GOOGLE_DOC_MIME, type DriveCache, type SyncResult } from "../scripts/drive-sync.ts";
import { CREDENTIALS_PATH_TEST_OVERRIDE_ENV } from "../scripts/google-auth.ts";

// Draft local como o pipeline grava (trecho real do rodapé + box com imagem remota).
const LOCAL_DRAFT = [
  "# Retrospectiva de outubro",
  "",
  "A OpenAI levantou US$ 40 bi e a Anthropic, US$ 13 bi.",
  "",
  "![É IA?](https://eia.diar.ia.br/img/2610.jpg)",
  "",
  "Curadorias:",
  "- [Cursos](https://cursos.diar.ia.br?utm_source=newsletter&utm_medium=email&utm_campaign=cursos-rodape)",
  "- [Livros](https://livros.diar.ia.br?utm_source=newsletter&utm_medium=email&utm_campaign=livros-rodape)",
  "",
  "Da diar.ia.br:",
  "- [Edições anteriores](https://diar.ia.br)",
  "",
].join("\n");

const BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// O que o export text/markdown do Docs devolve para o draft acima, sem edição.
const DOC_EXPORT = [
  "# Retrospectiva de outubro",
  "",
  "A OpenAI levantou US\\$ 40 bi e a Anthropic, US\\$ 13 bi.  ",
  "",
  "![É IA?][image1]",
  "",
  "Curadorias:",
  "",
  "- [Cursos](https://cursos.diar.ia.br?utm\\_source=newsletter&utm\\_medium=email&utm\\_campaign=cursos-rodape)  ",
  "- [Livros](https://livros.diar.ia.br?utm\\_source=newsletter&utm\\_medium=email&utm\\_campaign=livros-rodape)",
  "",
  "Da diar.ia.br:",
  "",
  "- [Edições anteriores](https://diar.ia.br)",
  "",
  `[image1]: <data:image/png;base64,${BASE64}>`,
  "",
].join("\n");

describe("normalizeDocExportMarkdown — round-trip do draft (#11786)", () => {
  it("round-trip sem edição devolve o draft local byte a byte", () => {
    const r = normalizeDocExportMarkdown(DOC_EXPORT, LOCAL_DRAFT);
    assert.equal(r.text, LOCAL_DRAFT);
    assert.equal(r.restoredImages, 1);
    assert.equal(r.unresolvedInlineImages, 0);
  });

  it("preserva `$` e os rótulos do rodapé colados à lista", () => {
    const { text } = normalizeDocExportMarkdown(DOC_EXPORT, LOCAL_DRAFT);
    assert.ok(!text.includes("\\$"), "sem \\$ no resultado");
    assert.match(text, /US\$ 40 bi/);
    assert.match(text, /^Curadorias:\n- \[Cursos\]/m);
    assert.match(text, /^Da diar\.ia\.br:\n- \[Edições anteriores\]/m);
    assert.ok(!/ +$/m.test(text), "sem espaço no fim de linha");
    assert.ok(!text.includes("base64"), "sem imagem embutida");
  });

  it("unescapeMarkdown desfaz \\$ e \\~", () => {
    assert.equal(unescapeMarkdown("US\\$ 2 bi e \\~tachado\\~"), "US$ 2 bi e ~tachado~");
  });

  it("edição humana no Doc sobrevive à normalização", () => {
    const edited = DOC_EXPORT.replace("US\\$ 40 bi", "US\\$ 41 bi");
    const { text } = normalizeDocExportMarkdown(edited, LOCAL_DRAFT);
    assert.match(text, /US\$ 41 bi/);
  });
});

describe("collapseLabelListGap", () => {
  it("não cola parágrafo longo terminado em ':' nem heading à lista", () => {
    const src = "## Seção:\n\n- a\n\nUma frase bem longa que por acaso termina com dois pontos e segue:\n\n- b\n";
    assert.equal(collapseLabelListGap(src), src);
  });

  it("não remove linha em branco quando o que segue não é lista", () => {
    const src = "Por que isso importa:\n\nParágrafo.\n";
    assert.equal(collapseLabelListGap(src), src);
  });
});

describe("restoreInlineImages", () => {
  it("quantidade não casa com o local → não restaura e conta como não resolvida", () => {
    const r = restoreInlineImages(DOC_EXPORT, "# local sem imagem\n");
    assert.equal(r.unresolved, 1);
    assert.equal(r.text, DOC_EXPORT);
  });

  it("sem imagem embutida → texto intacto", () => {
    const r = restoreInlineImages("![x](https://a.b/c.png)\n", undefined);
    assert.deepEqual(r, { text: "![x](https://a.b/c.png)\n", restored: 0, unresolved: 0 });
  });
});

// ── pullFile / pushFile com fetch mockado ────────────────────────────────────

const YYMMDD = "261101";
const FILE_ID = "doc-draft-id";
const PUSH_TIME = "2026-11-01T10:00:00.000Z";
const LATER_TIME = "2026-11-01T10:00:05.000Z";

function sha(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

function bytesResponse(text: string): Response {
  const buf = Buffer.from(text, "utf8");
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => text,
    json: async () => ({}),
    headers: { get: () => null },
  } as unknown as Response;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeResult(mode: string): SyncResult {
  return { mode, stage: 4, edition: YYMMDD, day_folder_path: "x", uploaded: [], pulled: [], warnings: [] };
}

function mockDrive(exportText: string, modifiedTime: string): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const s = String(url);
    if (s.includes(`/files/${FILE_ID}/export`)) return bytesResponse(exportText);
    if (s.includes("/upload/")) return jsonResponse({ id: FILE_ID, modifiedTime, mimeType: GOOGLE_DOC_MIME });
    if (s.includes(`/files/${FILE_ID}`)) return jsonResponse({ id: FILE_ID, name: "draft", modifiedTime });
    return jsonResponse({ files: [] });
  }) as typeof globalThis.fetch;
}

describe("drive-sync pull/push do draft.md como Doc (#11786)", () => {
  let originalFetch: typeof globalThis.fetch;
  let tmpDir: string;
  let credsDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    prevEnv = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
    credsDir = mkdtempSync(join(tmpdir(), "drive-11786-creds-"));
    writeFileSync(
      join(credsDir, ".credentials.json"),
      JSON.stringify({ client_id: "f", client_secret: "f", access_token: "t", refresh_token: "r", expiry_ms: Date.now() + 3_600_000 }),
    );
    process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = join(credsDir, ".credentials.json");
    tmpDir = mkdtempSync(join(tmpdir(), "drive-11786-"));
    writeFileSync(join(tmpDir, "draft.md"), LOCAL_DRAFT, "utf8");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prevEnv !== undefined) process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = prevEnv;
    else delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(credsDir, { recursive: true, force: true });
  });

  function cacheWith(entry: Partial<DriveCache["editions"][string]["files"][string]>): DriveCache {
    return {
      editions: {
        [YYMMDD]: {
          day_folder_id: "day",
          files: {
            "draft.md": {
              drive_file_id: FILE_ID,
              drive_modifiedTime: PUSH_TIME,
              last_pushed_mtime: Date.now() + 60_000, // local "sincronizado"
              push_count: 1,
              drive_mimeType: GOOGLE_DOC_MIME,
              ...entry,
            },
          },
        },
      },
    };
  }

  it("push grava o sha256 do export do Doc no cache", async () => {
    mockDrive(DOC_EXPORT, PUSH_TIME);
    const cache: DriveCache = { editions: { [YYMMDD]: { day_folder_id: "day", files: {} } } };
    const result = makeResult("push");
    await pushFile(tmpDir, "draft.md", YYMMDD, "day", cache, result);
    assert.equal(result.uploaded.length, 1);
    assert.equal(cache.editions[YYMMDD].files["draft.md"].export_sha256, sha(DOC_EXPORT));
  });

  it("pull com Doc não editado (export = baseline) não reescreve o local", async () => {
    mockDrive(DOC_EXPORT, LATER_TIME);
    const cache = cacheWith({ export_sha256: sha(DOC_EXPORT) });
    const result = makeResult("pull");
    await pullFile(tmpDir, "draft.md", YYMMDD, cache, result);
    assert.equal(readFileSync(join(tmpDir, "draft.md"), "utf8"), LOCAL_DRAFT);
    assert.equal(result.pulled.length, 1);
    assert.equal(result.pulled[0].overwrote_local, false);
    assert.equal(cache.editions[YYMMDD].files["draft.md"].drive_modifiedTime, LATER_TIME);
    assert.equal(result.warnings.length, 0);
  });

  it("pull sem baseline normaliza: preserva `$`, rótulos e a URL remota da imagem", async () => {
    const edited = DOC_EXPORT.replace("US\\$ 13 bi", "US\\$ 14 bi");
    mockDrive(edited, LATER_TIME);
    const cache = cacheWith({});
    const result = makeResult("pull");
    await pullFile(tmpDir, "draft.md", YYMMDD, cache, result);
    const local = readFileSync(join(tmpDir, "draft.md"), "utf8");
    assert.equal(local, LOCAL_DRAFT.replace("US$ 13 bi", "US$ 14 bi"));
    assert.equal(result.pulled[0].overwrote_local, true);
  });

  it("pull com imagem embutida impossível de restaurar não sobrescreve o local", async () => {
    writeFileSync(join(tmpDir, "draft.md"), "# local sem imagem remota\n", "utf8");
    mockDrive(DOC_EXPORT, LATER_TIME);
    const cache = cacheWith({});
    const result = makeResult("pull");
    await pullFile(tmpDir, "draft.md", YYMMDD, cache, result);
    assert.equal(readFileSync(join(tmpDir, "draft.md"), "utf8"), "# local sem imagem remota\n");
    assert.equal(result.pulled.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].error_message, /#11786/);
  });
});
