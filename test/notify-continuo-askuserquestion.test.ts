/**
 * test/notify-continuo-askuserquestion.test.ts (#5293, canal e-mail #5341)
 *
 * Cobre `.claude/hooks/notify-continuo-askuserquestion.mjs` — fecha a
 * lacuna registrada em `.claude/skills/diaria-continuo/SKILL.md`
 * §"Risco aceito": um `AskUserQuestion` bloqueante rodando numa sessão
 * `/diaria-continuo` de TERMINAL (não pelo chat drawer do Studio) não
 * disparava nem `studio-push-notify.ts` nem `gate-chat-bridge.js` — os
 * dois só cobrem sessões abertas PELO chat drawer. Este hook cobre
 * especificamente o caminho de terminal, via Gmail API direta (canal
 * definido em #5341).
 *
 * Testa só as funções PURAS/injetáveis exportadas pelo hook — a integração
 * fim-a-fim (leitura de stdin, `execFileSync` real) não é reexercitada aqui,
 * mesmo padrão de `test/block-askuserquestion-overnight-autonomous.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findActiveContinuoSession,
  summarizePendingQuestion,
  resolveEditorEmailInline,
  buildNotifyMessage,
  ensureAccessToken,
  sendNotification,
} from "../.claude/hooks/notify-continuo-askuserquestion.mjs";
// #4344: mesmo nome de env var que scripts/google-auth.ts exporta como
// CREDENTIALS_PATH_TEST_OVERRIDE_ENV — o hook lê a STRING literal
// "DIARIA_TEST_CREDENTIALS_PATH" diretamente (self-contained, não importa
// google-auth.ts), então este teste replica o valor aqui em vez de importar,
// pra não acoplar o teste a um import de scripts/*.ts só por uma constante.
const CREDENTIALS_PATH_TEST_OVERRIDE_ENV = "DIARIA_TEST_CREDENTIALS_PATH";

function tmp() {
  return mkdtempSync(join(tmpdir(), "notify-continuo-"));
}

function writeSession(repoRoot, kind, tag, sessionId, record) {
  mkdirSync(join(repoRoot, "data", "sessions"), { recursive: true });
  writeFileSync(join(repoRoot, "data", "sessions", `${kind}-${tag}-${sessionId}.json`), JSON.stringify(record));
}

// #4344: NUNCA escreve em `data/.credentials.json` REAL (nem sob um `repoRoot`
// fake) — grava o fake num dir `mkdtempSync` PRÓPRIO, sem segmento "data", e
// aponta o hook pra lá via `CREDENTIALS_PATH_TEST_OVERRIDE_ENV` (mesmo padrão
// de `test/drive-sync.test.ts`; `loadCredentials` do hook já prioriza esse
// env var sobre `join(repoRoot, "data", ".credentials.json")`). Retorna uma
// função de cleanup que restaura o env var anterior e remove o dir temporário
// — cada teste chama isso em `finally`, mesmo padrão de `tmp()` acima.
function withFakeCredentials(creds) {
  const prevOverride = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
  const credsDir = mkdtempSync(join(tmpdir(), "notify-continuo-creds-"));
  const credsPath = join(credsDir, ".credentials.json");
  writeFileSync(credsPath, JSON.stringify(creds));
  process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = credsPath;
  return () => {
    if (prevOverride === undefined) delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
    else process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = prevOverride;
    rmSync(credsDir, { recursive: true, force: true });
  };
}

describe("findActiveContinuoSession (#5293)", () => {
  const NOW = Date.parse("2026-08-14T12:00:00.000Z");

  it("data/sessions/ ausente → null", () => {
    const dir = tmp();
    try {
      assert.equal(findActiveContinuoSession(dir, "sess-1", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessionId ausente/vazio → null (nunca varre à toa)", () => {
    const dir = tmp();
    try {
      assert.equal(findActiveContinuoSession(dir, undefined, NOW), null);
      assert.equal(findActiveContinuoSession(dir, "", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessão continuo ativa (heartbeat recente) → encontrada", () => {
    const dir = tmp();
    try {
      writeSession(dir, "continuo", "host-a", "sess-live", {
        kind: "continuo",
        sessionId: "sess-live",
        startedAt: "2026-08-14T10:00:00.000Z",
        lastHeartbeat: "2026-08-14T11:55:00.000Z",
      });
      const found = findActiveContinuoSession(dir, "sess-live", NOW);
      assert.ok(found);
      assert.equal(found.sessionId, "sess-live");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessão de OUTRO kind (overnight) com o mesmo sessionId → não conta (filtro por prefixo de arquivo)", () => {
    const dir = tmp();
    try {
      writeSession(dir, "overnight", "host-a", "sess-x", {
        kind: "overnight",
        sessionId: "sess-x",
        lastHeartbeat: "2026-08-14T11:55:00.000Z",
      });
      assert.equal(findActiveContinuoSession(dir, "sess-x", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#6934 review fleet (PR #7051, finding 6) — arquivo continuo-review-*.json (kind dedicado do merge-lock, NÃO continuo) não conta, mesmo casando o filtro de nome por prefixo", () => {
    // "continuo-review-tag-id.json" começa com "continuo-" — o filtro de
    // nome (`name.startsWith("continuo-")`) sozinho deixaria passar um
    // registro que NUNCA deveria disparar a notificação de continuo (mesma
    // classe de bug corrigida em `findExistingSessionFile`,
    // session-beacon.mjs, e `parseSessionFileName`, session-registry.ts).
    // `continuo-pr-review.sh` nunca escreve esse arquivo hoje (só chama
    // merge-lock-acquire/-release) — este teste é defesa preventiva, mesmo
    // racional do commit que corrigiu session-beacon.mjs.
    const dir = tmp();
    try {
      writeSession(dir, "continuo-review", "helios", "sess-x", {
        kind: "continuo-review",
        sessionId: "sess-x",
        lastHeartbeat: "2026-08-14T11:55:00.000Z",
      });
      assert.equal(findActiveContinuoSession(dir, "sess-x", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessão continuo STALE (heartbeat > 24h atrás) → null", () => {
    const dir = tmp();
    try {
      writeSession(dir, "continuo", "host-a", "sess-stale", {
        kind: "continuo",
        sessionId: "sess-stale",
        lastHeartbeat: "2026-08-10T10:00:00.000Z", // > 24h antes de NOW
      });
      assert.equal(findActiveContinuoSession(dir, "sess-stale", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessão continuo com heartbeat 'no futuro' (clock skew) → null (fail-safe, não finge ativa)", () => {
    const dir = tmp();
    try {
      writeSession(dir, "continuo", "host-a", "sess-future", {
        kind: "continuo",
        sessionId: "sess-future",
        lastHeartbeat: "2026-08-15T00:00:00.000Z", // depois de NOW
      });
      assert.equal(findActiveContinuoSession(dir, "sess-future", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON corrompido no arquivo de sessão → null, sem lançar", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "data", "sessions"), { recursive: true });
      writeFileSync(join(dir, "data", "sessions", "continuo-host-a-sess-broken.json"), "{ isto não é json");
      assert.doesNotThrow(() => findActiveContinuoSession(dir, "sess-broken", NOW));
      assert.equal(findActiveContinuoSession(dir, "sess-broken", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("record.sessionId no arquivo diverge do nome do arquivo → não conta (paranoia contra colisão de nome)", () => {
    const dir = tmp();
    try {
      writeSession(dir, "continuo", "host-a", "sess-mismatch", {
        kind: "continuo",
        sessionId: "outro-id-completamente-diferente",
        lastHeartbeat: "2026-08-14T11:55:00.000Z",
      });
      assert.equal(findActiveContinuoSession(dir, "sess-mismatch", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("summarizePendingQuestion (#5293)", () => {
  it("extrai header + question da primeira pergunta", () => {
    const toolInput = { questions: [{ header: "Escopo", question: "Cat. D destrava?" }] };
    assert.equal(summarizePendingQuestion(toolInput), "[Escopo] Cat. D destrava?");
  });

  it("sem header → só a pergunta", () => {
    const toolInput = { questions: [{ question: "Sem header aqui" }] };
    assert.equal(summarizePendingQuestion(toolInput), "Sem header aqui");
  });

  it("tool_input ausente/malformado → null, nunca lança", () => {
    assert.equal(summarizePendingQuestion(undefined), null);
    assert.equal(summarizePendingQuestion({}), null);
    assert.equal(summarizePendingQuestion({ questions: [] }), null);
  });

  it("pergunta muito longa é truncada (corpo do e-mail não fica gigante)", () => {
    const longQuestion = "x".repeat(500);
    const toolInput = { questions: [{ question: longQuestion }] };
    const summary = summarizePendingQuestion(toolInput);
    assert.ok(summary.length <= 301);
    assert.ok(summary.endsWith("…"));
  });
});

describe("resolveEditorEmailInline (#5341)", () => {
  it("platform.config.json ausente → default vjpixel@gmail.com", () => {
    const dir = tmp();
    try {
      assert.equal(resolveEditorEmailInline(dir), "vjpixel@gmail.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lê inbox.editor_personal_email quando presente", () => {
    const dir = tmp();
    try {
      writeFileSync(
        join(dir, "platform.config.json"),
        JSON.stringify({ inbox: { editor_personal_email: "outro@example.com" } }),
      );
      assert.equal(resolveEditorEmailInline(dir), "outro@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON corrompido → default, nunca lança", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "platform.config.json"), "{ nao e json");
      assert.doesNotThrow(() => resolveEditorEmailInline(dir));
      assert.equal(resolveEditorEmailInline(dir), "vjpixel@gmail.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildNotifyMessage (#5293, subject/body #5341)", () => {
  it("inclui o session_id no subject e no body", () => {
    const msg = buildNotifyMessage("sess-123", null);
    assert.match(msg.subject, /sess-123/);
    assert.match(msg.body, /sess-123/);
    assert.match(msg.body, /continuo/);
  });

  it("inclui o resumo da pergunta no body quando disponível", () => {
    const msg = buildNotifyMessage("sess-123", "[Escopo] Cat. D destrava?");
    assert.match(msg.body, /Cat\. D destrava\?/);
  });
});

describe("ensureAccessToken (#5341)", () => {
  it("access_token ainda válido (não perto de expirar) → retorna sem chamar fetch", async () => {
    let called = false;
    const token = await ensureAccessToken(
      { access_token: "still-valid", expiry_ms: Date.now() + 60 * 60_000 },
      async () => {
        called = true;
        return { ok: true, json: async () => ({}) };
      },
    );
    assert.equal(token, "still-valid");
    assert.equal(called, false);
  });

  it("access_token expirado → refresh via fetch, retorna o novo token", async () => {
    const token = await ensureAccessToken(
      {
        access_token: "old",
        expiry_ms: Date.now() - 1000,
        client_id: "cid",
        client_secret: "secret",
        refresh_token: "rtok",
      },
      async () => ({ ok: true, json: async () => ({ access_token: "new-token" }) }),
    );
    assert.equal(token, "new-token");
  });

  it("refresh HTTP não-2xx → null, nunca lança", async () => {
    const token = await ensureAccessToken(
      { access_token: "old", expiry_ms: 0 },
      async () => ({ ok: false, status: 401 }),
    );
    assert.equal(token, null);
  });

  it("refresh lançando (rede/timeout) → null, nunca propaga", async () => {
    const token = await ensureAccessToken(
      { access_token: "old", expiry_ms: 0 },
      async () => {
        throw new Error("network down");
      },
    );
    assert.equal(token, null);
  });
});

describe("sendNotification (#5293 fleet review achado 4, canal Gmail #5341)", () => {
  function captureStderr(fn) {
    let output = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      output += String(chunk);
      return true;
    };
    return Promise.resolve(fn()).finally(() => {
      process.stderr.write = originalWrite;
    }).then(() => output);
  }

  it("sem credenciais (nenhum override + repoRoot sem data/.credentials.json) → no-op silencioso (fetch nunca chamado)", async () => {
    const dir = tmp();
    const prevOverride = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
    delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV]; // garante o caminho "sem credenciais" mesmo se outro teste vazou o env var
    try {
      let fetchCalled = false;
      await sendNotification({ subject: "s", body: "b" }, dir, async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({}) };
      });
      assert.equal(fetchCalled, false);
    } finally {
      if (prevOverride === undefined) delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
      else process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = prevOverride;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refresh falho (token revogado) é LOGADO em stderr — nunca descartado silenciosamente", async () => {
    const dir = tmp();
    const cleanupCreds = withFakeCredentials({
      access_token: "old",
      expiry_ms: 0,
      client_id: "cid",
      client_secret: "secret",
      refresh_token: "rtok",
    });
    try {
      const output = await captureStderr(() =>
        sendNotification({ subject: "s", body: "b" }, dir, async (url) => {
          if (String(url).includes("oauth2.googleapis.com")) return { ok: false, status: 401 };
          throw new Error("não deveria chamar o envio sem token");
        }),
      );
      assert.match(output, /refresh/i);
    } finally {
      cleanupCreds();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resposta HTTP não-2xx do envio é LOGADA em stderr (rate limit/permissão) — nunca descartada silenciosamente", async () => {
    const dir = tmp();
    const cleanupCreds = withFakeCredentials({ access_token: "valid", expiry_ms: Date.now() + 60 * 60_000 });
    try {
      const output = await captureStderr(() =>
        sendNotification({ subject: "s", body: "b" }, dir, async () => ({
          ok: false,
          status: 429,
          text: async () => "Rate limit exceeded",
        })),
      );
      assert.match(output, /429/);
      assert.match(output, /Rate limit exceeded/);
    } finally {
      cleanupCreds();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exceção de rede no envio (timeout/DNS/etc) é LOGADA em stderr, nunca lançada pro caller", async () => {
    const dir = tmp();
    const cleanupCreds = withFakeCredentials({ access_token: "valid", expiry_ms: Date.now() + 60 * 60_000 });
    try {
      const output = await captureStderr(async () => {
        await assert.doesNotReject(
          sendNotification({ subject: "s", body: "b" }, dir, async () => {
            throw new Error("network down");
          }),
        );
      });
      assert.match(output, /network down/);
    } finally {
      cleanupCreds();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resposta 2xx → nada é escrito em stderr, e o e-mail vai pro editor resolvido de platform.config.json", async () => {
    const dir = tmp();
    const cleanupCreds = withFakeCredentials({ access_token: "valid", expiry_ms: Date.now() + 60 * 60_000 });
    try {
      writeFileSync(
        join(dir, "platform.config.json"),
        JSON.stringify({ inbox: { editor_personal_email: "editor@example.com" } }),
      );
      let sentTo = null;
      const output = await captureStderr(() =>
        sendNotification({ subject: "assunto", body: "corpo" }, dir, async (_url, opts) => {
          const raw = JSON.parse(opts.body).raw;
          const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
          sentTo = decoded.match(/^To: (.+)$/m)?.[1];
          return { ok: true, json: async () => ({ id: "1", threadId: "1" }) };
        }),
      );
      assert.equal(output, "");
      assert.equal(sentTo, "editor@example.com");
    } finally {
      cleanupCreds();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
