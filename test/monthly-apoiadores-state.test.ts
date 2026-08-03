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
  assert.deepEqual(decideMarkSentAction(PREPARED), { action: "mark" });
});

test("decideMarkSentAction: status sent -> noop (idempotente, não é erro rodar --mark-sent 2x)", () => {
  const decision = decideMarkSentAction(SENT);
  assert.equal(decision.action, "noop");
  if (decision.action === "noop") {
    assert.match(decision.reason, /já estava marcado como enviado/);
  }
});
