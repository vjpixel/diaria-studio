/**
 * Regressão #12110: o #11883 passou `isCircleStackScheduledRunPast` para o
 * relógio BRT, mas a EXECUÇÃO da task seguia no relógio do processo:
 * `today = formatAAMMDD(runStartedAt)` e os defaults de `--publish-monday`
 * (`nextMondayAAMMDD(now())`/`currentOrPreviousMondayAAMMDD(now())`). No `300`
 * (Etc/UTC), um catch-up do `Persistent=true` às 23:30 BRT de segunda já era
 * terça 02:30 UTC e virava "Não enviado (fora da segunda de publicação)"
 * mesmo com o ciclo aprovado. Os casos rodam com `TZ` trocado e o resultado
 * tem de ser o mesmo.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCircleStackApproval, circleStackBrtDay } from "../scripts/lib/circle-stack-schedule.ts";
import { formatAAMMDD, resolveWeeklyLinkedinCycle } from "../scripts/lib/weekly-linkedin-cycle.ts";
import {
  approveCircleStackCycle,
  resolveCyclePaths,
  runScheduledCircleStack,
  runScheduledCircleStackPublish,
} from "../scripts/publish-circle-stack-scheduled.ts";
import type { PushMessage } from "../scripts/lib/push-notify.ts";

const MONDAY = "261109";
const CYCLE = resolveWeeklyLinkedinCycle(MONDAY)!.cycle;
// Segunda 09/11/2026 23:30 BRT = terça 10/11 02:30 UTC.
const MONDAY_2330_BRT = new Date("2026-11-10T02:30:00Z");
const ZONES = ["Etc/UTC", "America/Sao_Paulo", "Asia/Tokyo"];

const originalTz = process.env.TZ;
function restoreTz(): void {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
}

function selectionJson(): string {
  return JSON.stringify({
    cycle: CYCLE,
    contentWindow: [],
    weeklyEditions: [],
    destaques: [],
    lancamentos: [],
    useMelhor: [],
    radar: [
      {
        editionDate: "261103",
        url: "https://exemplo.com.br/noticia",
        title: "Novo modelo chega para todos os usuários",
        body: "corpo",
        why: "porque",
      },
    ],
  });
}

function setup(approve: boolean) {
  const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-12110-"));
  const paths = resolveCyclePaths(dataRoot, MONDAY);
  mkdirSync(join(paths.selectionPath, ".."), { recursive: true });
  const sel = selectionJson();
  writeFileSync(paths.selectionPath, sel);
  if (approve) writeFileSync(paths.approvalPath, JSON.stringify(buildCircleStackApproval(CYCLE, sel, new Date("2026-11-07T18:00:00Z"))));
  return { dataRoot, paths };
}

describe("Stack: execução agendada decide a segunda em BRT (#12110)", () => {
  afterEach(restoreTz);

  it("catch-up às 23:30 BRT de segunda (terça 02:30 UTC) envia o ciclo aprovado, em qualquer TZ do processo", async () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      const { paths } = setup(true);
      const calls: string[][] = [];
      const emails: PushMessage[] = [];
      const res = await runScheduledCircleStackPublish(paths, {
        rootDir: "/repo",
        platformConfig: {},
        env: {},
        now: () => MONDAY_2330_BRT,
        runPublish: async (argv) => {
          calls.push(argv);
          const at = new Date(MONDAY_2330_BRT.getTime() + 5000).toISOString();
          writeFileSync(paths.statePath, JSON.stringify({ cycle: CYCLE, attempted_at: at, published_at: at }));
        },
        sendEmail: async (m) => {
          emails.push(m);
          return { ok: true };
        },
      });
      assert.equal(res.outcome.kind, "publicado", `${tz}: ${JSON.stringify(res.outcome)}`);
      assert.equal(calls.length, 1, tz);
      assert.match(emails[0].subject, /Publicado/, tz);
    }
  });

  it("terça 00:30 BRT (03:30 UTC) segue fora da janela, em qualquer TZ", async () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      const { paths } = setup(true);
      const res = await runScheduledCircleStackPublish(paths, {
        rootDir: "/repo",
        platformConfig: {},
        env: {},
        now: () => new Date("2026-11-10T03:30:00Z"),
        runPublish: async () => assert.fail("fora da janela"),
        sendEmail: async () => ({ ok: true }),
      });
      assert.equal(res.outcome.kind, "nao-enviado", tz);
      assert.match((res.outcome as { reason: string }).reason, /execução em 261110, fora da segunda/, tz);
    }
  });

  it("default de --publish-monday sai da segunda BRT: --revoke às 23:30 BRT de segunda mira 261109, não 261116", async () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      const { dataRoot, paths } = setup(true);
      const code = await runScheduledCircleStack(["--revoke", "--data-root", dataRoot], {
        rootDir: dataRoot,
        platformConfig: {},
        env: {},
        now: () => MONDAY_2330_BRT,
      });
      assert.equal(code, 0, tz);
      assert.equal(existsSync(paths.approvalPath), false, `${tz}: a aprovação do ciclo de ${MONDAY} devia sair`);
    }
  });

  it("--approve às 23:30 BRT de segunda recusa como 'já rodou hoje', não como 'segunda já passou'", () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      const { paths } = setup(false);
      assert.throws(() => approveCircleStackCycle(paths, MONDAY_2330_BRT), /já rodou hoje/, tz);
    }
  });

  it("circleStackBrtDay devolve o dia de São Paulo como meia-noite local", () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      const d = circleStackBrtDay(MONDAY_2330_BRT);
      assert.equal(formatAAMMDD(d), MONDAY, tz);
      assert.equal(d.getDay(), 1, `${tz}: segunda`);
    }
  });
});
