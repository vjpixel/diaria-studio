import { test } from "node:test";
import assert from "node:assert/strict";
import { checkListCapacity, listCapacityAlarm } from "../scripts/clarice-check-list-capacity.ts";
import { classifyBrevoError, formatBrevoApiError } from "../scripts/lib/brevo-error-classify.ts";

test("#13966: limiar inclusivo 270, inclusive teto e acima", () => {
  for (const count of [0, 1, 269]) assert.equal(listCapacityAlarm(count), null);
  for (const count of [270, 280, 299, 300, 301]) {
    assert.match(listCapacityAlarm(count)!, /clarice-consolidate-lists\.ts/);
  }
  for (const count of [undefined, null, "270", -1, 1.5, NaN, Infinity]) {
    assert.throws(() => listCapacityAlarm(count), /count válido/);
  }
});

test("usa total da conta e falha antes de escrita, sem precisar paginar", async () => {
  const paths: string[] = [];
  await assert.rejects(checkListCapacity(async (path) => {
    paths.push(path);
    return { status: 200, body: { count: 270, lists: [{ id: 1 }] } };
  }), /270\/300.*clarice-consolidate-lists/);
  assert.deepEqual(paths, ["/contacts/lists?limit=1&offset=0"]);
  await checkListCapacity(async () => ({ status: 200, body: { count: 269 } }));
  await assert.rejects(checkListCapacity(async () => ({ status: 404, body: {} })), /HTTP 404/);
  await assert.rejects(checkListCapacity(async () => ({ status: 200, body: {} })), /count válido/);
  await assert.rejects(checkListCapacity(async () => { throw new Error("offline"); }), /offline/);
});

test("405 real nomeia consolidação, preserva corpo e não confunde outros 405", () => {
  const body = '{"code":"method_not_allowed","message":"You have reached your list creation limit"}';
  assert.equal(classifyBrevoError(405, body).errorClass, "list-capacity");
  const message = formatBrevoApiError("POST", "/contacts/lists", 405, body);
  assert.ok(message.includes(body));
  assert.match(message, /AÇÃO:.*clarice-consolidate-lists\.ts.*--apply/);
  assert.equal(classifyBrevoError(405, "Method not allowed").errorClass, "desconhecido");
});
