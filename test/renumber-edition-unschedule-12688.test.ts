/**
 * test/renumber-edition-unschedule-12688.test.ts (#12688)
 *
 * `renumber-edition.ts --apply --unschedule`: desagenda a fila do Worker e o
 * broadcast do Kit antes da troca de ID, no lugar dos dois scripts avulsos da
 * troca 261109 → 261110. Chamadas externas sempre fakes; tudo em tmpdir.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectScheduledSends, unscheduleSends, type UnscheduleDeps } from "../scripts/lib/renumber-edition.ts";
import { runRenumberEdition, runUnschedule, type RenumberCliDeps } from "../scripts/renumber-edition.ts";

let root: string;
const FROM = "261109";
const TO = "261110";
const fromDir = () => join(root, "data", "editions", "2611", FROM);
const toDir = () => join(root, "data", "editions", "2611", TO);

function put(rel: string, content: string): void {
  const p = join(fromDir(), rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const readState = (rel: string, dir = fromDir()) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

function seed(): void {
  put("02-reviewed.md", "Edição 261109\n");
  put("_internal/newsletter-kit-published.json", JSON.stringify({ broadcast_id: 10, status: "scheduled", scheduled_at: "2026-11-09T09:00:00Z", subject: "S" }));
  put(
    "_internal/06-social-published.json",
    JSON.stringify({
      posts: [
        { platform: "instagram", destaque: "d1", status: "scheduled", scheduled_at: "2026-11-09T12:15:00Z", worker_queue_key: "queue:ig-d1" },
        { platform: "threads", destaque: "d2", status: "scheduled", scheduled_at: "2026-11-09T15:15:00Z", worker_queue_key: "queue:th-d2" },
        { platform: "x", destaque: "d1", status: "scheduled", scheduled_at: "2026-11-09T12:15:00Z" },
        { platform: "facebook", destaque: "d3", status: "published", scheduled_at: null },
      ],
    }),
  );
}

function fakes(opts: { gone?: string[]; workerThrows?: string[]; kit?: { ok: boolean; message: string } | "throw" } = {}) {
  const deleted: string[] = [];
  const kitCalls: number[] = [];
  const deps: UnscheduleDeps = {
    nowIso: () => "2026-11-10T12:00:00.000Z",
    deleteWorkerEntry: async (key) => {
      if (opts.workerThrows?.includes(key)) throw new Error("HTTP 500");
      if (opts.gone?.includes(key)) return { deleted: false, alreadyGone: true };
      deleted.push(key);
      return { deleted: true, alreadyGone: false };
    },
    unscheduleKit: async (id) => {
      kitCalls.push(id);
      if (opts.kit === "throw") throw new Error("Kit 503");
      return opts.kit ?? { ok: true, message: "send_at: null confirmado" };
    },
  };
  return { deps, deleted, kitCalls };
}

function cliDeps(): RenumberCliDeps & { logs: string[]; ran: string[][] } {
  const logs: string[] = [];
  const ran: string[][] = [];
  return {
    root,
    logs,
    ran,
    log: (m) => void logs.push(m),
    nowIso: () => "2026-11-10T12:00:00.000Z",
    runStep: (argv) => {
      ran.push(argv);
      return 0;
    },
  };
}

describe("renumber-edition --unschedule (#12688)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12688-"));
    seed();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("REGRESSÃO: apaga da fila do Worker e desagenda o Kit, e o estado local deixa de acusar agendamento", async () => {
    const f = fakes();
    const out = await unscheduleSends(fromDir(), f.deps);
    assert.deepEqual(f.deleted, ["queue:ig-d1", "queue:th-d2"]);
    assert.deepEqual(f.kitCalls, [10]);

    const kit = readState("_internal/newsletter-kit-published.json");
    assert.equal(kit.status, "draft");
    assert.equal("scheduled_at" in kit, false, "scheduled_at antigo removido (senão o PATCH do Kit o repõe)");
    assert.equal(kit.subject, "S", "o resto do registro fica");

    const posts = readState("_internal/06-social-published.json").posts;
    assert.equal(posts[0].status, "deleted");
    assert.equal(posts[0].deleted_reason, "renumber_edition");
    assert.equal(posts[1].status, "deleted");
    assert.equal(posts[2].status, "scheduled", "X (Buffer, sem key) não é tocado");
    assert.equal(posts[3].status, "published");

    assert.deepEqual(
      out.map((o) => `${o.what}=${o.result}`),
      ["kit-newsletter=unscheduled", "social:instagram/d1=unscheduled", "social:threads/d2=unscheduled", "social:x/d1=manual"],
    );
    // Só o que não tem caminho automático continua no aviso.
    assert.deepEqual(detectScheduledSends(fromDir(), "x").map((s) => s.what), ["social:x/d1"]);
  });

  it("404 no Worker não mexe no registro (post pode ter disparado) e o item segue no aviso", async () => {
    const out = await unscheduleSends(fromDir(), fakes({ gone: ["queue:ig-d1"] }).deps);
    assert.equal(out.find((o) => o.what === "social:instagram/d1")!.result, "already_gone");
    assert.equal(readState("_internal/06-social-published.json").posts[0].status, "scheduled");
    assert.ok(detectScheduledSends(fromDir(), "x").some((s) => s.what === "social:instagram/d1"));
  });

  it("falha de um item não interrompe os outros e não grava o que falhou", async () => {
    const out = await unscheduleSends(fromDir(), fakes({ workerThrows: ["queue:ig-d1"], kit: "throw" }).deps);
    assert.equal(out.find((o) => o.what === "kit-newsletter")!.result, "failed");
    assert.equal(out.find((o) => o.what === "social:instagram/d1")!.result, "failed");
    assert.equal(out.find((o) => o.what === "social:threads/d2")!.result, "unscheduled");
    assert.equal(readState("_internal/newsletter-kit-published.json").status, "scheduled");
    const posts = readState("_internal/06-social-published.json").posts;
    assert.equal(posts[0].status, "scheduled");
    assert.equal(posts[1].status, "deleted");
  });

  it("Kit sem desagendamento confirmado ⇒ failed, estado intacto", async () => {
    const out = await unscheduleSends(fromDir(), fakes({ kit: { ok: false, message: "releitura ainda mostra send_at" } }).deps);
    assert.equal(out[0]!.result, "failed");
    assert.match(out[0]!.detail, /releitura/);
    assert.equal(readState("_internal/newsletter-kit-published.json").status, "scheduled");
  });

  it("Brevo diária agendada entra no aviso e sai manual", async () => {
    put("_internal/brevo-diaria-published.json", JSON.stringify({ campaign_id: 5, status: "scheduled", scheduled_at: "2026-11-09T09:30:00Z" }));
    const det = detectScheduledSends(fromDir(), "x").find((s) => s.what === "brevo-diaria");
    assert.equal(det?.scheduled_at, "2026-11-09T09:30:00Z");
    const out = await unscheduleSends(fromDir(), fakes().deps);
    assert.equal(out.find((o) => o.what === "brevo-diaria")!.result, "manual");
  });

  it("runUnschedule com falha ⇒ exit 1; depois de tudo desagendado o --run-remote segue sem --ack-scheduled", async () => {
    const d = cliDeps();
    const failed = await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: fakes({ kit: "throw" }).deps });
    assert.equal(failed, 1);
    assert.match(d.logs.join("\n"), /nada renumerado/);

    // Sem o X (Buffer) no seed, tudo sai pela via automática.
    const social = readState("_internal/06-social-published.json");
    social.posts = social.posts.filter((p: { platform: string }) => p.platform !== "x");
    writeFileSync(join(fromDir(), "_internal", "06-social-published.json"), JSON.stringify(social));
    const ok = await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: fakes().deps });
    assert.equal(ok, 0);
    const d2 = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, d2), 0);
    assert.doesNotMatch(d2.logs.join("\n"), /ATENÇÃO/);
    assert.equal(readState("_internal/newsletter-kit-published.json", toDir()).status, "draft");
    assert.ok(!existsSync(fromDir()));
  });

  it("runUnschedule respeita a precondição do planRenumber (destino existe ⇒ exit 2, nada chamado)", async () => {
    mkdirSync(toDir(), { recursive: true });
    const f = fakes();
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: f.deps }), 2);
    assert.equal(f.deleted.length + f.kitCalls.length, 0);
  });
});
