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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoundPayload, listRoundSummaries } from "../scripts/studio-ui/studio-round.ts";

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

  // #3889: `updatedAt` (mtime real do plan.json) — corrige o falso-frescor do
  // rótulo "atualizado" em rodada.js, que antes usava `new Date()` do CLIENTE
  // (avançava a cada fetch, mesmo com plan.json parado). O servidor agora
  // reporta quando o ARQUIVO de fato mudou pela última vez.
  describe("updatedAt (#3889)", () => {
    it("reflete o mtime real do plan.json no disco, não o momento da chamada", () => {
      const r = makeRoot();
      const dir = join(r, "data", "overnight", "260722");
      mkdirSync(dir, { recursive: true });
      const planPath = join(dir, "plan.json");
      writeFileSync(planPath, JSON.stringify({ issues: [] }));

      // Fixa o mtime num valor conhecido, no passado — bem diferente de "agora".
      const fixedMtime = new Date("2026-07-22T09:00:00.000Z");
      utimesSync(planPath, fixedMtime, fixedMtime);

      const before = Date.now();
      const payload = buildRoundPayload(r, "overnight");
      assert.equal(payload.updatedAt, fixedMtime.toISOString());
      // Não deve ser "agora" (o bug original: hora do fetch, não do arquivo).
      assert.notEqual(payload.updatedAt, new Date(before).toISOString());
    });

    it("duas chamadas seguidas sem o arquivo mudar retornam o MESMO updatedAt (rótulo não avança sozinho)", () => {
      const r = makeRoot();
      const dir = join(r, "data", "overnight", "260722");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plan.json"), JSON.stringify({ issues: [] }));

      const first = buildRoundPayload(r, "overnight");
      const second = buildRoundPayload(r, "overnight");
      assert.equal(first.updatedAt, second.updatedAt);
    });

    it("nenhuma sessão encontrada -> updatedAt null", () => {
      const r = makeRoot();
      const payload = buildRoundPayload(r, "overnight");
      assert.equal(payload.updatedAt, null);
    });

    it("updatedAt corresponde ao statSync().mtimeMs do plan.json (sanity check contra o filesystem real)", () => {
      const r = makeRoot();
      const dir = join(r, "data", "overnight", "260722");
      mkdirSync(dir, { recursive: true });
      const planPath = join(dir, "plan.json");
      writeFileSync(planPath, JSON.stringify({ issues: [] }));

      const payload = buildRoundPayload(r, "overnight");
      const expected = new Date(statSync(planPath).mtimeMs).toISOString();
      assert.equal(payload.updatedAt, expected);
    });
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

  // #3841 item 2/3: `buildRoundPayload` ganhou um 3º parâmetro `sessionId`
  // pra buscar o DETALHE de uma entrada específica da sequência cronológica
  // (painel `/rodada`), não só a mais recente do kind.
  describe("buildRoundPayload — sessionId explícito (#3841)", () => {
    it("com sessionId, busca o plan.json DAQUELA sessão — não necessariamente a mais recente", () => {
      const r = makeRoot();
      const dirNewer = join(r, "data", "overnight", "260722");
      mkdirSync(dirNewer, { recursive: true });
      const planNewer = join(dirNewer, "plan.json");
      writeFileSync(planNewer, JSON.stringify({ started_at: "2026-07-22T10:00:00Z", issues: [{ number: 100, status: "elegivel" }] }));

      const dirOlder = join(r, "data", "overnight", "260721b");
      mkdirSync(dirOlder, { recursive: true });
      const planOlder = join(dirOlder, "plan.json");
      writeFileSync(planOlder, JSON.stringify({ started_at: "2026-07-21T20:00:00Z", issues: [{ number: 99, status: "mergeada" }] }));

      // mtime explícito — `findLatestPlanPath` escolhe por mtime real do
      // arquivo, não pelo `started_at` do conteúdo nem pela ordem de escrita.
      const newerMtime = new Date("2026-07-22T10:05:00Z");
      const olderMtime = new Date("2026-07-21T20:05:00Z");
      utimesSync(planNewer, newerMtime, newerMtime);
      utimesSync(planOlder, olderMtime, olderMtime);

      // Sem sessionId: pega a mais recente por mtime (260722).
      const latest = buildRoundPayload(r, "overnight");
      assert.equal(latest.sessionId, "260722");

      // Com sessionId explícito: pega a sessão pedida, mesmo sendo a mais antiga.
      const older = buildRoundPayload(r, "overnight", "260721b");
      assert.equal(older.sessionId, "260721b");
      assert.equal(older.found, true);
      assert.equal(older.queue.entram[0]?.number, 99);
    });

    it("sessionId inexistente -> found:false, sem lançar", () => {
      const r = makeRoot();
      mkdirSync(join(r, "data", "overnight", "260721"), { recursive: true });
      writeFileSync(join(r, "data", "overnight", "260721", "plan.json"), JSON.stringify({ issues: [] }));

      const payload = buildRoundPayload(r, "overnight", "999999");
      assert.equal(payload.found, false);
    });

    it("sessionId malformado (path traversal) -> found:false com error explícito, nunca escapa data/{kind}/", () => {
      const r = makeRoot();
      const payload = buildRoundPayload(r, "overnight", "../../etc");
      assert.equal(payload.found, false);
      assert.match(payload.error ?? "", /sessionId inválido/);
    });
  });

  // #3841 item 1/2: `startedAtSource` distingue `started_at` real (ISO
  // gravado pela skill) de fallback (mtime — sessão legada sem ISO real).
  describe("startedAt/startedAtSource (#3841)", () => {
    it("plan.json com started_at ISO -> startedAtSource 'plan', valor preservado verbatim", () => {
      const r = makeRoot();
      const dir = join(r, "data", "overnight", "260722");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plan.json"), JSON.stringify({ started_at: "2026-07-22T16:37:03Z", issues: [] }));

      const payload = buildRoundPayload(r, "overnight");
      assert.equal(payload.startedAt, "2026-07-22T16:37:03Z");
      assert.equal(payload.startedAtSource, "plan");
    });

    it("plan.json legado (started_at = string AAMMDD, não-ISO) -> fallback pro mtime, startedAtSource 'mtime'", () => {
      const r = makeRoot();
      const dir = join(r, "data", "overnight", "260721");
      mkdirSync(dir, { recursive: true });
      const planPath = join(dir, "plan.json");
      writeFileSync(planPath, JSON.stringify({ started_at: "260721", issues: [] }));
      const fixedMtime = new Date("2026-07-21T18:00:00.000Z");
      utimesSync(planPath, fixedMtime, fixedMtime);

      const payload = buildRoundPayload(r, "overnight");
      assert.equal(payload.startedAt, fixedMtime.toISOString());
      assert.equal(payload.startedAtSource, "mtime");
    });

    it("plan.json sem started_at -> fallback pro mtime (não null, não '01/01')", () => {
      const r = makeRoot();
      const dir = join(r, "data", "overnight", "260721");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plan.json"), JSON.stringify({ issues: [] }));

      const payload = buildRoundPayload(r, "overnight");
      assert.ok(payload.startedAt, "startedAt nunca deve ser null quando found:true");
      assert.equal(payload.startedAtSource, "mtime");
    });
  });
});

// #3841 item 2/3 — `listRoundSummaries`: sequência cronológica de TODAS as
// rodadas (overnight + develop), mais recente primeiro.
describe("listRoundSummaries (#3841)", () => {
  it("lista rodadas de AMBOS os kinds, ordenadas por started_at desc — sufixo b nunca invisível", () => {
    const r = makeRoot();
    const dirA = join(r, "data", "overnight", "260721");
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, "plan.json"), JSON.stringify({
      started_at: "2026-07-21T14:34:00Z",
      issues: [{ number: 1, status: "mergeada" }, { number: 2, status: "mergeada" }],
    }));

    const dirB = join(r, "data", "overnight", "260721b");
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, "plan.json"), JSON.stringify({
      started_at: "2026-07-21T19:42:00Z", // MAIS recente que dirA, mesmo dia
      issues: [{ number: 3, status: "elegivel" }],
    }));

    const dirDevelop = join(r, "data", "develop", "260721");
    mkdirSync(dirDevelop, { recursive: true });
    writeFileSync(join(dirDevelop, "plan.json"), JSON.stringify({
      started_at: "2026-07-21T12:58:00Z", // mais antiga que as duas acima
      issues: [{ number: 4, status: "pendente" }],
    }));

    const rounds = listRoundSummaries(r);
    assert.equal(rounds.length, 3, "as 3 sessões devem aparecer — nenhuma invisível por sufixo/kind");

    // Mais recente primeiro: 260721b (19:42) > 260721 overnight (14:34) > develop 260721 (12:58).
    assert.equal(rounds[0].sessionId, "260721b");
    assert.equal(rounds[0].kind, "overnight");
    assert.equal(rounds[1].sessionId, "260721");
    assert.equal(rounds[1].kind, "overnight");
    assert.equal(rounds[2].sessionId, "260721");
    assert.equal(rounds[2].kind, "develop");

    assert.equal(rounds[1].totalIssues, 2);
    assert.equal(rounds[1].counts["mergeada"], 2);
  });

  it("plan.json legado (started_at não-ISO) cai pro fallback de mtime — continua aparecendo na lista", () => {
    const r = makeRoot();
    const dir = join(r, "data", "overnight", "260710");
    mkdirSync(dir, { recursive: true });
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify({ started_at: "260710", issues: [{ number: 1, status: "mergeada" }] }));
    const fixedMtime = new Date("2026-07-10T09:00:00.000Z");
    utimesSync(planPath, fixedMtime, fixedMtime);

    const rounds = listRoundSummaries(r);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].startedAtSource, "mtime");
    assert.equal(rounds[0].startedAt, fixedMtime.toISOString());
  });

  it("plan.json corrompido é omitido da lista (fail-soft), nunca lança", () => {
    const r = makeRoot();
    const dir = join(r, "data", "overnight", "260710");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), "{ not json");

    assert.doesNotThrow(() => listRoundSummaries(r));
    assert.deepEqual(listRoundSummaries(r), []);
  });

  it("nenhuma sessão em nenhum kind -> array vazio", () => {
    const r = makeRoot();
    assert.deepEqual(listRoundSummaries(r), []);
  });
});
