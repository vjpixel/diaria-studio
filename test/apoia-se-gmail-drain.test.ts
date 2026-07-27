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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseApoioNotificationEmail,
  parsePromessaEmail,
  gmailDrainCursorPath,
  loadGmailDrainCursor,
  saveGmailDrainCursor,
  drainApoiaSeNotifications,
  unparsedQuarantinePath,
  appendUnparsedQuarantine,
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

  it("#4171 — as 3 variantes de posição do asterisco parseiam pro MESMO resultado (fecha a classe, não só a instância da promessa)", () => {
    const semAsterisco =
      "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de R$25 !";
    const asteriscoAntes =
      "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$25* !";
    const asteriscoDepois =
      "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de R$ *25* !";
    const esperado = { name: "ALMIR", email: "alalmas@gmail.com", value: 25 };
    assert.deepEqual(parseApoioNotificationEmail(semAsterisco), esperado);
    assert.deepEqual(parseApoioNotificationEmail(asteriscoAntes), esperado);
    assert.deepEqual(parseApoioNotificationEmail(asteriscoDepois), esperado);
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

  it("corpo de PROMESSA (não confirmado) retorna null — parser certo é parsePromessaEmail", () => {
    const body = "Ivan <ivan.andrade81@gmail.com> recém prometeu um apoio de R$10";
    assert.equal(parseApoioNotificationEmail(body), null);
  });
});

// ─── parsePromessaEmail (#3912) ──────────────────────────────────────────

describe("parsePromessaEmail (#3912)", () => {
  it("#4171 — corpo REAL da apoia.se (260727, Raul): asterisco DEPOIS do R$ (R$ *10*), não antes — TRAVA O BUG", () => {
    // Corpo text/plain real capturado da mensagem Gmail 19fa424ce8e48ec7,
    // 2026-07-27T15:15:02Z. Este é o formato que a apoia.se realmente manda —
    // a versão anterior de PROMESSA_LINE_RE só tolerava asterisco ANTES do
    // `R$` e retornava null pra este corpo (por isso a promessa do Raul foi
    // perdida em produção). Se este teste falhar, o fix de #4171 regrediu.
    const body =
      "Raul <raul.jperez@gmail.com> recém prometeu um apoio de R$ *10* para sua campanha diar.ia.br.";
    const parsed = parsePromessaEmail(body);
    assert.deepEqual(parsed, { name: "Raul", email: "raul.jperez@gmail.com", value: 10 });
  });

  it("#4171 — as 3 variantes de posição do asterisco parseiam pro MESMO resultado", () => {
    const semAsterisco = "Raul <raul.jperez@gmail.com> recém prometeu um apoio de R$10";
    const asteriscoAntes = "Raul <raul.jperez@gmail.com> recém prometeu um apoio de *R$10*";
    const asteriscoDepois = "Raul <raul.jperez@gmail.com> recém prometeu um apoio de R$ *10*";
    const esperado = { name: "Raul", email: "raul.jperez@gmail.com", value: 10 };
    assert.deepEqual(parsePromessaEmail(semAsterisco), esperado);
    assert.deepEqual(parsePromessaEmail(asteriscoAntes), esperado);
    assert.deepEqual(parsePromessaEmail(asteriscoDepois), esperado);
  });

  it("caso comprovado 260722: Ivan — promessa de R$10", () => {
    const body = "Ivan <ivan.andrade81@gmail.com> recém prometeu um apoio de R$10";
    const parsed = parsePromessaEmail(body);
    assert.deepEqual(parsed, { name: "Ivan", email: "ivan.andrade81@gmail.com", value: 10 });
  });

  it("com asteriscos de markdown e pontuação final também casa", () => {
    const body = "Ivan <ivan.andrade81@gmail.com> recém prometeu um apoio de *R$10* !";
    const parsed = parsePromessaEmail(body);
    assert.deepEqual(parsed, { name: "Ivan", email: "ivan.andrade81@gmail.com", value: 10 });
  });

  it("'recem' sem acento também casa (variação de encoding/template)", () => {
    const body = "Ivan <ivan.andrade81@gmail.com> recem prometeu um apoio de R$10";
    const parsed = parsePromessaEmail(body);
    assert.equal(parsed?.name, "Ivan");
  });

  it("valor com vírgula decimal é normalizado pra ponto", () => {
    const body = "Ana <ana@x.com> recém prometeu um apoio de R$25,50";
    assert.equal(parsePromessaEmail(body)?.value, 25.5);
  });

  it("email em maiúsculas é normalizado pra minúsculas", () => {
    const body = "Bia <BIA@X.COM> recém prometeu um apoio de R$5";
    assert.equal(parsePromessaEmail(body)?.email, "bia@x.com");
  });

  it("linha embutida em corpo maior (saudação + assinatura) ainda é encontrada", () => {
    const body = [
      "Você tem uma nova promessa de apoiador! :D",
      "",
      "Ivan <ivan.andrade81@gmail.com> recém prometeu um apoio de R$10",
      "",
      "Equipe apoia.se",
    ].join("\n");
    const parsed = parsePromessaEmail(body);
    assert.deepEqual(parsed, { name: "Ivan", email: "ivan.andrade81@gmail.com", value: 10 });
  });

  it("corpo de APOIO CONFIRMADO (não promessa) retorna null — parser certo é parseApoioNotificationEmail", () => {
    const body = "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$25* !";
    assert.equal(parsePromessaEmail(body), null);
  });

  it("corpo sem match (marketing/suporte) retorna null", () => {
    const body = "Confira as novidades da comunidade apoia.se este mês!";
    assert.equal(parsePromessaEmail(body), null);
  });

  it("corpo vazio retorna null", () => {
    assert.equal(parsePromessaEmail(""), null);
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

// ─── quarentena de mensagens não-parseadas (#4171) ──────────────────────

describe("unparsedQuarantinePath / appendUnparsedQuarantine (#4171)", () => {
  it("path segue a convenção de gmail-drain-cursor.json, sob data/apoia-se/", () => {
    const path = unparsedQuarantinePath("/root");
    assert.match(path, /apoia-se[\\/]unparsed-quarantine\.jsonl$/);
  });

  it("append cria o arquivo (+diretório) se ausente e escreve 1 linha JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-unparsed-quarantine-create-"));
    try {
      appendUnparsedQuarantine(root, {
        messageId: "m1",
        threadId: "t1",
        receivedAtIso: "2026-07-27T15:15:02.000Z",
        bodySnippet: "corpo não reconhecido",
      });
      const raw = readFileSync(unparsedQuarantinePath(root), "utf-8");
      const lines = raw.trim().split("\n");
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), {
        messageId: "m1",
        threadId: "t1",
        receivedAtIso: "2026-07-27T15:15:02.000Z",
        bodySnippet: "corpo não reconhecido",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("2 appends acumulam (append-only, não sobrescreve)", () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-unparsed-quarantine-accumulate-"));
    try {
      appendUnparsedQuarantine(root, {
        messageId: "m1",
        threadId: "t1",
        receivedAtIso: "2026-07-27T15:15:02.000Z",
        bodySnippet: "primeiro",
      });
      appendUnparsedQuarantine(root, {
        messageId: "m2",
        threadId: "t1",
        receivedAtIso: "2026-07-27T16:00:00.000Z",
        bodySnippet: "segundo",
      });
      const lines = readFileSync(unparsedQuarantinePath(root), "utf-8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).messageId, "m1");
      assert.equal(JSON.parse(lines[1]).messageId, "m2");
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

  // ─── promessas (#3912) ─────────────────────────────────────────────────

  it("query busca AMBOS os templates (novo apoio OR nova promessa)", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-query-both-"));
    try {
      const gmailFetch = (async () => new Response(JSON.stringify({ threads: [] }), { status: 200 })) as typeof fetch;
      await drainApoiaSeNotifications(root, { gmailFetch });
      assert.match(APOIA_SE_GMAIL_QUERY, /novo apoio/);
      assert.match(APOIA_SE_GMAIL_QUERY, /nova promessa/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mensagem de PROMESSA vai pra promessas[], não pra notifications[] — nunca confunde os 2 templates", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-promessa-"));
    try {
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "t1",
            messages: [
              makePlainMessage(
                "m1",
                "1752652800000",
                "Ivan <ivan.andrade81@gmail.com> recém prometeu um apoio de R$10",
              ),
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.deepEqual(result.notifications, []);
      assert.equal(result.promessas?.length, 1);
      assert.equal(result.promessas?.[0].name, "Ivan");
      assert.equal(result.promessas?.[0].email, "ivan.andrade81@gmail.com");
      assert.equal(result.promessas?.[0].value, 10);
      // Timestamp da mensagem (envelope Gmail) é anexado pra formatar a nota
      // do contato pendente em studio-apoios.ts.
      assert.equal(result.promessas?.[0].receivedAtIso, new Date(1752652800000).toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mistura de apoio confirmado + promessa na mesma leva -> cada um vai pro array certo", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-mixed-"));
    try {
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "t1",
            messages: [
              makePlainMessage(
                "m1",
                "1752652800000",
                "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$25* !",
              ),
              makePlainMessage(
                "m2",
                "1752739200000",
                "Ivan <ivan.andrade81@gmail.com> recém prometeu um apoio de R$10",
              ),
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.notifications.length, 1);
      assert.equal(result.notifications[0].email, "alalmas@gmail.com");
      assert.equal(result.promessas?.length, 1);
      assert.equal(result.promessas?.[0].email, "ivan.andrade81@gmail.com");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ─── mensagens não-parseadas (#4171) ────────────────────────────────────

  it("mensagem que casa a query mas não bate nenhum template: contabilizada em 'unparsed', messageId em quarentena, e o cursor AINDA ASSIM avança", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-unparsed-"));
    try {
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "t1",
            messages: [
              // Casa a query (subject "novo apoio"/"nova promessa"), mas o
              // corpo não bate nenhum dos 2 templates — ex: apoia.se mudou o
              // template de novo, ou é ruído que escapou da query.
              makePlainMessage("m1", "1752652800000", "Novo template inesperado da apoia.se — sem match nenhum."),
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.notifications.length, 0);
      assert.deepEqual(result.promessas, undefined);
      assert.equal(result.unparsed, 1);

      // Quarentena recebeu o messageId pra reprocessamento manual (#4171).
      const quarantineLines = readFileSync(unparsedQuarantinePath(root), "utf-8").trim().split("\n");
      assert.equal(quarantineLines.length, 1);
      const entry = JSON.parse(quarantineLines[0]);
      assert.equal(entry.messageId, "m1");
      assert.equal(entry.threadId, "t1");
      assert.equal(entry.receivedAtIso, new Date(1752652800000).toISOString());
      assert.match(entry.bodySnippet, /Novo template inesperado/);

      // DECISÃO DO COORDENADOR (#4171): o cursor avança por cima da mensagem
      // não-parseada mesmo assim — travar aqui congelaria o drain inteiro
      // pra sempre contra uma mensagem cronicamente não-parseável.
      const cursor = loadGmailDrainCursor(root);
      assert.equal(cursor.last_drain_iso, new Date(1752652800000).toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nenhuma mensagem não-parseada -> campo 'unparsed' fica ausente (não 0) — mesma convenção de 'errors'/'promessas', e nenhuma quarentena é criada", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-no-unparsed-"));
    try {
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
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

      assert.equal("unparsed" in result, false);
      assert.equal(existsSync(unparsedQuarantinePath(root)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#4171 regressão: apoio confirmado + promessa válida + mensagem não-parseada na MESMA leva — cada um vai pro destino certo", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-mixed-unparsed-"));
    try {
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "t1",
            messages: [
              makePlainMessage(
                "m1",
                "1752652800000",
                "ALMIR <alalmas@gmail.com> acabou de apoiar sua campanha diar.ia.br com o valor de *R$25* !",
              ),
              makePlainMessage(
                "m2",
                "1752739200000",
                "Raul <raul.jperez@gmail.com> recém prometeu um apoio de R$ *10* para sua campanha diar.ia.br.",
              ),
              makePlainMessage("m3", "1752825600000", "Mensagem que não bate nenhum template conhecido."),
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await drainApoiaSeNotifications(root, { gmailFetch });

      assert.equal(result.notifications.length, 1);
      assert.equal(result.notifications[0].email, "alalmas@gmail.com");
      assert.equal(result.promessas?.length, 1);
      assert.equal(result.promessas?.[0].email, "raul.jperez@gmail.com");
      assert.equal(result.promessas?.[0].value, 10);
      assert.equal(result.unparsed, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nenhuma promessa na leva -> campo 'promessas' fica ausente (não [] vazio) — mesma convenção de 'errors'", async () => {
    const root = mkdtempSync(join(tmpdir(), "apoia-gmail-drain-nopromessa-"));
    try {
      const gmailFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(JSON.stringify({ threads: [makeThreadSummary("t1")] }), { status: 200 });
        }
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
      assert.equal("promessas" in result, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
