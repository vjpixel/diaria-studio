/**
 * test/continuo-ratelimit-notes-10074.test.ts (#10074)
 *
 * Regressão: desde o #10070 o timer horário (`run-continuo-ratelimit-watchdog.ts`)
 * pausa/retoma o contínuo em `403 Key limit exceeded` antes do watch diário do
 * Hermes. A mensagem do `pause-cron-on-ratelimit.py` ficava só no log da task;
 * quando o watch rodava, o job já estava pausado, o Python ficava calado e o
 * editor nunca via o aviso. Agora o wrapper enfileira o aviso e o watch drena
 * a fila pro stdout (Telegram).
 *
 * Cobre:
 *   - o ramo de PAUSA pelo wrapper, ponta a ponta com o Python real (job
 *     ativo, failure_streak>=2, last_error com 403 → exit 0, marcador
 *     gravado, evento emitido, aviso enfileirado);
 *   - a drenagem (CLI real) entrega o aviso uma vez e esvazia a fila;
 *   - falha ao enfileirar vira exit 1 (unit `failed`), nunca silêncio;
 *   - o watch chama a drenagem e imprime os avisos no stdout.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runContinuoRatelimitWatchdog, spawnPauseWatchdog } from "../scripts/run-continuo-ratelimit-watchdog.ts";
import {
  appendRatelimitNote,
  drainRatelimitNotes,
  formatRatelimitNotes,
  parseRatelimitNotes,
  ratelimitNotesPath,
} from "../scripts/lib/continuo-ratelimit-notes.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOB_ID = "5d791ef6fc2c";
const SYSTEMD_LIKE_PATH = "/usr/bin:/bin";
const PYTHON = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

/** Job ATIVO batendo no 403 de key limit, sem marcador — o caso da pausa. */
function makeActiveJobHome(): { home: string; callsFile: string; markerPath: string } {
  const home = mkdtempSync(join(tmpdir(), "ratelimit-notes-10074-"));
  homes.push(home);
  const cronDir = join(home, ".hermes", "cron");
  mkdirSync(cronDir, { recursive: true });
  writeFileSync(
    join(cronDir, "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          id: JOB_ID,
          enabled: true,
          failure_streak: 2,
          last_error: "RuntimeError: HTTP 403: Key limit exceeded (daily limit)",
          last_run_at: "2026-10-13T11:00:00Z",
        },
      ],
    }),
  );
  const binDir = join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const callsFile = join(home, "hermes-calls.txt");
  const fakeHermes = join(binDir, "hermes");
  writeFileSync(fakeHermes, `#!/bin/sh\necho "$@" >> "${callsFile}"\nexit 0\n`);
  chmodSync(fakeHermes, 0o755);
  return { home, callsFile, markerPath: join(cronDir, ".paused-by-watchdog") };
}

describe("#10074 — ramo de pausa pelo wrapper enfileira o aviso pro watch", () => {
  it("job ativo + failure_streak>=2 + 403 → pausa, exit 0, marcador key_limit, evento info, aviso na fila", () => {
    const fake = makeActiveJobHome();
    const events: Array<{ level: string; message: string }> = [];
    const notesPath = ratelimitNotesPath(fake.home);
    const code = runContinuoRatelimitWatchdog({
      runPython: () => spawnPauseWatchdog({ home: fake.home, env: { PATH: SYSTEMD_LIKE_PATH }, pythonBin: PYTHON }),
      log: () => {},
      recordEvent: (level, message) => events.push({ level, message }),
      queueNote: (m) => appendRatelimitNote(notesPath, m),
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(fake.callsFile, "utf8").trim(), `cron pause ${JOB_ID}`);
    const marker = JSON.parse(readFileSync(fake.markerPath, "utf8"));
    assert.equal(marker.reason, "key_limit");
    assert.equal(typeof marker.resume_after, "number");
    assert.equal(events.length, 1);
    assert.equal(events[0].level, "info");
    assert.match(events[0].message, /pausado/i);

    const queued = parseRatelimitNotes(readFileSync(notesPath, "utf8"));
    assert.equal(queued.length, 1);
    assert.match(queued[0].message, /pausado/i);
    assert.match(queued[0].message, /Retomada automática após/);
  });

  it("drenagem pelo CLI real entrega o aviso uma vez e esvazia a fila", () => {
    const fake = makeActiveJobHome();
    const notesPath = ratelimitNotesPath(fake.home);
    appendRatelimitNote(notesPath, "⏸️ **Diária Contínuo pausado** pelo watchdog", new Date("2026-10-13T14:00:00Z"));
    const run = () =>
      execFileSync("npx", ["tsx", join(ROOT, "scripts", "drain-continuo-ratelimit-notes.ts"), "--home", fake.home], {
        cwd: ROOT,
        encoding: "utf8",
      });
    const first = run();
    assert.match(first, /\[contínuo · 13\/10 14:00 UTC\] ⏸️ \*\*Diária Contínuo pausado\*\*/);
    assert.equal(existsSync(notesPath), false, "fila deveria ter sido esvaziada");
    assert.equal(run().trim(), "", "2ª drenagem não repete o aviso");
  });

  it("falha ao enfileirar → exit 1 e evento de erro (o aviso não pode sumir em silêncio)", () => {
    const events: Array<{ level: string; message: string }> = [];
    const code = runContinuoRatelimitWatchdog({
      runPython: () => ({ status: 0, stdout: "⏸️ **Diária Contínuo pausado** pelo watchdog\n", stderr: "" }),
      log: () => {},
      recordEvent: (level, message) => events.push({ level, message }),
      queueNote: () => "EACCES: permission denied",
    });
    assert.equal(code, 1);
    assert.deepEqual(events.map((e) => e.level), ["info", "error"]);
    assert.match(events[1].message, /EACCES/);
  });

  it("silêncio e falha do Python não enfileiram nada", () => {
    const queued: string[] = [];
    const deps = (stdout: string) => ({
      runPython: () => ({ status: 0, stdout, stderr: "" }),
      log: () => {},
      recordEvent: () => {},
      queueNote: (m: string) => {
        queued.push(m);
        return null;
      },
    });
    assert.equal(runContinuoRatelimitWatchdog(deps("")), 0);
    assert.equal(runContinuoRatelimitWatchdog(deps("⚠️ Watchdog tentou retomar x e falhou: y")), 1);
    assert.deepEqual(queued, []);
  });
});

describe("#10074 — helpers da fila", () => {
  it("linha inválida entra crua; mensagem multilinha vira uma linha só", () => {
    const notes = parseRatelimitNotes(`{"at":"2026-10-13T01:05:00Z","message":"▶️ retomado\\nlinha 2"}\nlixo solto\n\n`);
    assert.equal(notes.length, 2);
    assert.equal(notes[1].message, "lixo solto");
    assert.equal(
      formatRatelimitNotes(notes),
      "[contínuo · 13/10 01:05 UTC] ▶️ retomado linha 2\n[contínuo · horário desconhecido] lixo solto",
    );
  });

  it("fila ausente → drenagem vazia, sem erro", () => {
    const home = mkdtempSync(join(tmpdir(), "ratelimit-notes-10074-empty-"));
    homes.push(home);
    assert.deepEqual(drainRatelimitNotes(ratelimitNotesPath(home)), { notes: [] });
  });
});

describe("#10074 — watch-continuo-health.sh entrega os avisos", () => {
  const watch = readFileSync(join(ROOT, "hermes", "scripts", "watch-continuo-health.sh"), "utf8");

  it("drena a fila e soma ao bloco de avisos", () => {
    assert.match(watch, /RL_DRAIN=\$\(npx tsx \/home\/vjpixel\/diaria-studio\/scripts\/drain-continuo-ratelimit-notes\.ts/);
    assert.match(watch, /RATELIMIT_NOTES="\$\{RATELIMIT_NOTES\}\$\{RL_DRAIN\}"/);
  });

  it("a saída do Python rodado pelo próprio watch também vai pros avisos", () => {
    assert.match(watch, /RATELIMIT_NOTES="\$\{RATELIMIT_NOTES\}\$\{PAUSE_OUT\}"/);
  });

  it("os avisos saem no stdout (entregue no Telegram), depois do portão de issues", () => {
    const gate = watch.indexOf('if [ "$ISSUES_CREATED" -gt 0 ]; then');
    const deliver = watch.indexOf('if [ -n "$RATELIMIT_NOTES" ]; then\n  printf \'%s\' "$RATELIMIT_NOTES"\nfi');
    assert.ok(gate > 0 && deliver > gate, "bloco de entrega dos avisos ausente ou fora de ordem");
  });
});
