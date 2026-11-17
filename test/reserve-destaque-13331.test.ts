/**
 * test/reserve-destaque-13331.test.ts (#13331)
 *
 * No gate 4 da 261117 o editor pediu que o D2 ("Brasil vai precisar de
 * licença dos EUA para chips") fosse o D1 da 261118, e não havia comando para
 * isso. `reserve-destaque.ts` copia o pacote para a edição de destino (que
 * ainda não existe) e grava a reserva; o Stage 1 do destino
 * (`inject-inbox-urls.ts`) injeta o link no pool com `editor_destaque_request`,
 * e o invariante `editor-destaque-request` avisa se ele não sair como D1.
 *
 * Tudo roda em tmpdir: nunca contra `data/editions` real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { reserveDestaque } from "../scripts/reserve-destaque.ts";
import {
  RESERVED_DESTAQUES_FILE,
  extractRawDestaqueBlock,
  extractSocialPackage,
  isDestaqueAssetName,
  mergeReservationsIntoInjected,
  parseDestaqueSlot,
  readReservedDestaques,
  type ReservedDestaque,
} from "../scripts/lib/reserved-destaques.ts";
import { DESTAQUE_REQUEST_FIELD } from "../scripts/lib/destaque-upgrade.ts";
import { checkEditorDestaqueRequests } from "../scripts/lib/invariant-checks/stage-4.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CHIPS = "https://www.reuters.com/technology/brasil-licenca-eua-chips-2026-11-16";
const D1_URL = "https://example.com/d1-original";
const D3_URL = "https://example.com/d3-original";

const REVIEWED = [
  "DESTAQUE 1 | MERCADO",
  "Título do D1",
  D1_URL,
  "",
  "Corpo do D1.",
  "",
  "Por que isso importa:",
  "Motivo do D1.",
  "",
  "---",
  "DESTAQUE 2 | BRASIL",
  "Brasil vai precisar de licença dos EUA para chips",
  CHIPS,
  "",
  "Corpo do D2 sobre chips.",
  "",
  "Por que isso importa:",
  "Motivo do D2.",
  "",
  "---",
  "DESTAQUE 3 | PESQUISA",
  "Título do D3",
  D3_URL,
  "",
  "Corpo do D3.",
  "",
  "Por que isso importa:",
  "Motivo do D3.",
  "",
].join("\n");

const SOCIAL = [
  "# Social",
  "",
  "## d1",
  "Legenda d1.",
  "",
  "## d2",
  "Legenda d2 chips.",
  "",
  "## d2-cards",
  "Card 1.",
  "",
  "Card 2.",
  "",
  "## d3",
  "Legenda d3.",
  "",
  "# Curto",
  "",
  "## d2",
  "Curto d2 chips.",
  "",
].join("\n");

let root: string;
let editions: string;
let srcDir: string;

function writeSource(): void {
  srcDir = join(editions, "2611", "261117");
  mkdirSync(join(srcDir, "_internal"), { recursive: true });
  writeFileSync(join(srcDir, "02-reviewed.md"), REVIEWED);
  writeFileSync(join(srcDir, "03-social.md"), SOCIAL);
  writeFileSync(
    join(srcDir, "_internal", "01-approved.json"),
    JSON.stringify({
      highlights: [
        { url: D1_URL, title: "Título do D1" },
        { url: CHIPS, title: "Brasil vai precisar de licença dos EUA para chips", sources: ["https://g1.globo.com/chips"] },
        { url: D3_URL, title: "Título do D3" },
      ],
    }),
  );
  writeFileSync(join(srcDir, "04-d2-2x1.jpg"), "img-2x1");
  writeFileSync(join(srcDir, "04-d2-4x5.jpg"), "img-4x5");
  writeFileSync(join(srcDir, "04-d1-2x1.jpg"), "img-d1");
  writeFileSync(join(srcDir, "_internal", "04-d2-sd-prompt.json"), "{}");
}

const NOW = () => new Date("2026-11-17T01:00:00.000Z");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reserve-destaque-13331-"));
  editions = join(root, "data", "editions");
  writeSource();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("#13331 reserveDestaque", () => {
  it("pasta de destino inexistente: cria, copia o pacote e grava a reserva", () => {
    const target = join(editions, "2611", "261118");
    assert.equal(existsSync(target), false, "pré-condição: destino não existe");

    const r = reserveDestaque({ from: "261117", dest: "d2", to: "261118", position: "d1", editionsRootDir: editions, now: NOW });

    assert.equal(r.target_created, true);
    assert.equal(r.target_dir, target, "layout nested para edição nova");
    const pkg = join(target, "_internal", "reserved-destaques", "261117-d2");
    assert.match(readFileSync(join(pkg, "destaque.md"), "utf8"), /^DESTAQUE 2 \| BRASIL\nBrasil vai precisar/);
    assert.doesNotMatch(readFileSync(join(pkg, "destaque.md"), "utf8"), /DESTAQUE 3/);
    assert.equal(JSON.parse(readFileSync(join(pkg, "destaque.json"), "utf8")).url, CHIPS);
    assert.deepEqual(JSON.parse(readFileSync(join(pkg, "highlight.json"), "utf8")).sources, ["https://g1.globo.com/chips"]);
    const social = readFileSync(join(pkg, "social.md"), "utf8");
    assert.match(social, /# Social[\s\S]*## d2\nLegenda d2 chips\.[\s\S]*## d2-cards\nCard 1\./);
    assert.match(social, /# Curto[\s\S]*## d2\nCurto d2 chips\./);
    assert.doesNotMatch(social, /Legenda d1|Legenda d3/);
    assert.equal(readFileSync(join(pkg, "04-d2-2x1.jpg"), "utf8"), "img-2x1");
    assert.equal(readFileSync(join(pkg, "04-d2-4x5.jpg"), "utf8"), "img-4x5");
    assert.equal(existsSync(join(pkg, "04-d2-sd-prompt.json")), true);
    assert.equal(existsSync(join(pkg, "04-d1-2x1.jpg")), false, "imagem de outro destaque não vai junto");

    const list = readReservedDestaques(join(target, "_internal"));
    assert.equal(list.length, 1);
    assert.equal(list[0].url, CHIPS);
    assert.equal(list[0].request, "d1");
    assert.equal(list[0].from_edition, "261117");
    assert.equal(list[0].from_destaque, "d2");
    assert.equal(list[0].package_dir, "_internal/reserved-destaques/261117-d2");
    assert.equal(list[0].title, "Brasil vai precisar de licença dos EUA para chips");

    assert.equal(readFileSync(join(srcDir, "02-reviewed.md"), "utf8"), REVIEWED, "origem intacta");
  });

  it("--dry-run não escreve nada", () => {
    const r = reserveDestaque({ from: "261117", dest: "d2", to: "261118", position: "d1", editionsRootDir: editions, dryRun: true, now: NOW });
    assert.equal(r.dry_run, true);
    assert.ok(r.package_files.length >= 5);
    assert.equal(existsSync(join(editions, "2611", "261118")), false);
  });

  it("nova reserva do mesmo link substitui a anterior; outro link na mesma posição é recusado", () => {
    reserveDestaque({ from: "261117", dest: "d2", to: "261118", position: "d1", editionsRootDir: editions, now: NOW });
    reserveDestaque({ from: "261117", dest: "d2", to: "261118", position: "d2", editionsRootDir: editions, now: NOW });
    const internal = join(editions, "2611", "261118", "_internal");
    const list = readReservedDestaques(internal);
    assert.equal(list.length, 1);
    assert.equal(list[0].request, "d2");

    assert.throws(
      () => reserveDestaque({ from: "261117", dest: "d3", to: "261118", position: "d2", editionsRootDir: editions, now: NOW }),
      /D2 de 261118 já está reservado/,
    );
    assert.equal(readReservedDestaques(internal).length, 1, "recusa não grava");
  });

  it("recusa origem = destino, origem ausente e destaque ausente", () => {
    assert.throws(() => reserveDestaque({ from: "261117", dest: "d2", to: "261117", position: "d1", editionsRootDir: editions }), /mesma edição/);
    assert.throws(() => reserveDestaque({ from: "261101", dest: "d2", to: "261118", position: "d1", editionsRootDir: editions }), /origem não encontrada/);
    writeFileSync(join(srcDir, "02-reviewed.md"), REVIEWED.split("---\nDESTAQUE 3")[0]);
    writeFileSync(join(srcDir, "_internal", "01-approved.json"), JSON.stringify({ highlights: [{ url: D1_URL }, { url: CHIPS }] }));
    assert.throws(() => reserveDestaque({ from: "261117", dest: "d3", to: "261118", position: "d1", editionsRootDir: editions }), /D3 não encontrado/);
  });

  it("avisa quando o Stage 1 do destino já rodou", () => {
    const internal = join(editions, "2611", "261118", "_internal");
    mkdirSync(internal, { recursive: true });
    writeFileSync(join(internal, "01-approved.json"), "{}");
    const r = reserveDestaque({ from: "261117", dest: "d2", to: "261118", position: "d1", editionsRootDir: editions, now: NOW });
    assert.equal(r.target_created, false);
    assert.ok(r.warnings.some((w) => /Stage 1 de 261118 já rodou/.test(w)));
  });
});

describe("#13331 Stage 1 do destino reconhece a reserva", () => {
  function runInject(target: string, inbox: string): Array<Record<string, unknown>> {
    const internal = join(target, "_internal");
    const inboxPath = join(root, "inbox.md");
    writeFileSync(inboxPath, inbox);
    const out = join(internal, "tmp-articles-raw.json");
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "scripts", "inject-inbox-urls.ts"), "--inbox-md", inboxPath, "--out", out, "--editor", "diariaeditor@gmail.com", "--no-newsletters", "--validate-pool"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).reserved_destaques, 1);
    return JSON.parse(readFileSync(out, "utf8"));
  }

  it("inject-inbox-urls injeta o link com editor_destaque_request e o invariante do gate 4 avisa", () => {
    reserveDestaque({ from: "261117", dest: "d2", to: "261118", position: "d1", editionsRootDir: editions, now: NOW });
    const target = join(editions, "2611", "261118");
    const pool = runInject(target, "# Inbox\n");
    const art = pool.find((a) => a.url === CHIPS);
    assert.ok(art, "reserva entrou no pool");
    assert.equal(art[DESTAQUE_REQUEST_FIELD], "d1");
    assert.equal(art.flag, "editor_submitted");
    assert.equal(art.reserved_from, "261117/d2");

    // Gate 4: saiu como D2 em vez de D1 → aviso.
    const approvedPath = join(target, "_internal", "01-approved.json");
    writeFileSync(approvedPath, JSON.stringify({ highlights: [{ url: "https://example.com/outro" }, { url: CHIPS }] }));
    const v = checkEditorDestaqueRequests(target);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "editor-destaque-request");
    assert.match(v[0].message, /pedido como D1, saiu como D2/);

    // Saiu como D1 → nada.
    writeFileSync(approvedPath, JSON.stringify({ highlights: [{ url: CHIPS }, { url: "https://example.com/outro" }] }));
    assert.deepEqual(checkEditorDestaqueRequests(target), []);
  });

  it("e-mail do inbox com o mesmo link não duplica; a reserva define a posição", () => {
    reserveDestaque({ from: "261117", dest: "d2", to: "261118", position: "d1", editionsRootDir: editions, now: NOW });
    const inbox = [
      "# Inbox",
      "",
      "## 2026-11-17T10:00:00.000Z",
      "- **from:** diariaeditor@gmail.com",
      "- **subject:** esse vale destaque",
      `- ${CHIPS}`,
      "",
    ].join("\n");
    const pool = runInject(join(editions, "2611", "261118"), inbox);
    const hits = pool.filter((a) => a.url === CHIPS);
    assert.equal(hits.length, 1);
    assert.equal(hits[0][DESTAQUE_REQUEST_FIELD], "d1");
  });

  it("reserved-destaques.json ilegível derruba o inject (nunca perde a reserva em silêncio)", () => {
    const internal = join(editions, "2611", "261118", "_internal");
    mkdirSync(internal, { recursive: true });
    writeFileSync(join(internal, RESERVED_DESTAQUES_FILE), "{ quebrado");
    assert.throws(() => readReservedDestaques(internal), /JSON ilegível/);
    writeFileSync(join(internal, RESERVED_DESTAQUES_FILE), JSON.stringify({ reservations: [{ url: CHIPS, request: "d9" }] }));
    assert.throws(() => readReservedDestaques(internal), /sem url\/request válidos/);
    writeFileSync(join(root, "inbox.md"), "# Inbox\n");
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "scripts", "inject-inbox-urls.ts"), "--inbox-md", join(root, "inbox.md"), "--out", join(internal, "tmp-articles-raw.json"), "--editor", "x@y.z", "--no-newsletters"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /sem url\/request válidos/);
    assert.equal(existsSync(join(internal, "tmp-articles-raw.json")), false);
  });
});

describe("#13331 helpers puros", () => {
  it("parseDestaqueSlot", () => {
    assert.equal(parseDestaqueSlot("d2"), "d2");
    assert.equal(parseDestaqueSlot("D3"), "d3");
    assert.equal(parseDestaqueSlot("1"), "d1");
    assert.equal(parseDestaqueSlot("4"), null);
    assert.equal(parseDestaqueSlot(undefined), null);
  });

  it("extractRawDestaqueBlock / extractSocialPackage / isDestaqueAssetName", () => {
    assert.equal(extractRawDestaqueBlock(REVIEWED, 3)?.startsWith("DESTAQUE 3 | PESQUISA"), true);
    assert.equal(extractRawDestaqueBlock("sem destaques", 1), null);
    assert.equal(extractSocialPackage("# Social\n\n## d1\nx\n", "d2"), null);
    assert.equal(isDestaqueAssetName("04-d2-2x1.jpg", "d2"), true);
    assert.equal(isDestaqueAssetName("04-d2.jpg", "d2"), true);
    assert.equal(isDestaqueAssetName("04-d20-x.jpg", "d2"), false);
    assert.equal(isDestaqueAssetName("04-d1-2x1.jpg", "d2"), false);
  });

  it("mergeReservationsIntoInjected anota o artigo do inbox sem mutar a entrada", () => {
    const r: ReservedDestaque = {
      url: CHIPS, title: "t", request: "d1", from_edition: "261117", from_destaque: "d2",
      package_dir: "_internal/reserved-destaques/261117-d2", reserved_at: "2026-11-17T01:00:00.000Z",
    };
    const injected = [{ url: CHIPS, [DESTAQUE_REQUEST_FIELD]: "destaque" }];
    const out = mergeReservationsIntoInjected(injected, [r]);
    assert.equal(out.added, 0);
    assert.equal(out.annotated, 1);
    assert.equal((out.injected[0] as Record<string, unknown>)[DESTAQUE_REQUEST_FIELD], "d1");
    assert.equal(injected[0][DESTAQUE_REQUEST_FIELD], "destaque");
  });
});
