/**
 * test/monthly-apoiadores-state.test.ts (#4521)
 *
 * Idempotência/dedup do envio extra Beehiiv pra apoiadores Mantenedor/
 * Patrono (`scripts/lib/mensal/monthly-apoiadores-state.ts`):
 *   - round-trip do state file (read/write, tolerância a ausência/corrupção)
 *   - `decidePrepareAction`: bloqueia re-preparar um ciclo já `sent` sem
 *     `--force`; sempre permite quando `draft_prepared`/ausente ou com
 *     `--force`.
 *   - `decideMarkSentAction`: erro sem preparo prévio, noop se já `sent`,
 *     `mark` na transição válida `draft_prepared -> sent`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readApoiadoresState,
  writeApoiadoresState,
  apoiadoresStatePath,
  decidePrepareAction,
  decideMarkSentAction,
  buildPreparedState,
  decidePublishBrevoAction,
  buildApoiadoresBrevoPublishedState,
  type ApoiadoresState,
} from "../scripts/lib/mensal/monthly-apoiadores-state.ts";

function tmpMonthlyDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  mkdirSync(resolve(dir, "_internal"), { recursive: true });
  return dir;
}

const PREPARED: ApoiadoresState = {
  cycle: "2607-08",
  status: "draft_prepared",
  preparedAt: "2026-08-03T10:00:00.000Z",
  sentAt: null,
  htmlPath: "/tmp/x/_internal/beehiiv-preview.html",
  subject: "diar.ia.br | Julho 2026",
  segments: ["Apoio — Mantenedor", "Apoio — Patrono"],
  brevoCampaignId: null,
};

const SENT: ApoiadoresState = {
  ...PREPARED,
  status: "sent",
  sentAt: "2026-08-04T09:00:00.000Z",
};

// ---------------------------------------------------------------------------
// readApoiadoresState / writeApoiadoresState
// ---------------------------------------------------------------------------

test("readApoiadoresState: diretório sem state file -> null (nunca preparado)", () => {
  const dir = tmpMonthlyDir("apoiadores-state-empty-");
  assert.equal(readApoiadoresState(dir), null);
});

test("readApoiadoresState: JSON corrompido -> null (tolerante, nunca lança)", () => {
  const dir = tmpMonthlyDir("apoiadores-state-corrupt-");
  writeFileSync(apoiadoresStatePath(dir), "{ não é json", "utf8");
  assert.equal(readApoiadoresState(dir), null);
});

test("readApoiadoresState: shape inesperado (status inválido) -> null", () => {
  const dir = tmpMonthlyDir("apoiadores-state-badshape-");
  writeFileSync(apoiadoresStatePath(dir), JSON.stringify({ cycle: "2607-08", status: "queued", preparedAt: "x" }), "utf8");
  assert.equal(readApoiadoresState(dir), null);
});

test("writeApoiadoresState + readApoiadoresState: round-trip preserva os campos (draft_prepared)", () => {
  const dir = tmpMonthlyDir("apoiadores-state-roundtrip-");
  writeApoiadoresState(dir, PREPARED);
  assert.ok(existsSync(apoiadoresStatePath(dir)));
  assert.deepEqual(readApoiadoresState(dir), PREPARED);
});

test("writeApoiadoresState + readApoiadoresState: round-trip preserva os campos (sent)", () => {
  const dir = tmpMonthlyDir("apoiadores-state-roundtrip-sent-");
  writeApoiadoresState(dir, SENT);
  assert.deepEqual(readApoiadoresState(dir), SENT);
});

// ---------------------------------------------------------------------------
// decidePrepareAction — dedup real (#4521 questão 3)
// ---------------------------------------------------------------------------

test("decidePrepareAction: sem state prévio -> sempre permite preparar", () => {
  assert.deepEqual(decidePrepareAction(null, false), { action: "prepare" });
});

test("decidePrepareAction: status draft_prepared -> permite (idempotente, só regenera HTML)", () => {
  assert.deepEqual(decidePrepareAction(PREPARED, false), { action: "prepare" });
});

test("decidePrepareAction: status sent, SEM --force -> bloqueia (dedup real)", () => {
  const decision = decidePrepareAction(SENT, false);
  assert.equal(decision.action, "blocked");
  if (decision.action === "blocked") {
    assert.match(decision.reason, /já foi marcado como ENVIADO/);
    assert.match(decision.reason, /--force/);
  }
});

test("decidePrepareAction: status sent, COM --force -> permite (reenviar correção)", () => {
  assert.deepEqual(decidePrepareAction(SENT, true), { action: "prepare" });
});

// ---------------------------------------------------------------------------
// decideMarkSentAction
// ---------------------------------------------------------------------------

test("decideMarkSentAction: sem preparo prévio -> erro (nada a marcar)", () => {
  const decision = decideMarkSentAction(null);
  assert.equal(decision.action, "error");
});

test("decideMarkSentAction: status draft_prepared -> mark (transição válida)", () => {
  assert.deepEqual(decideMarkSentAction(PREPARED), { action: "mark", state: PREPARED });
});

test("decideMarkSentAction: status sent -> noop (idempotente, não é erro rodar --mark-sent 2x)", () => {
  const decision = decideMarkSentAction(SENT);
  assert.equal(decision.action, "noop");
  if (decision.action === "noop") {
    assert.match(decision.reason, /já estava marcado como enviado/);
  }
});

// ---------------------------------------------------------------------------
// buildPreparedState (#4521 self-review — regressão do bug de sentAt herdado)
// ---------------------------------------------------------------------------

test("buildPreparedState: state novo (1ª preparação) -> sentAt null", () => {
  const s = buildPreparedState("2607-08", "2026-08-03T10:00:00.000Z", "/x/beehiiv-preview.html", "Assunto", [
    "Apoio — Mantenedor",
    "Apoio — Patrono",
  ]);
  assert.equal(s.status, "draft_prepared");
  assert.equal(s.sentAt, null);
});

test("buildPreparedState: NUNCA herda sentAt de um estado anterior sent (regressão do bug de --force)", () => {
  // Antes do fix, `send-monthly-apoiadores.ts` fazia `sentAt: state?.sentAt ?? null`
  // -- um --force sobre um ciclo `sent` produzia um `draft_prepared` com uma
  // data de envio antiga carimbada, violando o contrato "sentAt só não-null
  // quando status === 'sent'". `buildPreparedState` não recebe o state anterior
  // INTEIRO no seu contrato (só um `previousBrevoCampaignId` opcional,
  // #4572/#4593) -- não há como reintroduzir o bug de sentAt por acidente aqui.
  const s = buildPreparedState("2607-08", "2026-08-05T10:00:00.000Z", "/x/beehiiv-preview.html", "Assunto", []);
  assert.equal(s.sentAt, null);
});

test("buildPreparedState: preserva htmlPath/subject/segments/preparedAt exatamente como passados", () => {
  const segments = ["Apoio — Mantenedor", "Apoio — Patrono"];
  const s = buildPreparedState("2607-08", "2026-08-03T10:00:00.000Z", "/x/y.html", "Assunto X", segments);
  assert.deepEqual(s, {
    cycle: "2607-08",
    status: "draft_prepared",
    preparedAt: "2026-08-03T10:00:00.000Z",
    sentAt: null,
    htmlPath: "/x/y.html",
    subject: "Assunto X",
    segments: ["Apoio — Mantenedor", "Apoio — Patrono"],
    brevoCampaignId: null,
  });
});

test("buildPreparedState: sem previousBrevoCampaignId -> brevoCampaignId null (default)", () => {
  const s = buildPreparedState("2607-08", "2026-08-03T10:00:00.000Z", "/x/y.html", "Assunto X", []);
  assert.equal(s.brevoCampaignId, null);
});

test("buildPreparedState: com previousBrevoCampaignId -> preserva (Passo 1 rodado depois do Passo 2 não apaga o registro)", () => {
  const s = buildPreparedState("2607-08", "2026-08-03T10:00:00.000Z", "/x/y.html", "Assunto X", [], 777);
  assert.equal(s.brevoCampaignId, 777);
});

// ---------------------------------------------------------------------------
// decidePublishBrevoAction / buildApoiadoresBrevoPublishedState (#4572/#4593
// -- guard de idempotência Passo 1 <-> Passo 2, fecha o "Gap conhecido" do
// SKILL.md: publish-monthly-apoiadores-brevo.ts criava uma campanha Brevo
// real sem consultar/gravar este state file, então rodar o Passo 2 2x pro
// mesmo ciclo criava DOIS rascunhos duplicados na Brevo).
// ---------------------------------------------------------------------------

test("decidePublishBrevoAction: sem state prévio -> sempre permite criar", () => {
  assert.deepEqual(decidePublishBrevoAction(null, false), { action: "create" });
});

test("decidePublishBrevoAction: state prévio sem brevoCampaignId (ex: só Passo 1 rodou) -> permite criar", () => {
  assert.deepEqual(decidePublishBrevoAction(PREPARED, false), { action: "create" });
});

test("decidePublishBrevoAction: brevoCampaignId já setado, SEM --force -> bloqueia (evita rascunho duplicado)", () => {
  const state: ApoiadoresState = { ...PREPARED, brevoCampaignId: 555 };
  const decision = decidePublishBrevoAction(state, false);
  assert.equal(decision.action, "blocked");
  if (decision.action === "blocked") {
    assert.match(decision.reason, /555/);
    assert.match(decision.reason, /--force/);
  }
});

test("decidePublishBrevoAction: brevoCampaignId já setado, COM --force -> permite criar outro", () => {
  const state: ApoiadoresState = { ...PREPARED, brevoCampaignId: 555 };
  assert.deepEqual(decidePublishBrevoAction(state, true), { action: "create" });
});

test("decidePublishBrevoAction: status sent, SEM --force -> bloqueia (mesmo sem brevoCampaignId)", () => {
  const state: ApoiadoresState = { ...PREPARED, status: "sent", sentAt: "2026-08-04T09:00:00.000Z" };
  const decision = decidePublishBrevoAction(state, false);
  assert.equal(decision.action, "blocked");
  if (decision.action === "blocked") {
    assert.match(decision.reason, /já foi marcado como ENVIADO/);
  }
});

test("decidePublishBrevoAction: status sent, COM --force -> permite criar", () => {
  const state: ApoiadoresState = { ...PREPARED, status: "sent", sentAt: "2026-08-04T09:00:00.000Z" };
  assert.deepEqual(decidePublishBrevoAction(state, true), { action: "create" });
});

test("buildApoiadoresBrevoPublishedState: state novo (sem previous) -> status draft_prepared, sentAt null, brevoCampaignId gravado", () => {
  const s = buildApoiadoresBrevoPublishedState(null, "2607-08", "2026-08-04T10:00:00.000Z", "/x/apoiadores-brevo-preview.html", "Assunto", 555);
  assert.deepEqual(s, {
    cycle: "2607-08",
    status: "draft_prepared",
    preparedAt: "2026-08-04T10:00:00.000Z",
    sentAt: null,
    htmlPath: "/x/apoiadores-brevo-preview.html",
    subject: "Assunto",
    segments: [],
    brevoCampaignId: 555,
  });
});

test("buildApoiadoresBrevoPublishedState: NUNCA herda sentAt de um previous 'sent' (mesma disciplina de buildPreparedState)", () => {
  const previous: ApoiadoresState = { ...PREPARED, status: "sent", sentAt: "2026-08-04T09:00:00.000Z" };
  const s = buildApoiadoresBrevoPublishedState(previous, "2607-08", "2026-08-05T10:00:00.000Z", "/x/y.html", "Assunto novo", 777);
  assert.equal(s.status, "draft_prepared");
  assert.equal(s.sentAt, null);
  assert.equal(s.brevoCampaignId, 777);
});

test("buildApoiadoresBrevoPublishedState: preserva segments do previous quando presente", () => {
  const s = buildApoiadoresBrevoPublishedState(PREPARED, "2607-08", "2026-08-04T10:00:00.000Z", "/x/y.html", "Assunto", 555);
  assert.deepEqual(s.segments, PREPARED.segments);
});
