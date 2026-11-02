/**
 * test/shorts-sending-marker-11827.test.ts (#11741, finding P2 da PR #11827)
 *
 * Resíduo de duplicata: o registro do vertical só recebe o destino depois do
 * aceite da plataforma. Se a chamada de `publish-shorts.ts --publish` foi
 * interrompida e o processo seguiu vivo, a releitura logo depois saía
 * `nothing-since` com um destino no meio do envio — e um novo "pode publicar"
 * duplicaria aquele destino. Agora o publisher grava uma marca "envio em
 * curso" antes de publicar, e a releitura trata marca em aberto como "pode ter
 * saído". Nenhum publisher é executado aqui.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeVideoRegistries } from "../scripts/video-publish-registry-status.ts";
import {
  clearShortSending,
  isShortsSendingFileName,
  markShortSending,
  openSendingMarks,
  readShortsSending,
  shortsSendingPath,
} from "../scripts/lib/diaria/shorts-sending-marker.ts";
import { isShortsRegistryFileName, readShortsRegistry } from "../scripts/lib/diaria/shorts-published-store.ts";

const ROOT = join(import.meta.dirname, "..");
const AAMMDD = "261030";
const since = "2026-10-30T13:43:00.000Z";
const none = { ok: true as const, value: { kind: "none" as const } };
const shorts = (entries: Array<{ destination: string; at: string }>) => ({
  ok: true as const,
  value: { aammdd: AAMMDD, entries: entries.map((e) => ({ id: "x", status: "published" as const, ...e })) },
});

describe("#11827 P2: envio em curso não vira nothing-since", () => {
  it("regressão: destino marcado depois do corte e ainda sem registro → registered-since", () => {
    const s = summarizeVideoRegistries({
      aammdd: AAMMDD,
      since,
      youtube: none,
      shorts: shorts([]),
      sending: { ok: true, value: [{ destination: "facebook:diaria", started_at: "2026-10-30T13:43:05.000Z", pid: 4242 }] },
    });
    assert.equal(s.verdict, "registered-since");
    assert.deepEqual(s.registered_since, ["facebook:diaria"]);
    assert.equal(s.sending.kind, "ok");
    assert.deepEqual(s.sending.kind === "ok" ? s.sending.marks.map((m) => m.destination) : null, ["facebook:diaria"]);
    assert.match(s.message, /pode estar saindo agora/);
  });
  it("marca anterior ao corte (processo morto no meio) também conta", () => {
    const s = summarizeVideoRegistries({
      aammdd: AAMMDD,
      since,
      youtube: none,
      shorts: shorts([]),
      sending: { ok: true, value: [{ destination: "instagram", started_at: "2026-10-30T10:00:00.000Z" }] },
    });
    assert.equal(s.verdict, "registered-since");
    assert.deepEqual(s.registered_since, ["instagram"]);
  });
  it("marca fechada por entrada posterior no registro não conta duas vezes nem fica em aberto", () => {
    const s = summarizeVideoRegistries({
      aammdd: AAMMDD,
      since,
      youtube: none,
      shorts: shorts([{ destination: "facebook:diaria", at: "2026-10-30T13:44:00.000Z" }]),
      sending: { ok: true, value: [{ destination: "facebook:diaria", started_at: "2026-10-30T13:43:05.000Z" }] },
    });
    assert.deepEqual(s.registered_since, ["facebook:diaria"]);
    assert.deepEqual(s.sending.kind === "ok" ? s.sending.marks : null, []);
  });
  it("entrada antiga (rodada anterior) não fecha uma marca mais nova", () => {
    assert.deepEqual(
      openSendingMarks(
        [{ destination: "x", started_at: "2026-10-30T13:43:05.000Z" }],
        [{ destination: "x", id: "1", status: "published", at: "2026-10-29T12:00:00.000Z" }],
      ).map((m) => m.destination),
      ["x"],
    );
  });
  it("sem marca e sem registro → nothing-since (comportamento anterior preservado)", () => {
    const s = summarizeVideoRegistries({ aammdd: AAMMDD, since, youtube: none, shorts: shorts([]), sending: { ok: true, value: [] } });
    assert.equal(s.verdict, "nothing-since");
  });
  it("arquivo de marcas ilegível → unreadable", () => {
    const s = summarizeVideoRegistries({ aammdd: AAMMDD, since, youtube: none, shorts: shorts([]), sending: { ok: false, error: "json" } });
    assert.equal(s.verdict, "unreadable");
  });
});

describe("#11827 P2: arquivo de marcas", () => {
  it("marca, une escritores e cópias de conflito, apaga e remove o arquivo vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "sending-11827-"));
    try {
      markShortSending(dir, AAMMDD, "main", { destination: "facebook:diaria", started_at: "2026-10-30T13:43:05.000Z" });
      markShortSending(dir, AAMMDD, "main", { destination: "instagram", started_at: "2026-10-30T13:43:06.000Z" });
      markShortSending(dir, AAMMDD, "linkedin-timer", { destination: "linkedin_profile", started_at: "2026-10-30T13:43:07.000Z" });
      writeFileSync(
        join(dir, "_internal", "06-shorts-sending-Neo.json"),
        JSON.stringify({ aammdd: AAMMDD, marks: [{ destination: "threads_profile", started_at: "2026-10-30T13:43:08.000Z" }] }),
      );
      assert.deepEqual(readShortsSending(dir, AAMMDD).map((m) => m.destination).sort(), ["facebook:diaria", "instagram", "linkedin_profile", "threads_profile"]);
      clearShortSending(dir, AAMMDD, "main", "facebook:diaria");
      clearShortSending(dir, AAMMDD, "main", "instagram");
      assert.equal(existsSync(shortsSendingPath(dir, "main")), false);
      assert.equal(existsSync(shortsSendingPath(dir, "linkedin-timer")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("arquivo de marcas não é lido como registro do vertical (nem o contrário)", () => {
    assert.equal(isShortsRegistryFileName("06-shorts-sending.json"), false);
    assert.equal(isShortsSendingFileName("06-shorts-published.json"), false);
    const dir = mkdtempSync(join(tmpdir(), "sending-11827-"));
    try {
      markShortSending(dir, AAMMDD, "main", { destination: "instagram", started_at: "2026-10-30T13:43:05.000Z" });
      assert.deepEqual(readShortsRegistry(dir, AAMMDD).entries, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("marca de outra edição é recusada (nunca vira 'nada em curso')", () => {
    const dir = mkdtempSync(join(tmpdir(), "sending-11827-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(join(dir, "_internal", "06-shorts-sending.json"), JSON.stringify({ aammdd: "261029", marks: [] }));
      assert.throws(() => readShortsSending(dir, AAMMDD), /é da edição 261029/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("CLI de releitura acusa a marca em aberto (só leitura)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sending-11827-"));
    try {
      markShortSending(dir, AAMMDD, "main", { destination: "facebook:diaria", started_at: "2026-10-30T13:43:05.000Z" });
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(ROOT, "scripts", "video-publish-registry-status.ts"), AAMMDD, "--edition-dir", dir, "--since", since],
        { encoding: "utf8", cwd: ROOT },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.verdict, "registered-since");
      assert.deepEqual(out.registered_since, ["facebook:diaria"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11827 P2: publish-shorts grava a marca antes de publicar", () => {
  const src = readFileSync(join(ROOT, "scripts", "publish-shorts.ts"), "utf8");
  it("marca antes da 1ª chamada de publicação do loop e apaga na recusa", () => {
    const mark = src.indexOf("markShortSending(dir, aammdd, writer");
    const firstPublish = src.indexOf("outcome = await enqueueInstagramReel(");
    assert.ok(mark > 0 && firstPublish > mark, "markShortSending precisa vir antes do envio");
    assert.match(src, /\} catch \(e\) \{\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*clearSending\(\);/);
  });
  it("persist que falhou depois do aceite NÃO apaga a marca", () => {
    assert.match(src, /continue; \/\/ marca de envio fica: a plataforma aceitou e o registro não diz\n\s*\}\n\s*clearSending\(\);/);
  });
});
