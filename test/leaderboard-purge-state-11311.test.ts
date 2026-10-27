/**
 * test/leaderboard-purge-state-11311.test.ts (#11311)
 *
 * O PENDENTE da purga de votos do editor (§6h do Stage 6) existia só em prosa
 * do playbook: o coordenador tinha que lembrar do motivo até o Resumo final.
 * Agora `purge-leaderboard.ts --edition-dir` grava
 * `_internal/leaderboard-purge.json` e o resumo lê via
 * `scripts/lib/leaderboard-purge-state.ts --summary`. Cobre os dois lados:
 * quem grava (script real, sem rede) e quem lê (linha do resumo), mais o
 * wiring no playbook.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyCheckAuth,
  applyEmailResult,
  derivePurgeStatus,
  formatPurgeSummaryLine,
  LEADERBOARD_PURGE_STATE_RELPATH,
  readLeaderboardPurgeState,
  writeLeaderboardPurgeState,
} from "../scripts/lib/leaderboard-purge-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PURGE_SCRIPT = resolve(ROOT, "scripts", "purge-leaderboard.ts");
const STATE_SCRIPT = resolve(ROOT, "scripts", "lib", "leaderboard-purge-state.ts");
const NOW = new Date("2026-10-27T09:00:00Z");
// As 2 contas do editor vêm do playbook (`--expect-emails`), nunca de código de produção.
const EDITOR_PURGE_EMAILS = ["pixel@memelab.com.br", "vjpixel@gmail.com"];

function fullRun() {
  let s = applyCheckAuth({ ok: true, backend: "rest", motivo: null }, EDITOR_PURGE_EMAILS, NOW);
  s = applyEmailResult(s, EDITOR_PURGE_EMAILS[0], { ok: true, keys_deleted: 7, motivo: null }, NOW);
  s = applyEmailResult(s, EDITOR_PURGE_EMAILS[1], { ok: true, keys_deleted: 0, motivo: null }, NOW);
  return s;
}

describe("leaderboard-purge-state — derivação (#11311)", () => {
  it("pré-check ok + as 2 contas ok → status ok, keys somadas, backend do pré-check", () => {
    const s = fullRun();
    assert.equal(s.status, "ok");
    assert.equal(s.keys_deleted, 7);
    assert.equal(s.backend, "rest");
    assert.equal(formatPurgeSummaryLine({ kind: "ok", state: s }), "Purga de votos do editor: 7 keys apagadas (rest)");
  });

  it("pré-check falhou → pendente com o motivo do pré-check", () => {
    const s = applyCheckAuth({ ok: false, backend: null, motivo: "sem backend de KV: x" }, EDITOR_PURGE_EMAILS, NOW);
    assert.equal(s.status, "pendente");
    assert.match(formatPurgeSummaryLine({ kind: "ok", state: s }), /^⚠ Purga de votos do editor: PENDENTE — sem backend de KV: x \(rodar \/diaria-remover-votos-pixel\)$/);
  });

  it("só 1 das 2 contas registrada → pendente nomeando a que falta", () => {
    let s = applyCheckAuth({ ok: true, backend: "wrangler", motivo: null }, EDITOR_PURGE_EMAILS, NOW);
    s = applyEmailResult(s, EDITOR_PURGE_EMAILS[0], { ok: true, keys_deleted: 3, motivo: null }, NOW);
    assert.equal(s.status, "pendente");
    assert.match(s.motivo!, new RegExp(`purga de ${EDITOR_PURGE_EMAILS[1]} não registrada`));
  });

  it("uma conta falhou → pendente com e-mail e motivo", () => {
    let s = fullRun();
    s = applyEmailResult(s, EDITOR_PURGE_EMAILS[1], { ok: false, keys_deleted: null, motivo: "erro: 500" }, NOW);
    assert.equal(s.status, "pendente");
    assert.match(formatPurgeSummaryLine({ kind: "ok", state: s }), /vjpixel@gmail\.com: erro: 500/);
  });

  it("pré-check sem --expect-emails → PENDENTE (fail-closed: nada registrado não prova purga)", () => {
    const s = applyCheckAuth({ ok: true, backend: "rest", motivo: null }, [], NOW);
    assert.equal(s.status, "pendente");
    assert.match(s.motivo!, /--expect-emails/);
  });

  it("novo pré-check zera os e-mails da rodada anterior", () => {
    const s = applyCheckAuth({ ok: true, backend: "rest", motivo: null }, EDITOR_PURGE_EMAILS, NOW);
    assert.deepEqual(s.emails, {});
    assert.equal(s.status, "pendente");
  });

  it("o leitor recalcula o status: arquivo com status 'ok' mas e-mail faltando sai PENDENTE", () => {
    const forged = { ...applyCheckAuth({ ok: true, backend: "rest", motivo: null }, EDITOR_PURGE_EMAILS, NOW), status: "ok" as const };
    assert.equal(derivePurgeStatus(forged).status, "pendente");
    assert.match(formatPurgeSummaryLine({ kind: "ok", state: forged }), /PENDENTE/);
  });

  it("arquivo ausente ou ilegível → PENDENTE (o §6h nem rodou)", () => {
    const dir = mkdtempSync(join(tmpdir(), "purge-state-"));
    try {
      const absent = readLeaderboardPurgeState(dir);
      assert.equal(absent.kind, "absent");
      assert.match(formatPurgeSummaryLine(absent), /^⚠ Purga de votos do editor: PENDENTE — o §6h não gravou/);
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, LEADERBOARD_PURGE_STATE_RELPATH), "{oops");
      const invalid = readLeaderboardPurgeState(dir);
      assert.equal(invalid.kind, "invalid");
      assert.match(formatPurgeSummaryLine(invalid), /PENDENTE — .*ilegível/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escrita + leitura fazem round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "purge-state-"));
    try {
      writeLeaderboardPurgeState(dir, fullRun());
      const r = readLeaderboardPurgeState(dir);
      assert.equal(r.kind, "ok");
      assert.match(formatPurgeSummaryLine(r), /7 keys apagadas \(rest\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("purge-leaderboard.ts --edition-dir grava o estado (script real, sem rede)", () => {
  function run(script: string, args: string[]) {
    return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        // dotenv não sobrescreve chave existente — string vazia = ausente. Sem
        // credencial nenhuma, `--kv-backend rest` resolve `none` sem tocar rede.
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "",
        ADMIN_SECRET: "",
        POLL_ADMIN_SECRET: "",
      },
    });
  }

  it("pré-check sem backend → arquivo PENDENTE com o motivo, e o --summary imprime a linha", () => {
    const dir = mkdtempSync(join(tmpdir(), "purge-state-cli-"));
    try {
      const r = run(PURGE_SCRIPT, [
        "--check-auth", "--kv-backend", "rest", "--edition-dir", dir, "--expect-emails", EDITOR_PURGE_EMAILS.join(","),
      ]);
      assert.equal(r.status, 1, r.stderr);
      const state = JSON.parse(readFileSync(join(dir, LEADERBOARD_PURGE_STATE_RELPATH), "utf8"));
      assert.equal(state.status, "pendente");
      assert.equal(state.check_auth.ok, false);
      assert.match(state.motivo, /CLOUDFLARE_API_TOKEN/);
      assert.doesNotMatch(state.motivo, /^\[purge\]/, "motivo sem o prefixo do log");
      assert.deepEqual(state.expected_emails, EDITOR_PURGE_EMAILS);

      const summary = run(STATE_SCRIPT, ["--edition-dir", dir, "--summary"]);
      assert.equal(summary.status, 0, summary.stderr);
      assert.match(summary.stdout.trim(), /^⚠ Purga de votos do editor: PENDENTE — .*CLOUDFLARE_API_TOKEN.*\(rodar \/diaria-remover-votos-pixel\)$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--execute que falha cedo (sem ADMIN_SECRET) grava o e-mail como falho", () => {
    const dir = mkdtempSync(join(tmpdir(), "purge-state-cli-"));
    try {
      const r = run(PURGE_SCRIPT, ["--email", "vjpixel@gmail.com", "--execute", "--kv-backend", "rest", "--edition-dir", dir]);
      assert.equal(r.status, 1, r.stderr);
      const state = JSON.parse(readFileSync(join(dir, LEADERBOARD_PURGE_STATE_RELPATH), "utf8"));
      assert.equal(state.emails["vjpixel@gmail.com"].ok, false);
      assert.match(state.emails["vjpixel@gmail.com"].motivo, /ADMIN_SECRET/);
      assert.equal(state.status, "pendente");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run (sem --execute) não grava nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "purge-state-cli-"));
    try {
      run(PURGE_SCRIPT, ["--email", "vjpixel@gmail.com", "--kv-backend", "rest", "--edition-dir", dir]);
      assert.equal(readLeaderboardPurgeState(dir).kind, "absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wiring no playbook do Stage 6 (#11311)", () => {
  const playbook = readFileSync(resolve(ROOT, ".claude", "agents", "orchestrator-stage-6.md"), "utf8");

  it("§6h passa --edition-dir nas 3 chamadas da purga (pré-check + 2 --execute)", () => {
    const calls = playbook.match(/^npx tsx scripts\/purge-leaderboard\.ts .*$/gm) ?? [];
    assert.equal(calls.length, 3, calls.join("\n"));
    for (const c of calls) assert.match(c, /--edition-dir \{EDITION_DIR\}\//, c);
  });

  it("o pré-check declara como --expect-emails exatamente as contas dos 2 --execute", () => {
    const calls = playbook.match(/^npx tsx scripts\/purge-leaderboard\.ts .*$/gm) ?? [];
    const check = calls.find((c) => c.includes("--check-auth"))!;
    const expected = /--expect-emails (\S+)/.exec(check)?.[1].split(",") ?? [];
    const executed = calls.filter((c) => c.includes("--execute")).map((c) => /--email (\S+)/.exec(c)![1]);
    assert.deepEqual([...expected].sort(), [...executed].sort());
    assert.equal(expected.length, 2);
  });

  it("Resumo final lê o arquivo via --summary em vez de memória de sessão", () => {
    const resumo = playbook.slice(playbook.indexOf("## Resumo final"));
    assert.match(resumo, /scripts\/lib\/leaderboard-purge-state\.ts --edition-dir \{EDITION_DIR\}\/ --summary/);
  });
});
