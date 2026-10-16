/**
 * #10348 — regressão (#633): `--update-html` tratava QUALQUER
 * `sendNowAcceptedAt` como "já saiu" e recusava para sempre, enquanto o
 * `--send-now` (`checkSendNowGuard`) libera um novo POST quando o status ao
 * vivo é `draft` e o marcador venceu a janela. O re-disparo saía com o HTML
 * antigo. Agora o `--update-html` aplica a mesma regra (GET ao vivo + guard).
 * Só fakes — nenhuma chamada à Brevo.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGroupCampaigns, runUpdateHtml, type CampaignEntry } from "../scripts/clarice-schedule-group.ts";
import { SEND_NOW_GUARD_WINDOW_MS } from "../scripts/lib/brevo-client.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "clarice-10348-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ACCEPTED = "2026-10-14T12:00:00.000Z";
const base: CampaignEntry = {
  key: "d1-sab03-A",
  campaignId: 31,
  listId: 1,
  subject: "s",
  status: "draft",
  sendNowAcceptedAt: ACCEPTED,
  envioIndex: 1,
  queroIncluded: false,
};
const after1h = () => new Date(Date.parse(ACCEPTED) + SEND_NOW_GUARD_WINDOW_MS + 60_000);
const within = () => new Date(Date.parse(ACCEPTED) + 60_000);

async function run(patch: Partial<CampaignEntry>, live: string, now: () => Date, name: string) {
  const c: CampaignEntry = { ...base, ...patch };
  const campaigns = [c];
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(campaigns, null, 2));
  const puts: number[] = [];
  const gets: number[] = [];
  const logs: string[] = [];
  const r = await runUpdateHtml(c, campaigns, path, "<p>novo</p>", { envioIndex: 2, included: true }, {
    putHtmlFn: async (id) => {
      puts.push(id);
    },
    getCampaignFn: async (id) => {
      gets.push(id);
      return { status: live };
    },
    logFn: (m) => logs.push(m),
    nowFn: now,
  });
  return { r, puts, gets, logs, onDisk: readGroupCampaigns(path)[0] };
}

describe("#10348 --update-html com marcador de sendNow segue o guard do --send-now", () => {
  it("sendNowAcceptedAt vencido + status ao vivo draft: atualiza o HTML (o --send-now liberaria o re-disparo)", async () => {
    const { r, puts, gets, onDisk } = await run({}, "draft", after1h, "expired-draft");
    assert.equal(r, "updated");
    assert.deepEqual(gets, [31]);
    assert.deepEqual(puts, [31]);
    assert.equal(onDisk.envioIndex, 2);
    assert.equal(onDisk.queroIncluded, true);
  });

  it("sendNowAcceptedAt dentro da janela + draft: recusa (envio pode estar em processamento)", async () => {
    const { r, puts, logs, onDisk } = await run({}, "draft", within, "window-draft");
    assert.equal(r, "skipped");
    assert.deepEqual(puts, []);
    assert.equal(onDisk.envioIndex, 1);
    assert.match(logs.join("\n"), /html NÃO atualizado/);
  });

  it("status ao vivo sent: recusa e corrige o registro local pra sent", async () => {
    const { r, puts, onDisk } = await run({}, "sent", after1h, "live-sent");
    assert.equal(r, "skipped");
    assert.deepEqual(puts, []);
    assert.equal(onDisk.status, "sent");
  });

  it("status ao vivo queued: recusa sem PUT", async () => {
    const { r, puts } = await run({}, "queued", after1h, "live-queued");
    assert.equal(r, "skipped");
    assert.deepEqual(puts, []);
  });

  it("só sendNowAttemptedAt recente + draft: recusa (mesma janela do guard, #9699)", async () => {
    const { r, puts } = await run({ sendNowAcceptedAt: undefined, sendNowAttemptedAt: ACCEPTED }, "draft", within, "attempted");
    assert.equal(r, "skipped");
    assert.deepEqual(puts, []);
  });

  it("scheduleAcceptedAt presente: recusa sem consultar a Brevo (está na fila, #10211)", async () => {
    const { r, puts, gets } = await run({ scheduleAcceptedAt: ACCEPTED }, "draft", after1h, "schedule-accepted");
    assert.equal(r, "skipped");
    assert.deepEqual(gets, []);
    assert.deepEqual(puts, []);
  });

  it("draft sem marcador: atualiza sem GET", async () => {
    const { r, puts, gets } = await run({ sendNowAcceptedAt: undefined }, "draft", after1h, "no-mark");
    assert.equal(r, "updated");
    assert.deepEqual(gets, []);
    assert.deepEqual(puts, [31]);
  });
});
