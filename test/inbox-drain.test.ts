import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  extractUrls,
  URL_REGEX,
  incrementEmptyDrain,
  resetEmptyDrain,
  shouldWarnEmptyDrains,
  decideEmptyDrainAction,
  dedupForwards,
  EMPTY_DRAIN_WARN_THRESHOLD,
  loadCursor,
  main as drainMain,
  isAuthExpiredError,
  authExpiredWarn,
  buildSearchFailedResult,
} from "../scripts/inbox-drain.ts";

describe("#1973 — OAuth expirado vs falha transiente", () => {
  it("isAuthExpiredError: invalid_grant / expired / revoked → true", () => {
    assert.equal(isAuthExpiredError("invalid_grant"), true);
    assert.equal(isAuthExpiredError("Token has been expired or revoked"), true);
    assert.equal(isAuthExpiredError("Invalid Credentials"), true);
    // code-review #1973: 401 moderno do Google (UNAUTHENTICATED)
    assert.equal(isAuthExpiredError("Request had invalid authentication credentials. Expected OAuth 2 access token"), true);
    assert.equal(isAuthExpiredError("401 UNAUTHENTICATED"), true);
    // transiente → false
    assert.equal(isAuthExpiredError("ECONNRESET socket hang up"), false);
    assert.equal(isAuthExpiredError("503 backend error"), false);
  });

  it("buildSearchFailedResult: invalid_grant → reason auth_expired + flag", () => {
    const r = buildSearchFailedResult("Gmail search: invalid_grant token revoked");
    assert.equal(r.reason, "auth_expired");
    assert.equal(r.auth_expired, true);
    assert.equal(r.skipped, true);
  });

  it("buildSearchFailedResult: erro transiente → reason search_failed (sem flag)", () => {
    const r = buildSearchFailedResult("network timeout");
    assert.equal(r.reason, "search_failed");
    assert.equal(r.auth_expired, undefined);
  });

  it("authExpiredWarn: explicita submissões perdidas + ação", () => {
    const w = authExpiredWarn();
    assert.match(w, /SUBMISSÕES DO EDITOR.*PERDIDAS/);
    assert.match(w, /oauth-setup\.ts/);
    assert.match(w, /diaria-inbox/);
  });
});

function makeMessage(subject: string, id = "msg"): {
  id: string;
  internalDate: string;
  payload: { mimeType: string; headers: Array<{ name: string; value: string }> };
} {
  return {
    id,
    internalDate: "0",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: subject }],
    },
  };
}

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

describe("decideEmptyDrainAction (#900) — simplificado", () => {
  it("abaixo do threshold: kind=none (sem ação)", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD - 1,
    };
    assert.deepEqual(decideEmptyDrainAction(cursor), { kind: "none" });
  });

  it("no threshold: silent_reset (inbox vazio é estado válido)", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    };
    assert.deepEqual(decideEmptyDrainAction(cursor), { kind: "silent_reset" });
  });

  it("muito acima do threshold: continua silent_reset", () => {
    const cursor = {
      last_drain_iso: null,
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD + 50,
    };
    assert.deepEqual(decideEmptyDrainAction(cursor), { kind: "silent_reset" });
  });

  it("cursor sem consecutive_empty_drains (default 0): kind=none", () => {
    const cursor = { last_drain_iso: null };
    assert.deepEqual(decideEmptyDrainAction(cursor), { kind: "none" });
  });
});

describe("dedupForwards (#656) — original preferido sobre Fwd: no mesmo thread", () => {
  it("thread com original + Fwd: ingere só o original", () => {
    const original = makeMessage("Anthropic launches X", "1");
    const forward = makeMessage("Fwd: Anthropic launches X", "2");
    const result = dedupForwards([original as any, forward as any]);
    assert.equal(result.length, 1);
    assert.equal((result[0] as any).id, "1");
  });

  it("thread só com Fwd: (sem original) ingere o Fwd", () => {
    const forward = makeMessage("Fwd: Some article", "1");
    const result = dedupForwards([forward as any]);
    assert.equal(result.length, 1);
    assert.equal((result[0] as any).id, "1");
  });

  it("thread só com 1 msg sem Fwd: (submissão direta) ingere normal", () => {
    const direct = makeMessage("Olha esse link", "1");
    const result = dedupForwards([direct as any]);
    assert.equal(result.length, 1);
    assert.equal((result[0] as any).id, "1");
  });

  it("reconhece variante 'Fw:' (sem 'd')", () => {
    const original = makeMessage("Subject X", "1");
    const fw = makeMessage("Fw: Subject X", "2");
    const result = dedupForwards([original as any, fw as any]);
    assert.equal(result.length, 1);
    assert.equal((result[0] as any).id, "1");
  });

  it("é case-insensitive em FWD:", () => {
    const original = makeMessage("Subject X", "1");
    const fwd = makeMessage("FWD: Subject X", "2");
    const result = dedupForwards([original as any, fwd as any]);
    assert.equal(result.length, 1);
    assert.equal((result[0] as any).id, "1");
  });

  it("preserva 'Re:' (resposta, não forward)", () => {
    const original = makeMessage("Subject X", "1");
    const reply = makeMessage("Re: Subject X", "2");
    const result = dedupForwards([original as any, reply as any]);
    // Nenhum dos dois é forward — ambos preservados
    assert.equal(result.length, 2);
  });

  it("thread com múltiplos forwards e um original ingere só o original", () => {
    const original = makeMessage("Topic A", "1");
    const fwd1 = makeMessage("Fwd: Topic A", "2");
    const fwd2 = makeMessage("Fwd: Topic A", "3");
    const result = dedupForwards([original as any, fwd1 as any, fwd2 as any]);
    assert.equal(result.length, 1);
    assert.equal((result[0] as any).id, "1");
  });
});

describe("dedupForwards (#1716) — dup intra-thread (sent + received sem Fwd:)", () => {
  // Constrói uma mensagem com corpo text/plain (base64url, como o Gmail retorna).
  // `messageId` opcional adiciona o header Message-ID (dedup por identidade RFC822).
  function makeMessageWithBody(
    subject: string,
    bodyText: string,
    id: string,
    messageId?: string,
  ) {
    const data = Buffer.from(bodyText, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const headers: Array<{ name: string; value: string }> = [
      { name: "Subject", value: subject },
    ];
    if (messageId) headers.push({ name: "Message-ID", value: messageId });
    return {
      id,
      internalDate: "0",
      payload: { mimeType: "text/plain", body: { data }, headers },
    };
  }

  it("colapsa cópia Sent + recebida do mesmo email (mesmo corpo, nenhuma Fwd:) → 1 entrada", () => {
    // Cenário do #1716: editor compõe direto pra diariaeditor@; o Gmail agrupa
    // a cópia em Sent + a cópia recebida no mesmo thread, ambas sem `Fwd:`.
    const body = "Olha esse link https://example.com/artigo";
    const sent = makeMessageWithBody("Link interessante", body, "sent");
    const received = makeMessageWithBody("Link interessante", body, "received");
    const result = dedupForwards([sent as any, received as any]);
    assert.equal(result.length, 1, "deve ingerir só 1 cópia");
    assert.equal((result[0] as any).id, "sent", "preserva a primeira (cronológica = Sent)");
  });

  it("tolera diferença de whitespace (CRLF vs LF) entre as cópias", () => {
    const sent = makeMessageWithBody("Sub", "linha 1\nlinha 2 https://x.com", "sent");
    const received = makeMessageWithBody("Sub", "linha 1\r\nlinha 2  https://x.com", "received");
    const result = dedupForwards([sent as any, received as any]);
    assert.equal(result.length, 1);
  });

  it("NÃO colapsa mensagens distintas no mesmo thread (corpos diferentes)", () => {
    const a = makeMessageWithBody("Sub", "primeiro link https://a.com", "a");
    const b = makeMessageWithBody("Sub", "segundo link https://b.com", "b");
    const result = dedupForwards([a as any, b as any]);
    assert.equal(result.length, 2, "submissões distintas devem ser preservadas");
  });

  it("corpos vazios NÃO colapsam entre si (key vazia é ignorada na dedup)", () => {
    const a = makeMessageWithBody("Sub A", "", "a");
    const b = makeMessageWithBody("Sub B", "", "b");
    const result = dedupForwards([a as any, b as any]);
    assert.equal(result.length, 2, "mensagens sem corpo não devem colapsar por key vazia");
  });

  it("colapsa por Message-ID idêntico mesmo se o corpo divergir (re-encoding/footer)", () => {
    // Se o auto-forward preserva o Message-ID mas re-encoda/adiciona footer ao
    // corpo, a dedup por corpo falharia — a key Message-ID (identidade RFC822)
    // ainda colapsa.
    const mid = "<CADxyz@mail.gmail.com>";
    const sent = makeMessageWithBody("Sub", "link https://x.com", "sent", mid);
    const received = makeMessageWithBody("Sub", "link https://x.com\n-- enviado", "received", mid);
    const result = dedupForwards([sent as any, received as any]);
    assert.equal(result.length, 1, "mesmo Message-ID → 1 entrada");
    assert.equal((result[0] as any).id, "sent");
  });

  it("Message-IDs distintos + corpos distintos NÃO colapsam", () => {
    const a = makeMessageWithBody("Sub", "primeiro https://a.com", "a", "<id-a@mail>");
    const b = makeMessageWithBody("Sub", "segundo https://b.com", "b", "<id-b@mail>");
    const result = dedupForwards([a as any, b as any]);
    assert.equal(result.length, 2);
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

  /**
   * Helper: capture stdout written by drainMain() and return parsed JSON.
   *
   * #3311: drainMain() é chamado IN-PROCESS (não spawnado) — o silent_reset
   * path (linhas 413+/614+ abaixo) dispara logDrainInfo(), que sem
   * isolamento cai no default de logEvent (process.cwd()), aqui a raiz real
   * do repo/worktree (mesma resolvida por CONFIG_PATH/CURSOR_PATH/ROOT no
   * topo deste arquivo). Cada chamada a runDrain() cria um tmpdir isolado
   * SÓ para o destino do run-log de auditoria — CONFIG_PATH/CURSOR_PATH/
   * INBOX_PATH continuam apontando pro repo real (convenção pré-existente
   * deste arquivo, com restore em afterEach; fora do escopo de #3311).
   */
  async function runDrain(): Promise<Record<string, unknown>> {
    const logRootDir = mkdtempSync(resolve(tmpdir(), "inbox-drain-logroot-"));
    const capturedOutput: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any) => {
      if (typeof chunk === "string") capturedOutput.push(chunk);
      return true;
    };
    try {
      await drainMain(logRootDir);
    } finally {
      process.stdout.write = origWrite;
      rmSync(logRootDir, { recursive: true, force: true });
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

  // #3311 regressão direta: antes de main(rootDir) existir, o silent_reset
  // path acima disparava logDrainInfo() sem rootDir explícito — caía no
  // default de logEvent (process.cwd()), que em drainMain() chamado
  // in-process (não spawnado) é o cwd real do test runner, tipicamente a
  // raiz do repo/worktree (mesmo ROOT usado por CONFIG_PATH/CURSOR_PATH
  // acima). Toda run desta suite poluía data/run-log.jsonl real com
  // entries "auto-reset: inbox vazio..." fabricadas. Este teste prova (a)
  // que o log de auditoria é de fato persistido, e (b) que vai SOMENTE pro
  // tmpdir isolado passado a main() — nunca pro repo real.
  it("#3311: log de auditoria do silent_reset isolado via main(rootDir) — nunca grava em data/run-log.jsonl real", async () => {
    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-04-01T00:00:00Z",
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    }), "utf8");

    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/threads") && !u.includes("/threads/")) {
        return makeGmailResponse({ threads: [] });
      }
      return makeGmailResponse({});
    };

    const logRootDir = mkdtempSync(resolve(tmpdir(), "inbox-drain-logroot-check-"));
    const realRepoLogPath = resolve(ROOT, "data", "run-log.jsonl");
    const realRepoLogSnapshot = existsSync(realRepoLogPath) ? readFileSync(realRepoLogPath, "utf8") : null;
    const capturedOutput: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any) => {
      if (typeof chunk === "string") capturedOutput.push(chunk);
      return true;
    };
    try {
      await drainMain(logRootDir);
    } finally {
      process.stdout.write = origWrite;
    }

    try {
      const isolatedLogPath = resolve(logRootDir, "data", "run-log.jsonl");
      assert.ok(existsSync(isolatedLogPath), "log de auditoria deveria existir no tmpdir isolado (main(rootDir))");
      const isolatedLog = readFileSync(isolatedLogPath, "utf8");
      assert.match(isolatedLog, /"agent":"inbox-drainer"/);
      assert.match(isolatedLog, /auto-reset/);

      if (existsSync(realRepoLogPath)) {
        const realLogAfter = readFileSync(realRepoLogPath, "utf8");
        assert.equal(
          realLogAfter,
          realRepoLogSnapshot,
          "data/run-log.jsonl REAL do repo não deveria ter sido alterado por este teste (main(rootDir) deveria ter isolado o write)",
        );
      }
    } finally {
      rmSync(logRootDir, { recursive: true, force: true });
    }
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

  it("#3362: query default (gmailQuery omitido) cobre os 2 formatos (com/sem ponto)", async () => {
    // Remove gmailQuery do config → main() deve cair no default novo, não em label:.
    const config = JSON.parse(savedConfig ?? "{}");
    config.inbox = { ...(config.inbox ?? {}) };
    delete config.inbox.gmailQuery;
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");

    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-04-01T00:00:00Z",
      consecutive_empty_drains: 0,
    }), "utf8");

    let capturedQuery: string | null = null;
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/threads") && !u.includes("/threads/")) {
        capturedQuery = decodeURIComponent(new URL(u).searchParams.get("q") ?? "");
        return makeGmailResponse({ threads: [] });
      }
      return makeGmailResponse({});
    };

    await runDrain();
    assert.ok(capturedQuery, "query deve ter sido capturada");
    assert.ok(
      capturedQuery!.startsWith("in:sent {to:diariaeditor@gmail.com to:diaria.editor@gmail.com}"),
      `query default incorreta: ${capturedQuery}`,
    );
    assert.ok(!capturedQuery!.includes("label:"), "query default não deve mais usar label:");
  });

  it("#3362: mensagem endereçada a diaria.editor@gmail.com (COM ponto) é parseada em entrada de inbox", async () => {
    // Regressão do bug real: Gmail entrega diariaeditor@ e diaria.editor@ na
    // mesma caixa (ignora pontos), mas o operador `to:` de busca não
    // normaliza pontos — sem o `{ }` OR na query, mensagens endereçadas ao
    // formato COM ponto nunca eram encontradas (perdido por >2 meses em prod).
    const config = JSON.parse(savedConfig ?? "{}");
    config.inbox = {
      ...(config.inbox ?? {}),
      gmailQuery: "in:sent {to:diariaeditor@gmail.com to:diaria.editor@gmail.com}",
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");

    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-07-07T00:00:00Z",
      consecutive_empty_drains: 0,
    }), "utf8");

    const bodyText = "Confira https://openai.com/academy/prompting-com-ponto";
    const b64 = Buffer.from(bodyText).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/threads") && !u.includes("/threads/")) {
        return makeGmailResponse({ threads: [{ id: "tdotted", snippet: "x" }] });
      }
      if (u.includes("/threads/tdotted")) {
        return makeGmailResponse({
          id: "tdotted",
          messages: [{
            id: "m1",
            internalDate: String(new Date("2026-07-08T11:00:00Z").getTime()),
            payload: {
              mimeType: "text/plain",
              body: { data: b64 },
              headers: [
                { name: "From", value: "vjpixel@gmail.com" },
                { name: "Subject", value: "Pick do dia (ponto)" },
                { name: "To", value: "diaria.editor@gmail.com" },
              ],
            },
          }],
        });
      }
      return makeGmailResponse({});
    };

    const output = await runDrain();
    assert.equal(output.new_entries, 1, "mensagem endereçada ao formato com ponto deve virar 1 entrada");
    assert.ok(
      output.urls.some((u) => u.url === "https://openai.com/academy/prompting-com-ponto"),
      "URL do e-mail (formato com ponto) deve aparecer em output.urls",
    );
  });

  it("#3217: mensagem encontrada via in:sent to:diariaeditor@gmail.com é parseada em entrada de inbox", async () => {
    // Config explícita com a nova query — simula o cenário real #3199/#3215:
    // 12 e-mails na pasta Sent do editor, sem label nenhum aplicado.
    const config = JSON.parse(savedConfig ?? "{}");
    config.inbox = { ...(config.inbox ?? {}), gmailQuery: "in:sent to:diariaeditor@gmail.com" };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");

    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-07-07T00:00:00Z",
      consecutive_empty_drains: 0,
    }), "utf8");

    const bodyText = "Confira https://openai.com/academy/prompting";
    const b64 = Buffer.from(bodyText).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/threads") && !u.includes("/threads/")) {
        return makeGmailResponse({ threads: [{ id: "tsent", snippet: "x" }] });
      }
      if (u.includes("/threads/tsent")) {
        return makeGmailResponse({
          id: "tsent",
          messages: [{
            id: "m1",
            internalDate: String(new Date("2026-07-08T11:00:00Z").getTime()),
            payload: {
              mimeType: "text/plain",
              body: { data: b64 },
              headers: [
                { name: "From", value: "vjpixel@gmail.com" },
                { name: "Subject", value: "Pick do dia" },
                { name: "To", value: "diariaeditor@gmail.com" },
              ],
            },
          }],
        });
      }
      return makeGmailResponse({});
    };

    const output = await runDrain();
    assert.equal(output.new_entries, 1, "e-mail encontrado via in:sent deve virar 1 entrada");
    assert.ok(
      (output.urls as Array<{ url: string }>).some((u) => u.url === "https://openai.com/academy/prompting"),
      "URL da submissão deve estar no resultado",
    );
    assert.ok(existsSync(INBOX_PATH));
    const inboxContent = readFileSync(INBOX_PATH, "utf8");
    assert.ok(inboxContent.includes("https://openai.com/academy/prompting"));
  });

  it("#3217: caminho de label foi removido — não chama /labels e não produz label_filter_warning", async () => {
    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-04-01T00:00:00Z",
      consecutive_empty_drains: 0,
    }), "utf8");

    let labelsEndpointCalled = false;
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/labels")) {
        labelsEndpointCalled = true;
        return makeGmailResponse({ labels: [] });
      }
      if (u.includes("/threads") && !u.includes("/threads/")) {
        return makeGmailResponse({ threads: [] });
      }
      return makeGmailResponse({});
    };

    const output = await runDrain();
    assert.equal(labelsEndpointCalled, false, "drain não deve mais chamar o endpoint /labels");
    assert.equal(
      "label_filter_warning" in output,
      false,
      "output não deve mais ter o campo label_filter_warning (mecanismo removido)",
    );
  });

  it("primary query empty acima do threshold → silent_reset, new_entries=0 (#900)", async () => {
    writeFileSync(CURSOR_PATH, JSON.stringify({
      last_drain_iso: "2026-04-01T00:00:00Z",
      consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
    }), "utf8");

    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/threads")) {
        return makeGmailResponse({ threads: [] });
      }
      return makeGmailResponse({});
    };

    let threw = false;
    let output: Record<string, unknown> = {};
    try {
      output = await runDrain();
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "drainMain() não deve lançar exceção quando inbox vazio");
    assert.equal(output.new_entries, 0);
    assert.equal(output.skipped, false, "skipped=false — drain rodou, só não tinha email");
    // Cursor pós-silent_reset: consecutive_empty_drains zerado
    const cursor = JSON.parse(readFileSync(CURSOR_PATH, "utf8"));
    assert.equal(cursor.consecutive_empty_drains, 0, "silent_reset deve zerar contador");
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
