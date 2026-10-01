import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import {
  shouldBlockAskUserQuestion,
  readActiveMarker,
  readActiveMarkers,
  activeSessionPath,
  buildBlockReason,
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

// #6232: a mensagem de bloqueio distingue "você É a rodada" de "marker
// anônimo escopado por máquina" — antes deste PR os dois casos produziam o
// mesmo texto genérico ("há uma rodada ativa nesta máquina"), o que fez o
// diagnóstico do incidente de origem levar horas.
describe("buildBlockReason (#6232)", () => {
  it("marker anônimo (sem session_id) → menciona escopo por MÁQUINA e o #6232", () => {
    const marker = { started_at: "2026-08-26T10:00:00.000Z", phase: "autonomous" };
    const reason = buildBlockReason(marker, "sessao-interativa-xyz");
    assert.match(reason, /NÃO TEM session_id/);
    assert.match(reason, /POR MÁQUINA/);
    assert.match(reason, /#6232/);
  });

  it("marker com session_id igual ao chamador → diz 'você É a rodada'", () => {
    const marker = { started_at: "2026-08-26T10:00:00.000Z", phase: "autonomous", session_id: "sessao-overnight-abc" };
    const reason = buildBlockReason(marker, "sessao-overnight-abc");
    assert.match(reason, /você É a rodada/);
    assert.match(reason, /sessao-overnight-abc/);
  });

  it("sempre inclui a regra/ação de base (#4450), independente do cenário", () => {
    const anonReason = buildBlockReason({ started_at: "x", phase: "autonomous" }, "a");
    const selfReason = buildBlockReason(
      { started_at: "x", phase: "autonomous", session_id: "a" },
      "a",
    );
    for (const reason of [anonReason, selfReason]) {
      assert.match(reason, /Regra 1/);
      assert.match(reason, /marque status "pulada"/);
    }
  });

  it("nunca lança, mesmo com marker null/undefined (fail-open já garante que isto não é chamado nesse caso, mas a função em si é defensiva)", () => {
    assert.doesNotThrow(() => buildBlockReason(null, "x"));
    assert.doesNotThrow(() => buildBlockReason(undefined, undefined));
  });
});

// #9347: marker POR SESSÃO — 2 rodadas overnight simultâneas na mesma
// máquina gravam `.active-session-{tag}.{sessionId}.json` distintos. O hook
// precisa ler TODOS (legado + por-sessão); antes, a 2ª rodada sobrescrevia/
// apagava o marker único e este guard desarmava em silêncio na 1ª.
describe("readActiveMarkers + entrypoint multi-marker (#9347)", () => {
  const roots: string[] = [];
  const HOOK = join(process.cwd(), ".claude", "hooks", "block-askuserquestion-overnight-autonomous.mjs");

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = mkdtempSync(join(tmpdir(), "block-askuserquestion-9347-"));
    roots.push(root);
    return root;
  }

  function writeNamed(root: string, name: string, marker: Record<string, unknown>) {
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(marker), "utf8");
  }

  const fresh = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

  it("lê legado + por-sessão da máquina; ignora outra máquina com prefixo parecido e arquivos alheios", () => {
    const root = freshRoot();
    writeNamed(root, ".active-session-host-a.json", { phase: "briefing", session_id: "legado" });
    writeNamed(root, ".active-session-host-a.sess-A.json", { phase: "autonomous", session_id: "sess-A" });
    writeNamed(root, ".active-session-host-a-b.sess-X.json", { phase: "autonomous", session_id: "sess-X" });
    writeNamed(root, "plan.json", { phase: "autonomous" });
    const ids = readActiveMarkers(root, "host-a").map((m: Record<string, unknown>) => m.session_id).sort();
    assert.deepEqual(ids, ["legado", "sess-A"]);
  });

  it("diretório ausente → [] (nunca lança); marker individual corrompido é pulado", () => {
    assert.deepEqual(readActiveMarkers(freshRoot(), "host-a"), []);
    const root = freshRoot();
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".active-session-host-a.sess-A.json"), "{nope", "utf8");
    writeNamed(root, ".active-session-host-a.sess-B.json", { phase: "autonomous", session_id: "sess-B" });
    assert.deepEqual(readActiveMarkers(root, "host-a").map((m: Record<string, unknown>) => m.session_id), ["sess-B"]);
  });

  function runHook(cwd: string, sessionId: string) {
    const out = execFileSync("node", [HOOK], {
      cwd,
      input: JSON.stringify({ tool_name: "AskUserQuestion", session_id: sessionId }),
      encoding: "utf8",
      timeout: 15_000,
    });
    return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
  }

  it("entrypoint: com 2 rodadas vivas, cada uma é bloqueada pelo PRÓPRIO marker; sessão alheia passa", () => {
    const root = freshRoot();
    execFileSync("git", ["init", "--quiet"], { cwd: root, timeout: 10_000 });
    const tag = (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    // Rodada A (autônoma) + rodada B (ainda no briefing) na mesma máquina.
    writeNamed(root, `.active-session-${tag}.sess-A.json`, { started_at: fresh(), phase: "autonomous", session_id: "sess-A" });
    writeNamed(root, `.active-session-${tag}.sess-B.json`, { started_at: fresh(), phase: "briefing", session_id: "sess-B" });

    assert.equal(runHook(root, "sess-A"), "deny", "rodada A em Fase autônoma tem que continuar bloqueada com B viva");
    assert.equal(runHook(root, "sess-B"), "allow", "rodada B em briefing pode perguntar");
    assert.equal(runHook(root, "sess-develop"), "allow", "sessão alheia nunca é bloqueada");
  });
});
