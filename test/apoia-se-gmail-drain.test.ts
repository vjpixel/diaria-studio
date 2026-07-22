/**
 * test/apoia-se-gmail-drain.test.ts (#3859 metade 1)
 *
 * Cobertura de scripts/lib/apoia-se-gmail-drain.ts:
 * - `parseApoioNotificationEmail` (pure) com os 3 exemplos reais confirmados
 *   ao vivo (260722) + casos de borda (acento, decimal com vírgula, corpo
 *   sem match).
 * - cursor round-trip (`loadGmailDrainCursor`/`saveGmailDrainCursor`), mesmo
 *   formato/tratamento de clock-drift de `data/inbox-cursor.json`.
 * - `drainApoiaSeNotifications` fim-a-fim com `gmailFetch` injetado (nunca
 *   rede real) — extração de notificações, filtro por cursor, avanço do
 *   cursor, fail-soft de thread individual, e distinção auth_expired vs
 *   falha transiente na busca.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseApoioNotificationEmail,
  gmailDrainCursorPath,
  loadGmailDrainCursor,
  saveGmailDrainCursor,
  drainApoiaSeNotifications,
  APOIA_SE_GMAIL_QUERY,
} from "../scripts/lib/apoia-se-gmail-drain.ts";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeThreadSummary(id: string) {
  return { id, snippet: "" };
}

function makePlainMessage(id: string, internalDate: string, bodyText: string) {
  return {
    id,
    internalDate,
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Novo apoio!" }],
      body: { data: b64url(bodyText) },
    },
    threadId: id,
  };
}

// ─── parseApoioNotificationEmail ─────────────────────────────────────────

describe("parseApoioNotificationEmail (#3859)", () => {
  it("exemplo real 1: ALMIR — R$25 sem decimal", () => {
    const body = "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$25* !";
    const parsed = parseApoioNotificationEmail(body);
    assert.deepEqual(parsed, { name: "ALMIR", email: "alalmas@gmail.com", value: 25 });
  });

  it("exemplo real 2: Monica — R$5", () => {
    const body = "Monica <sintetica@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$5* !";
    const parsed = parseApoioNotificationEmail(body);
    assert.deepEqual(parsed, { name: "Monica", email: "sintetica@gmail.com", value: 5 });
  });

  it("exemplo real 3: LUIS — email .usp.br", () => {
    const body = "LUIS <lfangerami@usp.br> acabou de apoiar sua campanha diar.ia.br com o valor de *R$5* !";
    const parsed = parseApoioNotificationEmail(body);
    assert.deepEqual(parsed, { name: "LUIS", email: "lfangerami@usp.br", value: 5 });
  });

  it("nome com acento é preservado", () => {
    const body = "José <jose@x.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$10* !";
    const parsed = parseApoioNotificationEmail(body);
    assert.deepEqual(parsed, { name: "José", email: "jose@x.com", value: 10 });
  });

  it("valor com vírgula decimal é normalizado pra ponto", () => {
    const body = "Ana <ana@x.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$25,50* !";
    const parsed = parseApoioNotificationEmail(body);
    assert.equal(parsed?.value, 25.5);
  });

  it("email em maiúsculas é normalizado pra minúsculas", () => {
    const body = "Bia <BIA@X.COM> acabou de apoiar sua campanha diar.ia.br com o valor de *R$5* !";
    const parsed = parseApoioNotificationEmail(body);
    assert.equal(parsed?.email, "bia@x.com");
  });

  it("linha embutida em corpo maior (saudação + assinatura) ainda é encontrada", () => {
    const body = [
      "Olá!",
      "",
      "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$25* !",
      "",
      "Equipe apoia.se",
    ].join("\n");
    const parsed = parseApoioNotificationEmail(body);
    assert.deepEqual(parsed, { name: "ALMIR", email: "alalmas@gmail.com", value: 25 });
  });

  it("sem os asteriscos de markdown também casa (template pode variar)", () => {
    const body = "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de R$25 !";
    const parsed = parseApoioNotificationEmail(body);
    assert.deepEqual(parsed, { name: "ALMIR", email: "alalmas@gmail.com", value: 25 });
  });

  it("corpo sem match (e-mail de marketing/suporte comunidade@apoia.se) retorna null", () => {
    const body = "Confira as novidades da comunidade apoia.se este mês! Novos recursos disponíveis.";
    assert.equal(parseApoioNotificationEmail(body), null);
  });

  it("corpo vazio retorna null", () => {
    assert.equal(parseApoioNotificationEmail(""), null);
  });

  it("corpo com <> mas sem a frase-gatilho retorna null", () => {
    const body = "Fulano <fulano@x.com> disse oi, mas não apoiou nada aqui.";
    assert.equal(parseApoioNotificationEmail(body), null);
  });
});

// ─── cursor round-trip ────────────────────────────────────────────────────

describe("gmailDrainCursorPath / loadGmailDrainCursor / saveGmailDrainCursor (#3859)", () => {
  it("path segue o mesmo formato de data/inbox-cursor.json, sob data/apoia-se/", () => {
    const path = gmailDrainCursorPath("/root");
    assert.match(path, /apoia-se[\\/]gmail-drain-cursor\.json$/);
  });

  it("cursor ausente -> last_drain_iso null", () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-cursor-absent-"));
    try {
      assert.deepEqual(loadGmailDrainCursor(root), { last_drain_iso: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("save + load round-trip preserva o valor", () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-cursor-roundtrip-"));
    try {
      saveGmailDrainCursor(root, { last_drain_iso: "2026-07-01T00:00:00.000Z" });
      assert.deepEqual(loadGmailDrainCursor(root), { last_drain_iso: "2026-07-01T00:00:00.000Z" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cursor no futuro (clock drift) é resetado pra null, mesmo guard de inbox-drain.ts #441", () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-cursor-future-"));
    try {
      const futureIso = new Date(Date.now() + 86_400_000).toISOString();
      mkdirSync(join(root, "data", "apoia-se"), { recursive: true });
      writeFileSync(
        join(root, "data", "apoia-se", "gmail-drain-cursor.json"),
        JSON.stringify({ last_drain_iso: futureIso }),
      );
      assert.deepEqual(loadGmailDrainCursor(root), { last_drain_iso: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cursor corrompido (JSON inválido) é tratado como ausente", () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-cursor-corrupt-"));
    try {
      mkdirSync(join(root, "data", "apoia-se"), { recursive: true });
      writeFileSync(join(root, "data", "apoia-se", "gmail-drain-cursor.json"), "{not json");
      assert.deepEqual(loadGmailDrainCursor(root), { last_drain_iso: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── drainApoiaSeNotifications — fim-a-fim com gmailFetch injetado ──────

describe("drainApoiaSeNotifications (#3859)", () => {
  it("busca a query esperada e extrai notificações do corpo text/plain", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-happy-"));
    try {
      const calledUrls: string[] = [];
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        calledUrls.push(u);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
        // threads/t1?format=full
        return new Response(
          JSON.stringify({
            id: "t1",
            messages: [
              makePlainMessage(
                "m1",
                "1752652800000",
                "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$25* !",
              ),
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.skipped, false);
      assert.equal(result.notifications.length, 1);
      assert.deepEqual(result.notifications[0], { name: "ALMIR", email: "alalmas@gmail.com", value: 25 });
      assert.ok(calledUrls[0].includes("threads?"));
      const searchUrl = new URL(calledUrls[0]);
      assert.equal(searchUrl.searchParams.get("q"), APOIA_SE_GMAIL_QUERY);

      // Cursor avançou pro internalDate da mensagem processada.
      const cursor = loadGmailDrainCursor(root);
      assert.equal(cursor.last_drain_iso, new Date(1752652800000).toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mensagens mais antigas que o cursor são filtradas (não re-processadas)", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-cursor-filter-"));
    try {
      saveGmailDrainCursor(root, { last_drain_iso: new Date(1752652800000).toISOString() });
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "t1",
            messages: [
              // Mesma data do cursor -> filtrada (iso <= lastDrain).
              makePlainMessage(
                "m1",
                "1752652800000",
                "Velho <velho@x.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$5* !",
              ),
              // Mais recente -> passa.
              makePlainMessage(
                "m2",
                "1752739200000",
                "Novo <novo@x.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$10* !",
              ),
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.notifications.length, 1);
      assert.equal(result.notifications[0].email, "novo@x.com");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("thread individual que falha ao carregar é pulada (fail-soft) e contada em errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-thread-error-"));
    try {
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("bad"), makeThreadSummary("good")] }), {
            status: 200,
          });
        }
        if (u.includes("threads/bad")) {
          return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
        }
        return new Response(
          JSON.stringify({
            id: "good",
            messages: [
              makePlainMessage(
                "m1",
                "1752652800000",
                "OK <ok@x.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$5* !",
              ),
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.notifications.length, 1);
      assert.equal(result.notifications[0].email, "ok@x.com");
      assert.equal(result.errors, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("corpo de e-mail sem match (marketing/suporte) não vira notificação — nunca lança", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-nomatch-"));
    try {
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "t1",
            messages: [makePlainMessage("m1", "1752652800000", "Newsletter da comunidade apoia.se este mês.")],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });
      assert.equal(result.notifications.length, 0);
      assert.equal(result.skipped, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falha de busca por auth expirado -> skipped true, reason auth_expired, auth_expired flag", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-authexpired-"));
    try {
      const gmailFetch = (async () =>
        new Response(JSON.stringify({ error: { message: "invalid_grant" } }), { status: 401 })) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.skipped, true);
      assert.equal(result.reason, "auth_expired");
      assert.equal(result.auth_expired, true);
      assert.equal(result.notifications.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falha de busca transiente (rede) -> skipped true, reason search_failed, sem auth_expired", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-transient-"));
    try {
      const gmailFetch = (async () => {
        throw new Error("ECONNRESET socket hang up");
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.skipped, true);
      assert.equal(result.reason, "search_failed");
      assert.equal(result.auth_expired, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cursor NÃO avança quando a busca falha (reprocessa na próxima tentativa)", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-nofailadvance-"));
    try {
      saveGmailDrainCursor(root, { last_drain_iso: "2026-07-01T00:00:00.000Z" });
      const gmailFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

      await drainApoiaSeNotifications(root, { gmailFetch });

      assert.deepEqual(loadGmailDrainCursor(root), { last_drain_iso: "2026-07-01T00:00:00.000Z" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nenhuma thread encontrada -> notifications vazio, skipped false, cursor mantido", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-empty-"));
    try {
      const gmailFetch = (async () => new Response(JSON.stringify({ threads: [] }), { status: 200 })) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.skipped, false);
      assert.deepEqual(result.notifications, []);
      assert.equal(result.most_recent_iso, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
