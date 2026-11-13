/**
 * #12998/#12999: corte avulso reagendado (a data do `corte.json` mudou depois
 * do envio) deixava o registro do vertical com o `aammdd` da data anterior, e o
 * timer do corte (`Diaria-Shorts-Cortes`) caía em `crash` a cada hora:
 * "06-shorts-published.json: é da edição 261114, não de 261113". No corte a
 * identidade do registro é a pasta (o slug); a data é um campo do plano.
 * Regressão: com a data trocada, o timer, os leitores do registro e das marcas
 * de envio seguem lendo, a próxima gravação realinha o arquivo, e a pasta de
 * EDIÇÃO continua recusando o registro de outra edição. Sem rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCorteTimerRun } from "../scripts/shorts-corte-timer.ts";
import { CORTE_SPEC_FILE, isCorteDir, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { parseShortsPublishedFile, type ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import { persistShortEntry, readShortsRegistry } from "../scripts/lib/diaria/shorts-published-store.ts";
import { clearShortSendingAll, markShortSending, readShortsSending } from "../scripts/lib/diaria/shorts-sending-marker.ts";

const OLD = "261114";
const NEW = "261113";
const SLUG = "automacao-261111";
const TIMER_DESTS = ["linkedin_profile", "threads_profile", "instagram"];
const CONFIG = {
  publishing: {
    shorts: {
      facebook_pages: ["diaria"],
      instagram: true,
      linkedin_profile: true,
      linkedin_page_repost: false,
      x: false,
      threads_profile: true,
      linkedin_profile_via_timer: true,
      threads_profile_via_timer: true,
      instagram_backend: "timer-300",
      instagram_api_max_seconds_by_account: { diaria: null },
      corte_via_timer: true,
    },
  },
};
const SPEC: CorteSpec = {
  slug: SLUG,
  date: NEW,
  hhmm: "18:00",
  title: "Como a IA aprende a fazer o seu trabalho",
  hook: "O que é uma automação feita com IA?",
  video: `corte-${SLUG}.mp4`,
  publish_confirmed_at: "2026-11-12T22:38:27.410Z",
  publish_confirmed_destinations: TIMER_DESTS,
};
const entry = (destination: string): ShortPublishedEntry => ({ destination, status: "scheduled", id: `id-${destination}`, at: "2026-11-12T22:40:45.661Z" });
/** O registro como ficou no 300: entradas reagendadas, `aammdd` da data anterior. */
const staleRegistry = (entries: ShortPublishedEntry[]) => JSON.stringify({ aammdd: OLD, entries }, null, 2);

function corteDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "corte-12998-")), SLUG);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, CORTE_SPEC_FILE), JSON.stringify(SPEC, null, 2));
  return dir;
}

describe("corte reagendado: registro com a data anterior (#12998, #12999)", () => {
  it("o timer decide em vez de lançar, e o destino já registrado conta como feito", () => {
    const now = new Date("2026-11-13T21:30:00.000Z"); // 18:30 BRT de 261113
    const decision = decideCorteTimerRun({
      config: CONFIG,
      spec: SPEC,
      registryRaws: [{ path: "06-shorts-published.json", raw: staleRegistry([entry("instagram")]) }],
      now,
    });
    assert.equal(decision.kind, "publish");
    assert.deepEqual(decision.kind === "publish" ? decision.pending : null, ["linkedin_profile", "threads_profile"]);
  });

  it("registro ilegível no corte continua lançando (nunca vira 'nada publicado')", () => {
    assert.throws(() => parseShortsPublishedFile("{", NEW, "x.json", { corte: true }), /JSON inválido/);
    assert.throws(() => parseShortsPublishedFile(JSON.stringify({ entries: [] }), NEW, "x.json", { corte: true }), /aammdd/);
  });

  it("leitura, marcas e gravação na pasta do corte; a gravação realinha a data", () => {
    const dir = corteDir();
    assert.equal(isCorteDir(dir), true);
    const path = join(dir, "_internal", "06-shorts-published.json");
    writeFileSync(path, staleRegistry([entry("youtube_shorts")]));
    writeFileSync(join(dir, "_internal", "06-shorts-sending.json"), JSON.stringify({ aammdd: OLD, marks: [{ destination: "x", started_at: "2026-11-12T22:43:00.000Z" }] }));

    assert.deepEqual(readShortsRegistry(dir, NEW).entries.map((e) => e.destination), ["youtube_shorts"]);
    assert.deepEqual(readShortsSending(dir, NEW).map((m) => m.destination), ["x"]);
    markShortSending(dir, NEW, "main", { destination: "instagram", started_at: "2026-11-13T21:00:00.000Z" });
    assert.equal(clearShortSendingAll(dir, NEW, "x"), 1);

    const merged = persistShortEntry(dir, NEW, "main", entry("instagram"));
    assert.deepEqual(merged.entries.map((e) => e.destination).sort(), ["instagram", "youtube_shorts"]);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).aammdd, NEW);
  });

  it("a pasta de EDIÇÃO segue recusando o registro de outra edição", () => {
    const dir = mkdtempSync(join(tmpdir(), "edicao-12998-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "06-shorts-published.json"), staleRegistry([entry("youtube_shorts")]));
    assert.equal(isCorteDir(dir), false);
    assert.throws(() => readShortsRegistry(dir, NEW), /é da edição 261114, não de 261113/);
    assert.throws(() => persistShortEntry(dir, NEW, "main", entry("instagram")), /é da edição 261114/);
    writeFileSync(join(dir, "_internal", "06-shorts-sending.json"), JSON.stringify({ aammdd: OLD, marks: [] }));
    assert.throws(() => readShortsSending(dir, NEW), /é da edição 261114/);
  });
});
