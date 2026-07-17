/**
 * test/studio-round.test.ts (#3561, fatia 7 do epic "Studio UI" #3554)
 *
 * Cobertura de `scripts/studio-ui/studio-round.ts::buildRoundPayload` — a
 * orquestração I/O que lê o `plan.json` MAIS RECENTE de um kind
 * (overnight/develop) e monta fila classificada + timeline. Fixtures em
 * tmpdir, mesmo padrão de `test/studio-state.test.ts` (findLatestPlanPath).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoundPayload } from "../scripts/studio-ui/studio-round.ts";

let root: string | null = null;

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "studio-round-"));
  return root;
}

describe("buildRoundPayload (#3561)", () => {
  it("nenhuma sessão -> found:false, arrays vazios, sem erro", () => {
    const r = makeRoot();
    const payload = buildRoundPayload(r, "overnight");
    assert.equal(payload.found, false);
    assert.equal(payload.planPath, null);
    assert.equal(payload.error, null);
    assert.deepEqual(payload.queue, { entram: [], pendente: [], fora: [] });
    assert.deepEqual(payload.timeline, []);
  });

  it("lê o plan.json mais recente, monta fila classificada + timeline (reusa buildTimelineRows)", () => {
    const r = makeRoot();
    const dir = join(r, "data", "overnight", "260716");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({
        started_at: "2026-07-16T10:00:00Z",
        loop_estendido: false,
        issues: [
          {
            number: 3212,
            priority: "P2",
            status: "mergeada",
            in_round: true,
            batch: "boxes-divulgacao",
            pr: 3505,
            timeline: { dispatch: "2026-07-16T10:05:00Z", merged: "2026-07-16T11:05:00Z" },
          },
          {
            number: 3500,
            priority: "P2",
            status: "pulada",
            motivo: "bloqueio-externo",
            in_round: false,
            timeline: { pulada: "2026-07-16T12:00:00Z" },
          },
        ],
      }),
    );

    const payload = buildRoundPayload(r, "overnight");
    assert.equal(payload.found, true);
    assert.equal(payload.sessionId, "260716");
    assert.equal(payload.startedAt, "2026-07-16T10:00:00Z");
    assert.equal(payload.loopEstendido, false);
    assert.equal(payload.planPath, "data/overnight/260716/plan.json");
    assert.equal(payload.error, null);

    assert.equal(payload.queue.entram.length, 1);
    assert.equal(payload.queue.entram[0].number, 3212);
    assert.equal(payload.queue.fora.length, 1);
    assert.equal(payload.queue.fora[0].reason, "bloqueio-externo");

    // Timeline reusa buildTimelineRows de render-overnight-timeline.ts —
    // 1 row por unidade solo (batch presente conta como lote de 1).
    assert.equal(payload.timeline.length, 2);
    const merged = payload.timeline.find((t) => t.unidade.includes("3212"));
    assert.ok(merged);
    assert.equal(merged?.duracao, "1h00m");
  });

  it("develop: campos block_category/what_unblocks/status 'pendente' fluem pro bucket 'pendente'", () => {
    const r = makeRoot();
    const dir = join(r, "data", "develop", "260716");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({
        started_at: "2026-07-16T11:00:00Z",
        issues: [
          {
            number: 2483,
            priority: "P3",
            block_category: "A",
            what_unblocks: "editor gerar token Instagram no painel Meta",
            unblock_status: "pendente",
            status: "pendente",
          },
        ],
      }),
    );

    const payload = buildRoundPayload(r, "develop");
    assert.equal(payload.found, true);
    // develop plan.json não grava loop_estendido — campo overnight-only.
    assert.equal(payload.loopEstendido, null);
    assert.equal(payload.queue.pendente.length, 1);
    assert.equal(payload.queue.pendente[0].reason, "cat. A: editor gerar token Instagram no painel Meta");
  });

  it("plan.json corrompido -> found:false, error preenchido, nunca lança", () => {
    const r = makeRoot();
    const dir = join(r, "data", "overnight", "260716");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), "{ not json");

    const payload = buildRoundPayload(r, "overnight");
    assert.equal(payload.found, false);
    assert.match(payload.error ?? "", /plan\.json inválido/);
  });

  it("overnight e develop são lidos independentemente (kinds separados)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "data", "overnight", "260716"), { recursive: true });
    writeFileSync(join(r, "data", "overnight", "260716", "plan.json"), JSON.stringify({ issues: [] }));

    const overnightPayload = buildRoundPayload(r, "overnight");
    const developPayload = buildRoundPayload(r, "develop");
    assert.equal(overnightPayload.found, true);
    assert.equal(developPayload.found, false);
  });

  it("resposta nunca inclui valor de secret (invariante do plan.json, #3561/#573)", () => {
    const r = makeRoot();
    const dir = join(r, "data", "develop", "260716");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({
        issues: [
          {
            number: 1,
            status: "pendente",
            block_category: "A",
            what_unblocks: "editor cola token",
            editor_input_received: true, // bool, nunca o valor — mesmo invariante do SKILL.md
          },
        ],
      }),
    );
    const payload = buildRoundPayload(r, "develop");
    const raw = JSON.stringify(payload);
    assert.ok(!/ghp_|gho_|github_pat_/.test(raw));
  });
});
