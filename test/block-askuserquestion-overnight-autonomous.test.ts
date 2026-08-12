import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  shouldBlockAskUserQuestion,
  readActiveMarker,
  activeSessionPath,
} from "../.claude/hooks/block-askuserquestion-overnight-autonomous.mjs";

// #4450: guard MECÂNICO contra o incidente da rodada 260801/02 — o
// coordenador disparou um AskUserQuestion malformado/placeholder no meio da
// Fase 1 (autônoma) do /diaria-overnight, violando a Regra 1 (HARD RULE,
// "zero perguntas pós-briefing") de .claude/skills/diaria-overnight/SKILL.md.
// Diferente do #3038 (decisão de raciocínio ruim, resolvida via reforço de
// prompt), essa chamada não passou por raciocínio identificável nenhum — o
// fix não pode ser só texto, precisa ser um PreToolUse hook que nega a
// chamada independente do que o coordenador "lembrou" de checar.
//
// shouldBlockAskUserQuestion é a função PURA (sem I/O) que decide, dado o
// ESTADO já lido do marker — espelha o padrão de shouldWakeCheck em
// scripts/lib/overnight-fallback-wake.ts e de isOvernightRoundActive em
// .claude/hooks/pr-create-review.mjs (mesmo guard de staleness/clock-skew).
describe("shouldBlockAskUserQuestion (#4450)", () => {
  const NOW = Date.parse("2026-08-02T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("marker ausente (null) → false (permite — fail-open)", () => {
    assert.equal(shouldBlockAskUserQuestion(null, NOW), false);
  });

  it("marker undefined → false (permite — fail-open)", () => {
    assert.equal(shouldBlockAskUserQuestion(undefined, NOW), false);
  });

  it("phase: 'autonomous', started_at recente → true (bloqueia)", () => {
    const marker = { started_at: new Date(NOW - ONE_HOUR_MS).toISOString(), phase: "autonomous" };
    assert.equal(shouldBlockAskUserQuestion(marker, NOW), true);
  });

  it("phase: 'briefing' → false (permite — Fase 0, perguntar é o esperado)", () => {
    const marker = { started_at: new Date(NOW - ONE_HOUR_MS).toISOString(), phase: "briefing" };
    assert.equal(shouldBlockAskUserQuestion(marker, NOW), false);
  });

  it("marker sem campo phase (legado, pré-#4450) → false (permite — fail-open, nunca começa a bloquear rodada em andamento sem aviso)", () => {
    const marker = { started_at: new Date(NOW - ONE_HOUR_MS).toISOString() };
    assert.equal(shouldBlockAskUserQuestion(marker, NOW), false);
  });

  it("phase com valor desconhecido/corrompido → false (permite — só 'autonomous' bloqueia)", () => {
    const marker = { started_at: new Date(NOW - ONE_HOUR_MS).toISOString(), phase: "yolo" };
    assert.equal(shouldBlockAskUserQuestion(marker, NOW), false);
  });

  it("phase: 'autonomous' mas marker mais velho que MAX_SESSION_AGE_MS (24h) → false (rodada abandonada não bloqueia pra sempre)", () => {
    const marker = { started_at: new Date(NOW - 25 * ONE_HOUR_MS).toISOString(), phase: "autonomous" };
    assert.equal(shouldBlockAskUserQuestion(marker, NOW), false);
  });

  it("phase: 'autonomous' com started_at no FUTURO → false (clock skew/corrupção nunca vira bloqueio)", () => {
    const marker = { started_at: new Date(NOW + 10 * ONE_HOUR_MS).toISOString(), phase: "autonomous" };
    assert.equal(shouldBlockAskUserQuestion(marker, NOW), false);
  });

  it("phase: 'autonomous' no limite (23h59) ainda bloqueia; 24h01 já não bloqueia", () => {
    const fresh = { started_at: new Date(NOW - (24 * ONE_HOUR_MS - 60_000)).toISOString(), phase: "autonomous" };
    assert.equal(shouldBlockAskUserQuestion(fresh, NOW), true);

    const stale = { started_at: new Date(NOW - (24 * ONE_HOUR_MS + 60_000)).toISOString(), phase: "autonomous" };
    assert.equal(shouldBlockAskUserQuestion(stale, NOW), false);
  });

  it("phase: 'autonomous' com started_at ausente/malformado → false (nunca finge marker válido)", () => {
    assert.equal(shouldBlockAskUserQuestion({ phase: "autonomous" }, NOW), false);
    assert.equal(shouldBlockAskUserQuestion({ phase: "autonomous", started_at: "not-a-date" }, NOW), false);
  });
});

// #5156: marker session-aware. O caso explicitamente pedido pela issue —
// "overnight autônomo ativo + chamada vinda de OUTRA sessão → permitido" —
// e a garantia de retrocompat: marker sem session_id (formato antigo,
// inclusive uma rodada já em progresso no momento em que este campo foi
// introduzido) preserva o comportamento pré-#5156 (bloqueia por máquina,
// independente de quem chama).
describe("shouldBlockAskUserQuestion — session-aware (#5156)", () => {
  const NOW = Date.parse("2026-08-12T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const fresh = (extra) => ({ started_at: new Date(NOW - ONE_HOUR_MS).toISOString(), phase: "autonomous", ...extra });

  it("marker SEM session_id (formato antigo) → bloqueia independente do callerSessionId (retrocompat)", () => {
    const marker = fresh({});
    assert.equal(shouldBlockAskUserQuestion(marker, NOW, "sessao-develop-xyz"), true);
    assert.equal(shouldBlockAskUserQuestion(marker, NOW, undefined), true);
  });

  it("marker COM session_id + callerSessionId da MESMA sessão overnight → bloqueia (é o próprio overnight se perguntando)", () => {
    const marker = fresh({ session_id: "sessao-overnight-abc" });
    assert.equal(shouldBlockAskUserQuestion(marker, NOW, "sessao-overnight-abc"), true);
  });

  it("marker COM session_id + callerSessionId de OUTRA sessão (ex: /diaria-develop em paralelo) → permite (pedido explícito da issue #5156)", () => {
    const marker = fresh({ session_id: "sessao-overnight-abc" });
    assert.equal(shouldBlockAskUserQuestion(marker, NOW, "sessao-develop-xyz"), false);
  });

  it("marker COM session_id + callerSessionId ausente (payload sem o campo — harness antigo) → permite, nunca finge identidade", () => {
    const marker = fresh({ session_id: "sessao-overnight-abc" });
    assert.equal(shouldBlockAskUserQuestion(marker, NOW, undefined), false);
  });

  it(
    "marker COM session_id + callerSessionId ausente → o fail-open é LOGADO em stderr, nunca silencioso (#5161 item 5)",
    () => {
      const marker = fresh({ session_id: "sessao-overnight-abc" });
      let stderrOutput = "";
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...args) => {
        stderrOutput += String(chunk);
        return true;
      };
      try {
        shouldBlockAskUserQuestion(marker, NOW, undefined);
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.match(stderrOutput, /aviso/i);
      assert.match(stderrOutput, /sessao-overnight-abc/);
    },
  );

  it("marker COM session_id ainda respeita staleness/futuro — session match não sobrepõe os outros guards", () => {
    const staleMarker = {
      started_at: new Date(NOW - 25 * ONE_HOUR_MS).toISOString(),
      phase: "autonomous",
      session_id: "sessao-overnight-abc",
    };
    assert.equal(shouldBlockAskUserQuestion(staleMarker, NOW, "sessao-overnight-abc"), false);
  });
});

// readActiveMarker é o read-side de disco (I/O real via repoRoot/machineTag
// injetados) — mesma separação write/read-side documentada no docblock de
// scripts/overnight-session-marker.ts. Isolado do disco real via tmpdir.
describe("readActiveMarker (#4450)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(
      tmpdir(),
      `block-askuserquestion-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    return root;
  }

  function writeMarker(root, tag, marker) {
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `.active-session-${tag}.json`), JSON.stringify(marker), "utf8");
  }

  it("sem marker no disco → null", () => {
    assert.equal(readActiveMarker(freshRoot(), "host-a"), null);
  });

  it("marker presente → objeto parseado", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: "2026-08-01T02:00:00.000Z", phase: "autonomous" });
    assert.deepEqual(readActiveMarker(root, "host-a"), {
      started_at: "2026-08-01T02:00:00.000Z",
      phase: "autonomous",
    });
  });

  it("marker de OUTRA máquina (tag diferente) → null, mesmo marker existindo pra outro host", () => {
    const root = freshRoot();
    writeMarker(root, "host-b", { started_at: "2026-08-01T02:00:00.000Z", phase: "autonomous" });
    assert.equal(readActiveMarker(root, "host-a"), null);
  });

  it("JSON malformado no marker → null (fail-open, nunca lança)", () => {
    const root = freshRoot();
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".active-session-host-a.json"), "{not valid json", "utf8");
    assert.equal(readActiveMarker(root, "host-a"), null);
  });

  it("activeSessionPath monta o mesmo path do write-side (scripts/overnight-session-marker.ts)", () => {
    assert.equal(
      activeSessionPath("/repo", "my-host"),
      join("/repo", "data", "overnight", ".active-session-my-host.json"),
    );
  });
});
