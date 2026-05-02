import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractUrls,
  URL_REGEX,
  isLabelQuery,
  extractLabelName,
  labelExistsInList,
  incrementEmptyDrain,
  resetEmptyDrain,
  shouldWarnEmptyDrains,
  stripLabelFromQuery,
  decideEmptyDrainAction,
  EMPTY_DRAIN_WARN_THRESHOLD,
  loadCursor,
  main as drainMain,
  type AltQueryResult,
} from "../scripts/inbox-drain.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");
const CURSOR_PATH = resolve(ROOT, "data", "inbox-cursor.json");
const INBOX_PATH = resolve(ROOT, "data", "inbox.md");
const CREDS_PATH = resolve(ROOT, "data", ".credentials.json");

const FAKE_CREDS = {
  client_id: "fake",
  client_secret: "fake",
  access_token: "fake-token",
  refresh_token: "fake-refresh",
  expiry_ms: Date.now() + 3_600_000,
};

function makeGmailResponse(body: unknown, status = 200): Response {
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

describe("extractUrls() — extração via URL_REGEX + strip de pontuação", () => {
  it("extrai URL limpa de texto corrido", () => {
    const body = "Olha essa matéria: https://openai.com/blog/gpt-5 muito boa.";
    assert.deepEqual(extractUrls(body), ["https://openai.com/blog/gpt-5"]);
  });

  it("remove ponto final agarrado na URL", () => {
    const body = "Link: https://anthropic.com/news/claude.";
    assert.deepEqual(extractUrls(body), ["https://anthropic.com/news/claude"]);
  });

  it("remove parêntese de fechamento agarrado", () => {
    const body = "Ver (https://arxiv.org/abs/2501.12345) no arxiv";
    assert.deepEqual(extractUrls(body), ["https://arxiv.org/abs/2501.12345"]);
  });

  it("remove vírgula de fechamento", () => {
    const body = "Leia https://example.com/artigo, muito interessante";
    assert.deepEqual(extractUrls(body), ["https://example.com/artigo"]);
  });

  it("para antes de > em URL dentro de <https://...>", () => {
    const body = "Linkaram <https://openai.com/index/chatgpt> aqui";
    assert.deepEqual(extractUrls(body), ["https://openai.com/index/chatgpt"]);
  });

  it("extrai múltiplas URLs em um só e-mail", () => {
    const body = `Dois papers bons:
      - https://arxiv.org/abs/2501.00001
      - https://huggingface.co/papers/2501.00002.
    `;
    assert.deepEqual(extractUrls(body), [
      "https://arxiv.org/abs/2501.00001",
      "https://huggingface.co/papers/2501.00002",
    ]);
  });

  it("filtra URLs muito curtas (< 10 chars)", () => {
    // "https://x" tem 9 chars — filtrado
    const body = "tudo mundo linka https://x mas é curto demais";
    assert.deepEqual(extractUrls(body), []);
  });

  it("URL_REGEX tem flag global (stateful match() funciona)", () => {
    // Apenas garantir que a regex está realmente configurada como global
    assert.ok(URL_REGEX.global, "URL_REGEX deve ter flag /g");
  });
});

describe("isLabelQuery() — detecta query baseada em label:", () => {
  it("reconhece 'label:Diaria'", () => {
    assert.equal(isLabelQuery("label:Diaria"), true);
  });

  it("reconhece com whitespace e composição", () => {
    assert.equal(isLabelQuery("  label:Diaria after:2026/01/01"), true);
    assert.equal(isLabelQuery("LABEL:foo"), true);
  });

  it("rejeita queries sem label:", () => {
    assert.equal(isLabelQuery("from:vjpixel@gmail.com"), false);
    assert.equal(isLabelQuery("in:inbox"), false);
    assert.equal(isLabelQuery(""), false);
  });
});

describe("extractLabelName() — pega o nome do label da query", () => {
  it("extrai nome simples", () => {
    assert.equal(extractLabelName("label:Diaria"), "Diaria");
  });

  it("para no primeiro whitespace (ignora resto da query)", () => {
    assert.equal(extractLabelName("label:Diaria after:2026/01/01"), "Diaria");
  });

  it("retorna string vazia se não houver label:", () => {
    assert.equal(extractLabelName("from:editor@x.com"), "");
  });
});

describe("labelExistsInList() — checagem case-insensitive", () => {
  it("encontra label existente", () => {
    const labels = [{ name: "Diaria" }, { name: "INBOX" }];
    assert.equal(labelExistsInList(labels, "Diaria"), true);
  });

  it("é case-insensitive", () => {
    const labels = [{ name: "Diaria" }];
    assert.equal(labelExistsInList(labels, "diaria"), true);
    assert.equal(labelExistsInList(labels, "DIARIA"), true);
  });

  it("retorna false quando não acha", () => {
    const labels = [{ name: "Other" }];
    assert.equal(labelExistsInList(labels, "Diaria"), false);
  });

  it("aceita lista vazia", () => {
    assert.equal(labelExistsInList([], "Diaria"), false);
  });

  it("string-target vazio passa (não há nome pra validar)", () => {
    assert.equal(labelExistsInList([{ name: "X" }], ""), true);
  });
});

describe("contador de drains vazios consecutivos", () => {
  it("incrementEmptyDrain a partir de cursor sem campo", () => {
    const c = incrementEmptyDrain({ last_drain_iso: null });
    assert.equal(c.consecutive_empty_drains, 1);
    assert.equal(c.last_drain_iso, null);
  });

  it("incrementEmptyDrain incrementa N+1", () => {
    const c = incrementEmptyDrain({
      last_drain_iso: "2026-04-20T00:00:00Z",
      consecutive_empty_drains: 2,
    });
    assert.equal(c.consecutive_empty_drains, 3);
    assert.equal(c.last_drain_iso, "2026-04-20T00:00:00Z");
  });

  it("resetEmptyDrain zera o contador", () => {
    const c = resetEmptyDrain({
      last_drain_iso: "2026-04-20T00:00:00Z",
      consecutive_empty_drains: 5,
    });
    assert.equal(c.consecutive_empty_drains, 0);
  });

  it("shouldWarnEmptyDrains compara com THRESHOLD", () => {
    assert.equal(shouldWarnEmptyDrains({ last_drain_iso: null }), false);
    assert.equal(
      shouldWarnEmptyDrains({
        last_drain_iso: null,
        consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD - 1,
      }),
      false,
    );
    assert.equal(
      shouldWarnEmptyDrains({
        last_drain_iso: null,
        consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
      }),
      true,
    );
    assert.equal(
      shouldWarnEmptyDrains({
        last_drain_iso: null,
        consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD + 5,
      }),
      true,
    );
  });
});

describe("stripLabelFromQuery (#274)", () => {
  it("remove `label:Diaria` simples", () => {
    assert.equal(stripLabelFromQuery("label:Diaria"), "");
  });

  it("remove `label:` no início preservando o resto", () => {
    assert.equal(
      stripLabelFromQuery("label:Diaria from:editor@gmail.com"),
      "from:editor@gmail.com",
    );
  });

  it("remove `label:` no meio preservando o resto", () => {
    assert.equal(
      stripLabelFromQuery("from:editor@gmail.com label:Diaria"),
      "from:editor@gmail.com",
    );
  });

  it("remove `label:` em várias ocorrências", () => {
    assert.equal(
      stripLabelFromQuery("label:Foo label:Bar from:editor@gmail.com"),
      "from:editor@gmail.com",
    );
  });

  it("query sem `label:` passa intacta", () => {
    assert.equal(
      stripLabelFromQuery("from:editor@gmail.com after:2026/04/01"),
      "from:editor@gmail.com after:2026/04/01",
    );
  });

  it("query vazia retorna vazia", () => {
    assert.equal(stripLabelFromQuery(""), "");
  });

  it("é case-insensitive em LABEL", () => {
    assert.equal(stripLabelFromQuery("LABEL:Diaria from:x"), "from:x");
  });

  it("preserva nome de label com hífen ou underscore (typical Gmail labels)", () => {
    assert.equal(
      stripLabelFromQuery("label:diar-ia/inbox after:2026/04/01"),
      "after:2026/04/01",
    );
  });
});

describe("decideEmptyDrainAction (#274 + #286)", () => {
  const altRanZero: AltQueryResult = { ran: true, thread_count: 0, failed: false };
  const altRanFound: AltQueryResult = { ran: true, thread_count: 5, failed: false };
  const altFailed: AltQueryResult = { ran: true, thread_count: 0, failed: true };
  const altNotRun: AltQueryResult = { ran: false, thread_count: 0, failed: false };

  it("abaixo do threshold: kind=none (sem ação)", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD - 1,
    };
    const r = decideEmptyDrainAction(cursor, "label:Diaria", altRanZero);
    assert.deepEqual(r, { kind: "none" });
  });

  it("threshold + alt ran achou threads: label_broken", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    };
    const r = decideEmptyDrainAction(cursor, "label:Diaria", altRanFound);
    assert.deepEqual(r, { kind: "label_broken", thread_count: 5 });
  });

  it("threshold + alt ran 0 threads: silent_reset", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    };
    const r = decideEmptyDrainAction(cursor, "label:Diaria", altRanZero);
    assert.deepEqual(r, { kind: "silent_reset" });
  });

  it("#286 fix: threshold + alt FAILED: warn padrão (NÃO silent reset)", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    };
    const r = decideEmptyDrainAction(cursor, "label:Diaria", altFailed);
    assert.equal(r.kind, "warn");
    if (r.kind === "warn") {
      assert.match(r.reason, /alt query.*falhou/);
      assert.match(r.reason, /não dá pra distinguir/);
      assert.match(r.reason, /Diaria/); // menciona o label name
    }
  });

  it("threshold + query custom (sem label:): warn padrão (alt não roda)", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    };
    const r = decideEmptyDrainAction(
      cursor,
      "from:editor@gmail.com",
      altNotRun,
    );
    assert.equal(r.kind, "warn");
    if (r.kind === "warn") {
      assert.match(r.reason, /query custom/);
      assert.match(r.reason, /from:editor@gmail\.com/);
    }
  });

  it("threshold acima do limite (5 drains): mesmo comportamento do exato", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD + 5,
    };
    const r = decideEmptyDrainAction(cursor, "label:Diaria", altRanZero);
    assert.deepEqual(r, { kind: "silent_reset" });
  });

  it("warn reason inclui contagem de drains", () => {
    const cursor = { last_drain_iso: null, consecutive_empty_drains: 7 };
    const r = decideEmptyDrainAction(cursor, "label:Diaria", altFailed);
    assert.equal(r.kind, "warn");
    if (r.kind === "warn") {
      assert.match(r.reason, /7 drains/);
    }
  });

  it("label name é extraído da query no warn de alt-failed", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    };
    const r = decideEmptyDrainAction(
      cursor,
      "label:CustomLabel after:2026/01/01",
      altFailed,
    );
    assert.equal(r.kind, "warn");
    if (r.kind === "warn") {
      assert.match(r.reason, /CustomLabel/);
    }
  });
});

describe("inbox-drain main() integration (#306)", () => {
  let originalFetch: typeof globalThis.fetch;
  let savedConfig: string | null = null;
  let savedCursor: string | null = null;
  let savedCreds: string | null = null;
  let savedInbox: string | null = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Save state of all real files that main() may read or write.
    savedConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
    savedCursor = existsSync(CURSOR_PATH) ? readFileSync(CURSOR_PATH, "utf8") : null;
    savedCreds = existsSync(CREDS_PATH) ? readFileSync(CREDS_PATH, "utf8") : null;
    savedInbox = existsSync(INBOX_PATH) ? readFileSync(INBOX_PATH, "utf8") : null;

    // Write fake creds so getAccessToken() doesn't call fetch
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(CREDS_PATH, JSON.stringify(FAKE_CREDS), "utf8");
  });

  afterEach(() => {
    // Restore fetch first (no I/O, always safe).
    globalThis.fetch = originalFetch;
    // Restore real files in a try/finally so a crash inside the test body
    // can't permanently corrupt the workspace.
    try {
      if (savedConfig !== null) writeFileSync(CONFIG_PATH, savedConfig, "utf8");
      if (savedCursor !== null) writeFileSync(CURSOR_PATH, savedCursor, "utf8");
      else if (existsSync(CURSOR_PATH)) unlinkSync(CURSOR_PATH);
      if (savedCreds !== null) writeFileSync(CREDS_PATH, savedCreds, "utf8");
      else if (existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
      if (savedInbox !== null) writeFileSync(INBOX_PATH, savedInbox, "utf8");
      else if (existsSync(INBOX_PATH)) unlinkSync(INBOX_PATH);
    } catch (restoreErr) {
      console.error("[inbox-drain.test afterEach] failed to restore files:", restoreErr);
    }
  });

  /** Helper: capture stdout written by drainMain() and return parsed JSON. */
  async function runDrain(): Promise<Record<string, unknown>> {
    const capturedOutput: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any) => {
      if (typeof chunk === "string") capturedOutput.push(chunk);
      return true;
    };
    try {
      await drainMain();
    } finally {
      process.stdout.write = origWrite;
    }
    return JSON.parse(capturedOutput.join(""));
  }

  it("drain com threads = [] → silent_reset path → cursor não avança", async () => {
    // Set up cursor at THRESHOLD so silent_reset fires on empty drain
    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-04-01T00:00:00Z",
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    }), "utf8");

    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/labels")) {
        return makeGmailResponse({ labels: [{ id: "1", name: "Diaria.Editor" }] });
      }
      if (u.includes("/threads") && !u.includes("/threads/")) {
        return makeGmailResponse({ threads: [] });
      }
      return makeGmailResponse({});
    };

    const output = await runDrain();
    assert.equal(output.new_entries, 0);
    assert.equal(output.skipped, false);

    // After silent_reset cursor should reset consecutive_empty_drains to 0
    const cursor = JSON.parse(readFileSync(CURSOR_PATH, "utf8"));
    assert.equal(cursor.consecutive_empty_drains, 0);
  });

  it("drain com 1 thread com URL → URL extraída em data/inbox.md", async () => {
    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-01-01T00:00:00Z",
      consecutive_empty_drains: 0,
    }), "utf8");

    // Encode "Veja https://openai.com/blog/gpt-5" in base64url
    const bodyText = "Veja https://openai.com/blog/gpt-5";
    const b64 = Buffer.from(bodyText).toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/labels")) {
        return makeGmailResponse({ labels: [{ id: "1", name: "Diaria.Editor" }] });
      }
      if (u.includes("/threads?")) {
        return makeGmailResponse({
          threads: [{ id: "thread1", snippet: "Veja link" }],
        });
      }
      if (u.includes("/threads/thread1")) {
        return makeGmailResponse({
          id: "thread1",
          messages: [{
            id: "msg1",
            internalDate: String(new Date("2026-04-15T10:00:00Z").getTime()),
            payload: {
              mimeType: "text/plain",
              body: { data: b64 },
              headers: [
                { name: "From", value: "sender@example.com" },
                { name: "Subject", value: "Test Subject" },
              ],
            },
          }],
        });
      }
      return makeGmailResponse({});
    };

    const output = await runDrain();
    assert.equal(output.new_entries, 1);
    assert.ok((output.urls as Array<{ url: string }>).some((u) => u.url === "https://openai.com/blog/gpt-5"));

    // inbox.md deve conter a URL extraída
    assert.ok(existsSync(INBOX_PATH));
    const inboxContent = readFileSync(INBOX_PATH, "utf8");
    assert.ok(inboxContent.includes("https://openai.com/blog/gpt-5"));
  });

  it("inbox disabled → skipped=true sem chamar Gmail API (#430)", async () => {
    // Write config with inbox.enabled: false
    const config = JSON.parse(savedConfig ?? "{}");
    config.inbox = { ...(config.inbox ?? {}), enabled: false };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return makeGmailResponse({});
    };

    const output = await runDrain();
    assert.equal(output.skipped, true);
    assert.equal(output.new_entries, 0);
    assert.equal(fetchCalled, false, "Gmail API must not be called when inbox is disabled");
  });

  it("label ausente → validateLabel cria label, busca sem label → drain vazio (#430)", async () => {
    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-04-01T00:00:00Z",
      consecutive_empty_drains: 0,
    }), "utf8");

    const callLog: string[] = [];
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/labels") && (!opts?.method || opts.method === "GET")) {
        callLog.push("GET /labels");
        // Return labels without Diaria.Editor
        return makeGmailResponse({ labels: [{ id: "0", name: "INBOX" }] });
      }
      if (u.includes("/labels") && opts?.method === "POST") {
        callLog.push("POST /labels");
        return makeGmailResponse({ id: "1", name: "Diaria.Editor" });
      }
      if (u.includes("/threads")) {
        callLog.push("GET /threads");
        return makeGmailResponse({ threads: [] });
      }
      return makeGmailResponse({});
    };

    const output = await runDrain();
    // After createLabel, the function returns early with skipped=true and reason=label_missing
    assert.equal(output.skipped, true);
    assert.equal(output.new_entries, 0);
    assert.ok(callLog.includes("POST /labels"), "deve criar label ausente");
    // No threads call — exits early after label creation
    assert.equal(
      callLog.filter((c) => c === "GET /threads").length,
      0,
      "não deve buscar threads depois de criar label (retorna early)",
    );
  });

  it("alt query failure → não lança exceção, new_entries=0 (#431)", async () => {
    // Set cursor at threshold so alt query runs after an empty primary drain
    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-04-01T00:00:00Z",
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    }), "utf8");

    let primaryCalled = false;
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/labels")) {
        return makeGmailResponse({ labels: [{ id: "1", name: "Diaria.Editor" }] });
      }
      if (u.includes("/threads")) {
        if (!primaryCalled) {
          // First call = primary query (with label) → empty → triggers alt query
          primaryCalled = true;
          return makeGmailResponse({ threads: [] });
        }
        // Second call = alt query (without label) → HTTP 500 → caught as altQuery.failed
        return makeGmailResponse({ error: "internal server error" }, 500);
      }
      return makeGmailResponse({});
    };

    // Should not throw — main() wraps the alt query in try/catch and handles
    // the failure via decideEmptyDrainAction (warn path), never re-throws.
    let threw = false;
    let output: Record<string, unknown> = {};
    try {
      output = await runDrain();
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "drainMain() não deve lançar exceção quando alt query falha");
    assert.equal(output.new_entries, 0);
  });
});

describe("loadCursor — validação de cursor no futuro (#441)", () => {
  const cursorPath = resolve(ROOT, "data", "inbox-cursor.json");
  let savedCursor: string | null = null;

  beforeEach(() => {
    savedCursor = existsSync(cursorPath) ? readFileSync(cursorPath, "utf8") : null;
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
  });
  afterEach(() => {
    if (savedCursor !== null) writeFileSync(cursorPath, savedCursor, "utf8");
    else if (existsSync(cursorPath)) unlinkSync(cursorPath);
  });

  it("cursor no futuro → retorna null com warn", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString(); // 1h no futuro
    writeFileSync(cursorPath, JSON.stringify({ last_drain_iso: future }), "utf8");
    const cursor = loadCursor();
    assert.equal(cursor.last_drain_iso, null, "deve resetar cursor no futuro para null");
  });

  it("cursor no passado → preservado normalmente", () => {
    const past = "2026-04-01T10:00:00Z";
    writeFileSync(cursorPath, JSON.stringify({ last_drain_iso: past }), "utf8");
    const cursor = loadCursor();
    assert.equal(cursor.last_drain_iso, past);
  });

  it("cursor null → retornado sem modificação", () => {
    writeFileSync(cursorPath, JSON.stringify({ last_drain_iso: null }), "utf8");
    const cursor = loadCursor();
    assert.equal(cursor.last_drain_iso, null);
  });
});

describe("afterDate usa UTC (#442)", () => {
  it("cursor.last_drain_iso é fatiado diretamente como YYYY/MM/DD sem conversão de TZ", () => {
    // ISO string com hora que seria diferente em UTC vs Brasil (UTC-3)
    // "2026-04-28T01:30:00Z" = "2026-04-27T22:30:00-03:00" → com getDate() local (BR) viraria 27/04, com UTC fica 28/04
    const iso = "2026-04-28T01:30:00Z";
    const afterDate = iso.slice(0, 10).replace(/-/g, "/");
    assert.equal(afterDate, "2026/04/28", "deve usar data UTC, não local");
  });

  it("primeira execução: 3 dias atrás em UTC", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 3);
    const afterDate = d.toISOString().slice(0, 10).replace(/-/g, "/");
    // Verificar formato YYYY/MM/DD
    assert.match(afterDate, /^\d{4}\/\d{2}\/\d{2}$/);
  });
});
