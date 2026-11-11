/**
 * test/renumber-edition-unschedule-gaps-12803.test.ts (#12803)
 *
 * Quatro lacunas do `renumber-edition --unschedule` achadas no review diário:
 *   1. retomada com `--unschedule` desagendava a agenda NOVA (Etapa 6 já
 *      rodada na pasta nova);
 *   2. semanal de frio `created_unverified` herdada (pode estar agendada no
 *      Kit) ficava agendada quando o principal saía da agenda com sucesso;
 *   3. forense já existente, colisão de nome e `edition-lock` vivo só
 *      recusavam DEPOIS do desagendamento;
 *   4. `.` como borda trocava o ID dentro de número decimal (`12.261109`).
 * Chamadas externas sempre fakes; tudo em tmpdir.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replaceEditionId, scheduledOnOldDate, unscheduleSends, type UnscheduleDeps } from "../scripts/lib/renumber-edition.ts";
import { runRenumberEdition, runUnschedule, type RenumberCliDeps } from "../scripts/renumber-edition.ts";

let root: string;
const FROM = "261109";
const TO = "261110";
const NOW = "2026-11-10T12:00:00.000Z";
const fromDir = () => join(root, "data", "editions", "2611", FROM);
const toDir = () => join(root, "data", "editions", "2611", TO);

function putIn(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const put = (rel: string, content: string) => putIn(fromDir(), rel, content);
const readState = (rel: string, dir = fromDir()) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

function seedOld(): void {
  put("02-reviewed.md", `Edição ${FROM}\n`);
  put("_internal/newsletter-kit-published.json", JSON.stringify({ broadcast_id: 10, status: "scheduled", scheduled_at: "2026-11-09T09:00:00Z" }));
  put(
    "_internal/06-social-published.json",
    JSON.stringify({ posts: [{ platform: "instagram", destaque: "d1", status: "scheduled", scheduled_at: "2026-11-09T12:15:00Z", worker_queue_key: "queue:ig-old" }] }),
  );
}

function fakes(opts: { kitFail?: number[] } = {}) {
  const calls: string[] = [];
  const deps: UnscheduleDeps = {
    nowIso: () => NOW,
    deleteWorkerEntry: async (key) => {
      calls.push(`worker:${key}`);
      return { deleted: true, alreadyGone: false };
    },
    unscheduleKit: async (id) => {
      calls.push(`kit:${id}`);
      return opts.kitFail?.includes(id) ? { ok: false, message: "Kit 503" } : { ok: true, message: "send_at: null confirmado" };
    },
  };
  return { deps, calls };
}

function cliDeps(failStep = false): RenumberCliDeps & { logs: string[]; ran: string[][] } {
  const logs: string[] = [];
  const ran: string[][] = [];
  return {
    root,
    logs,
    ran,
    log: (m) => void logs.push(m),
    nowIso: () => NOW,
    runStep: (argv) => {
      ran.push(argv);
      return failStep ? 1 : 0;
    },
  };
}

describe("#12803 item 1 — retomada com --unschedule não desagenda a edição nova", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12803-1-"));
    seedOld();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function firstRunFailsRemote() {
    const f = fakes();
    const d = cliDeps(true);
    assert.equal(await runUnschedule({ from: FROM, to: TO, runRemote: true }, { root, log: d.log, unschedule: f.deps }), 0);
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, d), 1, "passo remoto falha");
    assert.ok(existsSync(toDir()) && !existsSync(fromDir()));
  }

  it("REGRESSÃO: Etapa 6 reagendou na pasta nova ⇒ repetir o mesmo comando mantém Kit e posts novos", async () => {
    await firstRunFailsRemote();
    // Etapa 5/6 na pasta nova: agenda do dia novo.
    putIn(toDir(), "_internal/newsletter-kit-published.json", JSON.stringify({ broadcast_id: 20, status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z" }));
    putIn(
      toDir(),
      "_internal/kit-semanal-frio-published.json",
      JSON.stringify({ broadcast_id: 21, status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z" }),
    );
    putIn(
      toDir(),
      "_internal/06-social-published.json",
      JSON.stringify({ posts: [{ platform: "instagram", destaque: "d1", status: "scheduled", scheduled_at: "2026-11-10T12:15:00Z", worker_queue_key: "queue:ig-new" }] }),
    );
    const f = fakes();
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO, runRemote: true }, { root, log: d.log, unschedule: f.deps }), 0);
    assert.deepEqual(f.calls, [], "nada da agenda nova tocado");
    assert.equal(readState("_internal/newsletter-kit-published.json", toDir()).status, "scheduled");
    assert.equal(readState("_internal/kit-semanal-frio-published.json", toDir()).status, "scheduled");
    assert.equal(readState("_internal/06-social-published.json", toDir()).posts[0].status, "scheduled");
    assert.match(d.logs.join("\n"), /\[kept\] kit-newsletter: retomada: agendado para 261110/);
    // A agenda nova também não entra no aviso de "agendado no dia antigo": a retomada segue.
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, d), 0);
    assert.doesNotMatch(d.logs.join("\n"), /já AGENDADO/);
  });

  it("retomada com algo ainda no dia antigo desagenda só esse item", async () => {
    await firstRunFailsRemote();
    putIn(toDir(), "_internal/newsletter-kit-published.json", JSON.stringify({ broadcast_id: 20, status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z" }));
    putIn(
      toDir(),
      "_internal/06-social-published.json",
      JSON.stringify({
        posts: [
          { platform: "instagram", destaque: "d1", status: "scheduled", scheduled_at: "2026-11-10T12:15:00Z", worker_queue_key: "queue:ig-new" },
          { platform: "threads", destaque: "d2", status: "scheduled", scheduled_at: "2026-11-09T15:15:00Z", worker_queue_key: "queue:th-old" },
        ],
      }),
    );
    const f = fakes();
    const out = await unscheduleSends(toDir(), f.deps, { onlyScheduledOn: FROM });
    assert.deepEqual(f.calls, ["worker:queue:th-old"]);
    assert.deepEqual(out.map((o) => o.result), ["kept", "kept", "unscheduled"]);
  });

  it("retomada com scheduled_at ilegível falha sem tocar (exit 1)", async () => {
    await firstRunFailsRemote();
    putIn(toDir(), "_internal/newsletter-kit-published.json", JSON.stringify({ broadcast_id: 20, status: "scheduled" }));
    const f = fakes();
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: f.deps }), 1);
    assert.deepEqual(f.calls, []);
    assert.match(d.logs.join("\n"), /retomada parada antes dos passos remotos/);
  });

  it("scheduledOnOldDate usa o dia em BRT e trata ilegível como do dia antigo", () => {
    assert.equal(scheduledOnOldDate("2026-11-09T09:00:00Z", FROM), true);
    assert.equal(scheduledOnOldDate("2026-11-10T02:00:00Z", FROM), true, "23:00 BRT do dia 9");
    assert.equal(scheduledOnOldDate("2026-11-10T09:00:00Z", FROM), false);
    assert.equal(scheduledOnOldDate(null, FROM), true);
    assert.equal(scheduledOnOldDate("lixo", FROM), true);
  });
});

describe("#12803 item 2 — semanal created_unverified herdada sai da agenda junto do principal", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12803-2-"));
    seedOld();
    put(
      "_internal/kit-semanal-frio-published.json",
      JSON.stringify({ broadcast_id: 11, status: "created_unverified", scheduled_at: "2026-11-09T09:00:00Z", reason: "agendamento não confirmado na releitura" }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("REGRESSÃO: principal desagendado com sucesso ⇒ a semanal herdada também é desagendada (antes do principal)", async () => {
    const f = fakes();
    const out = await unscheduleSends(fromDir(), f.deps);
    assert.deepEqual(f.calls.slice(0, 2), ["kit:11", "kit:10"]);
    const sem = out.find((o) => o.what === "kit-semanal-frio")!;
    assert.equal(sem.result, "unscheduled");
    assert.match(sem.detail, /created_unverified: podia estar agendada/);
    assert.equal(readState("_internal/newsletter-kit-published.json").status, "draft");
  });

  it("desagendamento da semanal herdada falha ⇒ principal fica agendado (par coerente), exit 1", async () => {
    const f = fakes({ kitFail: [11] });
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: f.deps }), 1);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("kit:")), ["kit:11"]);
    assert.equal(readState("_internal/newsletter-kit-published.json").status, "scheduled");
  });

  it("semanal created_unverified sem broadcast_id não tem o que desagendar", async () => {
    put("_internal/kit-semanal-frio-published.json", JSON.stringify({ status: "created_unverified" }));
    const f = fakes();
    await unscheduleSends(fromDir(), f.deps);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("kit:")), ["kit:10"]);
  });
});

describe("#12803 item 3 — recusas da parte local antes de desagendar", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12803-3-"));
    seedOld();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("REGRESSÃO: forense 06-public-images.{de}.json já existe ⇒ exit 2, nada desagendado", async () => {
    put("06-public-images.json", "{}");
    put(`_internal/_forensic/06-public-images.${FROM}.json`, "{}");
    const f = fakes();
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: f.deps }), 2);
    assert.deepEqual(f.calls, []);
    assert.match(d.logs.join("\n"), /não sobrescreve forense\)\. Nada desagendado/);
    assert.equal(readState("_internal/newsletter-kit-published.json").status, "scheduled");
  });

  it("REGRESSÃO: colisão de nome ⇒ exit 2, nada desagendado", async () => {
    put(`diaria-comentada-${FROM}.srt`, "1\n");
    put(`diaria-comentada-${TO}.srt`, "1\n");
    const f = fakes();
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: f.deps }), 2);
    assert.deepEqual(f.calls, []);
    assert.match(d.logs.join("\n"), /já existe na edição/);
  });

  it("REGRESSÃO: edition-lock vivo ⇒ exit 2, nada desagendado; trava vencida não recusa", async () => {
    const lock = { session_id: "s-outra", host: "neo", stage: 6, acquired_at: NOW, heartbeat_at: "2026-11-10T11:50:00.000Z" };
    put("_internal/edition-lock.json", JSON.stringify(lock));
    const f = fakes();
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: f.deps }), 2);
    assert.deepEqual(f.calls, []);
    assert.match(d.logs.join("\n"), /edition-lock vivo .*sessão s-outra.*--unschedule recusado/);
    put("_internal/edition-lock.json", JSON.stringify({ ...lock, heartbeat_at: "2026-11-10T09:00:00.000Z" }));
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: cliDeps().log, unschedule: fakes().deps }), 0);
  });
});

describe("#12803 item 4 — ponto entre dígitos não é borda", () => {
  it("REGRESSÃO: número decimal com o ID não é trocado", () => {
    assert.deepEqual(replaceEditionId('{"start": 12.261109, "end": 261109.5}', FROM, TO), { text: '{"start": 12.261109, "end": 261109.5}', count: 0 });
  });

  it("ponto ao lado de não-dígito segue sendo borda", () => {
    assert.equal(replaceEditionId("diaria-comentada-261109.srt", FROM, TO).text, "diaria-comentada-261110.srt");
    assert.equal(replaceEditionId("fim 261109.", FROM, TO).text, "fim 261110.");
    assert.equal(replaceEditionId("v.261109", FROM, TO).text, "v.261110");
  });
});
