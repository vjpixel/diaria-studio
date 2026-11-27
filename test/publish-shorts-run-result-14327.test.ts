/**
 * #14327: o resultado de cada destino da rodada `--publish` do
 * `publish-shorts.ts` é uma união discriminada por `status`, e o marcador de
 * envio é apagado pelo laço (`settled.marker`), nunca pela etapa.
 *
 * As asserções `@ts-expect-error` só falham no `tsc -p tsconfig.test.json`
 * (job "Typecheck ratchet"): se a união voltar a ser um objeto de opcionais,
 * a diretiva fica sem erro e o typecheck acusa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ShortsRunResult,
  type ShortsRunStatus,
  type ShortsSettledStep,
  linkedInSendCreds,
  shortsResult,
  shortsResultEntry,
} from "../scripts/publish-shorts/send-context.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";

const entry = { destination: "x", status: "published", id: "P1", url: "https://e/P1", scheduled_at: null, at: "2026-11-27T12:00:00Z" } as ShortPublishedEntry;
const buffer = { text: "t", dueAt: null, videoUrl: "https://r2/v.mp4" };

/** O que a skill e os timers fazem com cada status (o `never` trava status novo sem conduta). */
function conduct(r: ShortsRunResult): "done" | "skill" | "mark-not-resend" | "retry" {
  switch (r.status) {
    case "sent":
    case "already":
      return "done";
    case "handoff":
      return "skill";
    case "sent_unrecorded":
      return "mark-not-resend";
    case "failed":
      return "retry";
    default: {
      const unknown: never = r;
      throw new Error(`status sem conduta: ${String(unknown)}`);
    }
  }
}

describe("#14327 ShortsRunResult: união discriminada por status", () => {
  it("o ok sai do status nos construtores", () => {
    const all: ShortsRunResult[] = [
      shortsResult.sent("x", entry),
      shortsResult.already("x", entry),
      shortsResult.handoff("x", buffer),
      shortsResult.sentUnrecorded("x", entry, "registro não gravado"),
      shortsResult.failed("x", "recusado"),
    ];
    assert.deepEqual(
      all.map((r) => [r.status, r.ok]),
      [
        ["sent", true],
        ["already", true],
        ["handoff", true],
        ["sent_unrecorded", false],
        ["failed", false],
      ],
    );
    const statuses: ShortsRunStatus[] = all.map((r) => r.status);
    assert.equal(new Set(statuses).size, 5);
  });

  it("os três pares que antes eram indistinguíveis pelo tipo têm condutas próprias", () => {
    // ok:true pulado × ok:true enviado
    assert.equal(conduct(shortsResult.already("x", entry)), "done");
    assert.equal(shortsResult.already("x", entry).alreadyRegistered, true);
    assert.equal("alreadyRegistered" in shortsResult.sent("x", entry), false);
    // ok:false com entrada (NÃO reenviar) × ok:false sem entrada (pode tentar de novo)
    assert.equal(conduct(shortsResult.sentUnrecorded("x", entry, "e")), "mark-not-resend");
    assert.equal(conduct(shortsResult.failed("x", "e")), "retry");
    // ok:true sem entrada = handoff à Buffer
    assert.equal(conduct(shortsResult.handoff("x", buffer)), "skill");
    assert.equal(shortsResultEntry(shortsResult.handoff("x", buffer)), undefined);
  });

  it("shortsResultEntry devolve a entrada só onde ela existe", () => {
    assert.equal(shortsResultEntry(shortsResult.sent("x", entry)), entry);
    assert.equal(shortsResultEntry(shortsResult.already("x", entry)), entry);
    assert.equal(shortsResultEntry(shortsResult.sentUnrecorded("x", entry, "e")), entry);
    assert.equal(shortsResultEntry(shortsResult.failed("x", "e")), undefined);
  });

  it("o JSON leva status e ok (o ok segue como campo derivado para quem já o lê)", () => {
    const json = JSON.parse(JSON.stringify(shortsResult.sentUnrecorded("threads_profile", entry, "registro não gravado: EBUSY", { cause: "record" })));
    assert.deepEqual(json, { destination: "threads_profile", status: "sent_unrecorded", ok: false, entry, error: "registro não gravado: EBUSY", cause: "record" });
  });

  it("combinações inválidas não compilam", () => {
    // @ts-expect-error sent é sempre ok: true
    const a: ShortsRunResult = { destination: "x", status: "sent", ok: false, entry };
    // @ts-expect-error sent sem entrada
    const b: ShortsRunResult = { destination: "x", status: "sent", ok: true };
    // @ts-expect-error failed não carrega entrada (é sent_unrecorded)
    const c: ShortsRunResult = { destination: "x", status: "failed", ok: false, error: "e", entry };
    // @ts-expect-error handoff sem o buffer
    const d: ShortsRunResult = { destination: "x", status: "handoff", ok: true };
    // @ts-expect-error sent_unrecorded sem o erro
    const e: ShortsRunResult = { destination: "x", status: "sent_unrecorded", ok: false, entry };
    // @ts-expect-error settled sem o marker
    const f: ShortsSettledStep = { kind: "settled", result: shortsResult.failed("x", "e") };
    assert.ok([a, b, c, d, e, f].length === 6);
  });
});

describe("#14327 linkedInSendCreds: ready como as outras credenciais", () => {
  it("converte o ok do readPersonalCreds", () => {
    const creds = { accessToken: "t", personUrn: "urn:li:person:x", expiresAt: null };
    assert.deepEqual(linkedInSendCreds({ ok: true, creds }), { ready: true, creds });
    assert.deepEqual(linkedInSendCreds({ ok: false, reason: "sem token", configured: false }), { ready: false, reason: "sem token" });
  });
});

describe("#14327 marcador de envio: só o laço apaga", () => {
  const ROOT = join(import.meta.dirname, "..");
  const read = (f: string) => readFileSync(join(ROOT, "scripts", "publish-shorts", f), "utf8");

  it("nenhuma etapa de destino recebe nem chama clearSending", () => {
    for (const f of ["threads.ts", "instagram-send.ts", "linkedin.ts", "youtube.ts", "facebook.ts", "buffer.ts", "send-context.ts"]) {
      assert.doesNotMatch(read(f), /clearSending|ShortsSendIo/, `${f} não mexe no marcador`);
    }
  });

  it("o laço apaga o marcador do settled conforme o marker", () => {
    const run = read("run.ts");
    assert.match(run, /if \(step\.marker === "clear"\) clearSending\(\);/);
    assert.doesNotMatch(run, /ShortsSendIo/);
  });
});
