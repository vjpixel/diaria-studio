/**
 * test/video-drive-cleanup-13630.test.ts (#13630, #13632, #13627, #13631)
 *
 * Política pura de `scripts/lib/diaria/video-drive-cleanup.ts` e o executor
 * (`scripts/archive-video-brutos.ts`) contra um Drive FALSO (pasta local +
 * `rclone` em sh). Nunca toca o remote real. Os testes do executor pedem
 * /bin/sh e ficam fora no Windows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decideFolder } from "../scripts/lib/diaria/video-bruto-archive.ts";
import {
  brutoOwnerEdition,
  buildRenameMap,
  decideFinalsFolder,
  isFinalOrPreviewFile,
  isFolderRecordFile,
  parseOrigemBrutosRename,
  parseVideoLiberada,
  pendingAgendamentosOf,
  planCrossFolderDuplicates,
  referencedNamesOfXmls,
  type FolderFile,
} from "../scripts/lib/diaria/video-drive-cleanup.ts";
import { ARCHIVE_REGISTRY_FILE, defaultConfig, notDeletedFinding, reportFailed, runArchive, type ArchiveReport } from "../scripts/archive-video-brutos.ts";
import { checkLiberada, writeLiberada } from "../scripts/mark-video-liberada.ts";
import { DEFAULT_SHORTS_CONFIG } from "../scripts/lib/diaria/short-video.ts";

const TODAY = new Date("2026-11-19T00:00:00Z");
const MD5_A = "a".repeat(32);
const MD5_B = "b".repeat(32);

// ── #13632: edição renomeada ─────────────────────────────────────────────────

describe("renomeação de edição (#13632)", () => {
  it("lê o renomeada do _origem-brutos.json e recusa o resto", () => {
    assert.deepEqual(parseOrigemBrutosRename({ renomeada: { de: "261109", para: "261110", motivo: "editor" } }), { de: "261109", para: "261110" });
    assert.equal(parseOrigemBrutosRename({ renomeada: { de: "261109", para: "261109" } }), null);
    assert.equal(parseOrigemBrutosRename({ renomeada: { de: "26110", para: "261110" } }), null);
    assert.equal(parseOrigemBrutosRename({ brutos: [] }), null);
    assert.equal(parseOrigemBrutosRename(null), null);
  });

  it("só vale o registro gravado na pasta de destino; destinos conflitantes se anulam", () => {
    const ok = buildRenameMap([{ folder: "261110", raw: { renomeada: { de: "261109", para: "261110" } } }]);
    assert.deepEqual([...ok.map], [["261109", "261110"]]);
    const copied = buildRenameMap([{ folder: "261111", raw: { renomeada: { de: "261109", para: "261110" } } }]);
    assert.equal(copied.map.size, 0);
    assert.equal(copied.warnings.length, 1);
    const clash = buildRenameMap([
      { folder: "261110", raw: { renomeada: { de: "261109", para: "261110" } } },
      { folder: "261112", raw: { renomeada: { de: "261109", para: "261112" } } },
    ]);
    assert.equal(clash.map.size, 0);
    assert.match(clash.warnings.join(" "), /destinos diferentes/);
  });

  it("regressão: pasta sem edição em data/editions e com _origem-brutos.json renomeado resolve para a edição nova", () => {
    // Antes: 261109 ficava "publicação desconhecida" para sempre (até o teto de 14 dias).
    const before = decideFolder({ name: "261109", published: { "261109": null } }, TODAY);
    assert.equal(before.eligible, false);
    assert.equal(before.reason, "publicacao-desconhecida");
    const after = decideFolder({ name: "261109", published: { "261110": true }, renamedTo: { "261109": "261110" } }, TODAY);
    assert.equal(after.eligible, true);
    assert.equal(after.reason, "publicado");
    assert.equal(after.ageDays, 9, "idade da edição nova, não da antiga");
    assert.deepEqual(after.renamedTo, { "261109": "261110" });
  });
});

// ── #13630: finais ──────────────────────────────────────────────────────────

describe("finais, prévias e editados (#13630)", () => {
  it("pega Final/, Editado(s)/ e prévias (inclusive em arquivo/), nunca bruto nem asset", () => {
    for (const p of ["Final/Diaria_V3.mp4", "Final/legenda.srt", "Editado/x.mp4", "Editados/x_V2-guia.mp4", "261110 - previa youtube.mp4", "arquivo/261110 - previa vertical.mp4", "arquivo/Final/old.mp4"]) {
      assert.equal(isFinalOrPreviewFile(p), true, p);
    }
    for (const p of ["20261109_150417.mp4", "Brutos/20261109_150417.mp4", "261110_audio_tratado-81a61a72.wav", "Diaria comentada_Youtube_V1.xml", "roteiro.md", "Projeto/x.prproj", "261110 - previa.srt"]) {
      assert.equal(isFinalOrPreviewFile(p), false, p);
    }
  });

  it("marcador só vale para a edição certa e com data", () => {
    assert.equal(parseVideoLiberada({ aammdd: "261110", liberada_at: "2026-11-11T02:00:00Z" }, "261110"), true);
    assert.equal(parseVideoLiberada({ aammdd: "261111", liberada_at: "2026-11-11T02:00:00Z" }, "261110"), false);
    assert.equal(parseVideoLiberada({ aammdd: "261110" }, "261110"), false);
  });

  it("agendamento ainda não enviado segura os finais; agendado/publicado não", () => {
    const itens = [
      { id: "261110-vertical-2", edicao: "261110", estado: "pendente" },
      { id: "261110-corte-x", edicao: "261110", estado: "agendado" },
      { id: "261111-vertical-2", edicao: "261111", estado: "publicado" },
    ];
    assert.deepEqual(pendingAgendamentosOf(itens, "261110"), ["261110-vertical-2 (pendente)"]);
    assert.deepEqual(pendingAgendamentosOf(itens, "261111"), []);
    const held = decideFinalsFolder({ name: "261110", liberada: { "261110": true }, pending: { "261110": ["261110-vertical-2 (pendente)"] } });
    assert.equal(held.eligible, false);
    assert.equal(!held.eligible && held.reason, "agendamento-pendente");
    assert.equal(decideFinalsFolder({ name: "261110", liberada: { "261110": true }, pending: { "261110": [] } }).eligible, true);
    assert.equal(decideFinalsFolder({ name: "261110", liberada: {}, pending: {} }).eligible, false);
    const unreadable = decideFinalsFolder({ name: "261110", liberada: { "261110": true }, pending: null });
    assert.equal(!unreadable.eligible && unreadable.reason, "agendamentos-ilegiveis");
    // pasta antiga de edição renomeada segue a liberação da nova
    assert.equal(decideFinalsFolder({ name: "261109", liberada: { "261110": true }, pending: {}, renamedTo: { "261109": "261110" } }).eligible, true);
  });
});

// ── #13627: duplicatas ──────────────────────────────────────────────────────

describe("duplicatas entre pastas (#13627)", () => {
  it("dona do bruto é a data do nome + 1 dia", () => {
    assert.equal(brutoOwnerEdition("20261109_150417.mp4"), "261110");
    assert.equal(brutoOwnerEdition("Brutos/PXL_20261231_235959123.mp4"), "270101");
    assert.equal(brutoOwnerEdition("20261332_000000.mp4"), null);
    assert.equal(brutoOwnerEdition("261110_audio.wav"), null);
  });

  const f = (folder: string, path: string, size: number, md5: string | null): FolderFile => ({ folder, path, size, md5 });

  it("cenário da issue: copiado e renomeado sai a cópia da pasta mais nova; referenciado por XML da própria pasta fica", () => {
    const files = [
      f("261109", "261109_audio_tratado-81a61a72.wav", 121, MD5_A),
      f("261110", "261110_audio_tratado-81a61a72.wav", 121, MD5_A),
      f("261109", "261109_cta_card_vertical.png", 102, MD5_B),
      f("261111", "261110_cta_card_vertical.png", 102, MD5_B),
      // mesmo tamanho, md5 diferente: nunca duplicata
      f("261109", "a.wav", 50, "c".repeat(32)),
      f("261110", "b.wav", 50, "d".repeat(32)),
      // 0 byte e sem md5 ficam fora
      f("261109", "vazio.mp4", 0, MD5_A),
      f("261110", "vazio.mp4", 0, MD5_A),
      f("261109", "sem.mp4", 9, null),
      f("261110", "sem.mp4", 9, null),
    ];
    const groups = planCrossFolderDuplicates(files, {
      removableFolders: new Set(["261109", "261110", "261111"]),
      referencedByFolder: new Map([
        ["261110", new Set<string>()],
        ["261111", new Set(["261110_cta_card_vertical.png"])],
      ]),
    });
    assert.equal(groups.length, 2);
    const wav = groups.find((g) => g.md5 === MD5_A)!;
    assert.deepEqual(wav.keep.map((x) => `${x.folder}/${x.path}`), ["261109/261109_audio_tratado-81a61a72.wav"]);
    assert.deepEqual(wav.remove.map((x) => `${x.folder}/${x.path}`), ["261110/261110_audio_tratado-81a61a72.wav"]);
    const cta = groups.find((g) => g.md5 === MD5_B)!;
    assert.deepEqual(cta.remove, []);
    assert.deepEqual(cta.held.map((x) => x.reason), ["referenciado-por-xml-da-pasta"]);
  });

  it("bruto fica na pasta da edição gravada, não na mais antiga", () => {
    const files = [f("261110", "20261109_161118.mp4", 5, MD5_A), f("261111", "20261109_161118.mp4", 5, MD5_A), f("261109", "20261109_161118.mp4", 5, MD5_A)];
    const [g] = planCrossFolderDuplicates(files, {
      removableFolders: new Set(["261109", "261110", "261111"]),
      referencedByFolder: new Map([["261109", new Set()], ["261111", new Set()]]),
    });
    assert.deepEqual(g.keep.map((x) => x.folder), ["261110"]);
    assert.deepEqual(g.remove.map((x) => x.folder), ["261109", "261111"]);
  });

  it("nunca sai: XML da raiz, pasta ainda não liberada, XMLs ilegíveis, nome em uso pela montagem", () => {
    const files = [
      f("261109", "x.xml", 7, MD5_A),
      f("261110", "x.xml", 7, MD5_A),
      f("261109", "y.png", 8, MD5_B),
      f("261115", "y.png", 8, MD5_B),
      f("261110", "y.png", 8, MD5_B),
      f("261109", "z.png", 3, "e".repeat(32)),
      f("261110", "z.png", 3, "e".repeat(32)),
    ];
    const groups = planCrossFolderDuplicates(files, {
      removableFolders: new Set(["261109", "261110"]),
      referencedByFolder: new Map([["261110", null]]),
      inUseKeys: new Set(["z.png"]),
    });
    const reasons = groups.flatMap((g) => g.held.map((h) => `${h.folder}/${h.path}:${h.reason}`)).sort();
    assert.deepEqual(reasons, [
      "261110/x.xml:xml-atual-da-pasta",
      "261110/y.png:xmls-da-pasta-ilegiveis",
      "261110/z.png:em-uso-pela-montagem",
      "261115/y.png:pasta-ainda-nao-liberada",
    ]);
    assert.equal(groups.every((g) => g.remove.length === 0), true);
  });

  // #13748: interação entre a regra de duplicatas (#13627), a guarda dos finais (#13630) e a renomeação (#13632).
  it("regressão #13748: duplicata em Final/ não sai enquanto a pasta não tem os finais liberados", () => {
    const files = [
      f("261109", "Final/Diaria_V2-guia.mp4", 40, MD5_A),
      f("261110", "Final/Diaria_V2-guia.mp4", 40, MD5_A),
      f("261109", "261110 - previa vertical.mp4", 30, MD5_B),
      f("261110", "261110 - previa vertical.mp4", 30, MD5_B),
    ];
    const refs = new Map([["261109", new Set<string>()], ["261110", new Set<string>()]]);
    // 261110: brutos elegíveis (4 dias), mas o vertical 2 do D+7 ainda pendente no banco.
    const held = planCrossFolderDuplicates(files, { removableFolders: new Set(["261109", "261110"]), finalsRemovableFolders: new Set(), referencedByFolder: refs });
    assert.equal(held.every((g) => g.remove.length === 0), true);
    assert.deepEqual(held.flatMap((g) => g.held.map((h) => h.reason)), ["finais-ainda-nao-liberados", "finais-ainda-nao-liberados"]);
    // sem a opção (chamador antigo): também não sai nada
    const legacy = planCrossFolderDuplicates(files, { removableFolders: new Set(["261109", "261110"]), referencedByFolder: refs });
    assert.equal(legacy.every((g) => g.remove.length === 0), true);
    // liberada e sem agendamento pendente: sai
    const freed = planCrossFolderDuplicates(files, { removableFolders: new Set(["261109", "261110"]), finalsRemovableFolders: new Set(["261110"]), referencedByFolder: refs });
    assert.deepEqual(freed.flatMap((g) => g.remove.map((x) => `${x.folder}/${x.path}`)).sort(), ["261110/261110 - previa vertical.mp4", "261110/Final/Diaria_V2-guia.mp4"]);
  });

  it("regressão #13748: _origem-brutos.json idêntico em duas pastas nunca é duplicata", () => {
    const files = [
      f("261109", "_origem-brutos.json", 64, MD5_A),
      f("261110", "_origem-brutos.json", 64, MD5_A),
      f("261109", "_outro-registro.json", 10, MD5_B),
      f("261110", "_outro-registro.json", 10, MD5_B),
    ];
    const groups = planCrossFolderDuplicates(files, {
      removableFolders: new Set(["261109", "261110"]),
      finalsRemovableFolders: new Set(["261109", "261110"]),
      referencedByFolder: new Map([["261109", new Set<string>()], ["261110", new Set<string>()]]),
    });
    assert.deepEqual(groups, []);
    assert.equal(isFolderRecordFile("_origem-brutos.json"), true);
    assert.equal(isFolderRecordFile("arquivo/_origem-brutos.json"), false);
    assert.equal(isFolderRecordFile("origem.json"), false);
  });

  it("regressão #13748: a pasta que fica segue a renomeação (fica a nova, sai a antiga)", () => {
    const files = [
      f("261109", "261110_cta_card_vertical.png", 12, MD5_A),
      f("261110", "261110_cta_card_vertical.png", 12, MD5_A),
      // bruto gravado em 08/11 (dono 261109), edição renomeada para 261110
      f("261109", "20261108_101010.mp4", 99, MD5_B),
      f("261110", "20261108_101010.mp4", 99, MD5_B),
    ];
    const groups = planCrossFolderDuplicates(files, {
      removableFolders: new Set(["261109", "261110"]),
      referencedByFolder: new Map([["261109", new Set<string>()], ["261110", new Set<string>()]]),
      renamedTo: { "261109": "261110" },
    });
    for (const g of groups) {
      assert.deepEqual(g.keep.map((x) => x.folder), ["261110"], g.md5);
      assert.deepEqual(g.remove.map((x) => x.folder), ["261109"], g.md5);
    }
    assert.equal(groups.length, 2);
    // a pasta de destino fora do grupo não muda nada: fica a mais antiga, como antes
    const solo = planCrossFolderDuplicates([f("261109", "a.png", 5, MD5_A), f("261111", "a.png", 5, MD5_A)], {
      removableFolders: new Set(["261109", "261111"]),
      referencedByFolder: new Map([["261111", new Set<string>()]]),
      renamedTo: { "261109": "261110" },
    });
    assert.deepEqual(solo[0].keep.map((x) => x.folder), ["261109"]);
  });

  it("referencedNamesOfXmls: XML não lido anula; XML sem pathurl não anula", () => {
    assert.equal(referencedNamesOfXmls(["<xmeml/>", null]), null);
    assert.deepEqual([...(referencedNamesOfXmls(["<pathurl>file://localhost/G:/v/261110/a%20b.png</pathurl>", "<xmeml/>"]) ?? [])], ["a b.png"]);
  });
});

// ── executor contra um Drive falso ──────────────────────────────────────────

function sandbox(opts: { lockedTrash?: string; lockedMove?: boolean; dupPath?: string } = {}) {
  const sb = mkdtempSync(join(tmpdir(), "video-cleanup-"));
  const mount = join(sb, "hd");
  const drive = join(sb, "drive");
  const archive = join(mount, "arquivo-video");
  const data = join(sb, "data");
  const bin = join(sb, "bin");
  for (const d of [drive, archive, bin, join(data, "editions")]) mkdirSync(d, { recursive: true });
  const calls = join(sb, "calls.log");
  writeFileSync(
    join(bin, "rclone"),
    `#!/bin/sh
echo "rclone $*" >> "${calls}"
cmd="$1"; shift
strip() { echo "$1" | sed "s|^remote:|${drive}/|"; }
last() { for a in "$@"; do p="$a"; done; echo "$p"; }
case "$cmd" in
  about) echo '{"total":100,"free":50}' ;;
  cat) cat "$(strip "$(last "$@")")" ;;
  lsjson)
    p="$(last "$@")"
    case " $* " in *" --dirs-only "*)
      node -e 'const fs=require("fs");console.log(JSON.stringify(fs.readdirSync(process.argv[1],{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>({Path:e.name,Name:e.name,Size:-1,IsDir:true}))))' "$(strip "$p")"
      exit $? ;;
    esac
    node -e '
      const fs=require("fs"),path=require("path"),c=require("crypto"); const out=[];
      const walk=(d,rel)=>{ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const r=rel?rel+"/"+e.name:e.name;
        if(e.isDirectory()) walk(path.join(d,e.name),r); else { const b=fs.readFileSync(path.join(d,e.name));
        const it={Path:r,Size:b.length,IsDir:false,Hashes:{md5:c.createHash("md5").update(b).digest("hex")}}; out.push(it);
        if(path.join(d,e.name).endsWith(${JSON.stringify("/" + (opts.dupPath ?? "__sem-dup__"))})) out.push({...it,Size:b.length+1,Hashes:{md5:"f".repeat(32)}}); } } };
      walk(process.argv[1],""); console.log(JSON.stringify(out));' "$(strip "$p")" ;;
  copyto) cp "$(strip "$1")" "$2" ;;
  moveto)
    ${opts.lockedMove ? 'echo "googleapi: Error 403: insufficientFilePermissions" >&2; exit 1' : ""}
    a="$(strip "$2")"; b="$(strip "$3")"; mkdir -p "$(dirname "$b")"; mv "$a" "$b" ;;
  deletefile)
    f="$(strip "$(last "$@")")"
    case " $* " in *" --drive-use-trash=true "*)
      if [ -n "${opts.lockedTrash ?? ""}" ] && echo "$f" | grep -q "${opts.lockedTrash ?? "__"}"; then
        echo "googleapi: Error 403: The user does not have sufficient permissions for this file., insufficientFilePermissions" >&2; exit 1
      fi
      mkdir -p "${sb}/lixeira"; mv "$f" "${sb}/lixeira/" ; exit 0 ;;
    esac
    rm "$f" ;;
  *) exit 2 ;;
esac
`,
  );
  writeFileSync(join(bin, "md5sum"), `#!/bin/sh\nnode -e 'const c=require("crypto");console.log(c.createHash("md5").update(require("fs").readFileSync(process.argv[1])).digest("hex")+"  "+process.argv[1])' "$1"\n`);
  for (const b of ["rclone", "md5sum"]) chmodSync(join(bin, b), 0o755);
  const cfg = {
    ...defaultConfig({}),
    mount,
    localRoot: null,
    archiveRoot: archive,
    remoteRoot: "remote:",
    remoteName: "remote:",
    dataRoot: data,
    rclone: join(bin, "rclone"),
    systemctl: "false",
    md5sum: join(bin, "md5sum"),
    mountpointCmd: ["true"],
    pollSeconds: 0,
    lockPath: join(sb, "run.lock"),
  };
  const put = (rel: string, content: string) => {
    mkdirSync(join(drive, rel, ".."), { recursive: true });
    writeFileSync(join(drive, rel), content);
  };
  const edDir = (ed: string) => join(data, "editions", ed.slice(0, 4), ed);
  const publish = (ed: string) => {
    mkdirSync(join(edDir(ed), "_internal"), { recursive: true });
    writeFileSync(join(edDir(ed), "_internal", "05-youtube-published.json"), JSON.stringify({ aammdd: ed, videoId: "abc" }));
  };
  const liberar = (ed: string) => writeLiberada(data, ed, new Date("2026-11-11T02:00:00Z"), { forced: false });
  const agendar = (itens: Array<{ id: string; edicao: string; estado: string }>) => {
    mkdirSync(join(data, "agendamentos"), { recursive: true });
    const now = "2026-11-10T00:00:00Z";
    writeFileSync(
      join(data, "agendamentos", "banco.json"),
      JSON.stringify({
        version: 1,
        revisao: 1,
        itens: itens.map((i) => ({ ...i, peca: i.id.slice(7), destinos: ["youtube_shorts"], alvo: "2026-11-18T12:00:00-03:00", dono: "teste", criado_em: now, atualizado_em: now, historico: [] })),
      }),
    );
  };
  const callLines = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
  return { sb, drive, archive, data, cfg, put, publish, liberar, agendar, edDir, callLines };
}

const posixOnly = { skip: process.platform === "win32" ? "precisa de /bin/sh" : false };

describe("runArchive: edição renomeada (#13632)", posixOnly, () => {
  const setup = () => {
    const s = sandbox();
    s.put("261109/20261109_150417.mp4", "bruto-1");
    s.put("261109/Vertical_V12.xml", "<xmeml><pathurl>file://localhost/261109/20261109_150417.mp4</pathurl></xmeml>");
    s.put("261110/_origem-brutos.json", JSON.stringify({ renomeada: { de: "261109", para: "261110", motivo: "editor" } }));
    s.put("261110/Vertical_V12.xml", "<xmeml><pathurl>file://localhost/261110/20261109_150417.mp4</pathurl></xmeml>");
    s.publish("261110"); // 261109 não tem pasta em data/editions
    return s;
  };

  it("dry-run: a pasta antiga segue a edição nova e o bruto sairia movido para ela", async () => {
    const s = setup();
    const r = await runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    const d = r.folders.find((f) => f.name === "261109")!;
    assert.equal(d.eligible, true, JSON.stringify(d));
    assert.deepEqual(d.renamedTo, { "261109": "261110" });
    assert.deepEqual(r.files.map((f) => [f.folder, f.path, f.status]), [["261109", "20261109_150417.mp4", "moveria-para-edicao-renomeada"]]);
    assert.ok(existsSync(join(s.drive, "261109/20261109_150417.mp4")));
    assert.ok(!s.callLines().some((l) => /rclone (moveto|deletefile|copyto)/.test(l)));
  });

  it("--apply: move o bruto para a pasta nova, que o arquiva pela regra dela, e registra", async () => {
    const s = setup();
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    assert.deepEqual(
      r.files.map((f) => [f.folder, f.path, f.status]),
      [
        ["261109", "20261109_150417.mp4", "movido-para-edicao-renomeada"],
        ["261110", "20261109_150417.mp4", "arquivado"],
      ],
    );
    assert.ok(!existsSync(join(s.drive, "261109/20261109_150417.mp4")));
    assert.ok(!existsSync(join(s.drive, "261110/20261109_150417.mp4")));
    assert.equal(readFileSync(join(s.archive, "261110/20261109_150417.mp4"), "utf8"), "bruto-1");
    const reg = readFileSync(join(s.archive, "261110", ARCHIVE_REGISTRY_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(reg.map((e) => [e.kind, e.path]), [["bruto", "20261109_150417.mp4"]]);
  });

  it("nome já na pasta nova com outro conteúdo: nada movido e a rodada falha", async () => {
    const s = setup();
    s.put("261110/20261109_150417.mp4", "outro-conteudo");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14, only: new Set(["261109"]) });
    assert.equal(r.files[0].status, "conflito-na-edicao-renomeada");
    assert.equal(reportFailed(r), true);
    assert.ok(!s.callLines().some((l) => l.startsWith("rclone moveto")));
  });

  it("Drive recusa mover por permissão: não é falha, mas vira aviso ao editor", async () => {
    const s = sandbox({ lockedMove: true });
    s.put("261109/20261109_150417.mp4", "bruto-1");
    s.put("261110/_origem-brutos.json", JSON.stringify({ renomeada: { de: "261109", para: "261110" } }));
    s.publish("261110");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    const moved = r.files.find((f) => f.status === "nao-movido-sem-permissao");
    assert.ok(moved, JSON.stringify(r.files));
    assert.ok(notDeletedFinding(r));
  });
});

describe("runArchive: finais da edição liberada (#13630)", posixOnly, () => {
  it("liberada e sem agendamento pendente: finais e prévias saem com cópia conferida; o resto fica", async () => {
    const s = sandbox();
    s.put("261117/Final/Diaria_V3.mp4", "final-h");
    s.put("261117/261117 - previa youtube.mp4", "previa");
    s.put("261117/arquivo/261117 - previa antiga.mp4", "previa-velha");
    s.put("261117/261117_audio_tratado-1.wav", "audio");
    s.put("261117/20261116_150000.mp4", "bruto-recente");
    s.put("261118/Final/Diaria_V1.mp4", "final-nao-liberado");
    s.publish("261117");
    s.publish("261118");
    s.liberar("261117");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    assert.deepEqual(
      r.files.map((f) => [f.path, f.kind, f.status]).sort(),
      [
        ["261117 - previa youtube.mp4", "final", "arquivado"],
        ["Final/Diaria_V3.mp4", "final", "arquivado"],
        ["arquivo/261117 - previa antiga.mp4", "final", "arquivado"],
      ],
    );
    assert.equal(readFileSync(join(s.archive, "261117/Final/Diaria_V3.mp4"), "utf8"), "final-h");
    assert.ok(existsSync(join(s.drive, "261117/261117_audio_tratado-1.wav")));
    assert.ok(existsSync(join(s.drive, "261117/20261116_150000.mp4")), "bruto segue os 4 dias");
    assert.ok(existsSync(join(s.drive, "261118/Final/Diaria_V1.mp4")), "edição não liberada fica");
    const reg = readFileSync(join(s.archive, "261117", ARCHIVE_REGISTRY_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(reg.length, 3);
    assert.ok(reg.every((e) => e.kind === "final" && typeof e.destino === "string" && e.md5));
    // o download vem antes do delete, como nos brutos
    const calls = s.callLines();
    const cp = calls.findIndex((l) => l.startsWith("rclone copyto") && l.includes("Diaria_V3"));
    const del = calls.findIndex((l) => l.startsWith("rclone deletefile") && l.includes("Diaria_V3"));
    assert.ok(cp >= 0 && del > cp);
    assert.ok(calls[del].includes("--drive-use-trash=false"));
  });

  it("vertical 2 ainda pendente no banco de agendamentos segura os finais", async () => {
    const s = sandbox();
    s.put("261117/Final/Diaria_V3-guia.mp4", "guia");
    s.publish("261117");
    s.liberar("261117");
    s.agendar([{ id: "261117-vertical-2", edicao: "261117", estado: "pendente" }]);
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(r.files, []);
    const d = r.finalsFolders.find((f) => f.name === "261117")!;
    assert.equal(!d.eligible && d.reason, "agendamento-pendente");
    assert.ok(existsSync(join(s.drive, "261117/Final/Diaria_V3-guia.mp4")));
  });
});

describe("runArchive: final com nome repetido no Drive (#13675)", posixOnly, () => {
  it("regressão: dois exports com o mesmo nome em Final/ ficam no Drive, viram aviso e a rodada NÃO falha", async () => {
    // O Drive aceita dois arquivos com o mesmo nome; o rclone falso lista Final/Diaria_V3.mp4 duas vezes.
    const s = sandbox({ dupPath: "261117/Final/Diaria_V3.mp4" });
    s.put("261117/Final/Diaria_V3.mp4", "final-h");
    s.put("261117/Final/Diaria_vertical_V3.mp4", "final-v");
    s.publish("261117");
    s.liberar("261117");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    const dup = r.files.filter((f) => f.path === "Final/Diaria_V3.mp4");
    assert.ok(dup.length > 0 && dup.every((f) => f.status === "final-nome-duplicado-mantido" && f.kind === "final"), JSON.stringify(r.files));
    assert.ok(existsSync(join(s.drive, "261117/Final/Diaria_V3.mp4")), "o duplicado fica para o próximo ciclo");
    assert.ok(!s.callLines().some((l) => l.startsWith("rclone deletefile") && l.includes("Diaria_V3.mp4")), "nada apagado por nome ambíguo");
    // o outro final da mesma pasta segue o fluxo normal
    assert.equal(r.files.find((f) => f.path === "Final/Diaria_vertical_V3.mp4")?.status, "arquivado");
    const finding = notDeletedFinding(r)!;
    assert.ok(finding, "vira aviso ao editor (issue deduplicada por conjunto)");
    assert.match(finding.body, /261117\/Final\/Diaria_V3\.mp4.*final-nome-duplicado-mantido/);
  });
});

describe("runArchive: duplicatas entre pastas (#13627)", posixOnly, () => {
  const setup = (opts: Parameters<typeof sandbox>[0] = {}) => {
    const s = sandbox(opts);
    s.put("261109/261109_audio_tratado-81a61a72.wav", "WAV");
    s.put("261110/261110_audio_tratado-81a61a72.wav", "WAV");
    s.put("261109/261109_cta_card_vertical.png", "CTA");
    s.put("261111/261110_cta_card_vertical.png", "CTA");
    s.put("261111/Vertical_V1.xml", "<xmeml><pathurl>file://localhost/261111/261110_cta_card_vertical.png</pathurl></xmeml>");
    s.put("261110/Vertical_V1.xml", "<xmeml><pathurl>file://localhost/261110/outro.png</pathurl></xmeml>");
    s.put("261109/vazio.mp4", "");
    s.put("261110/vazio.mp4", "");
    for (const ed of ["261109", "261110", "261111"]) s.publish(ed);
    return s;
  };

  it("dry-run lista a cópia que sairia e não toca nada", async () => {
    const s = setup();
    const r = await runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(r.files.map((f) => [f.folder, f.path, f.kind, f.status]), [["261110", "261110_audio_tratado-81a61a72.wav", "duplicata", "duplicata-sairia"]]);
    assert.ok(!s.callLines().some((l) => l.startsWith("rclone deletefile")));
  });

  it("--apply manda a cópia para a LIXEIRA; referenciada pelo XML da própria pasta e 0 byte ficam", async () => {
    const s = setup();
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    assert.deepEqual(r.files.map((f) => [f.folder, f.path, f.status]), [["261110", "261110_audio_tratado-81a61a72.wav", "duplicata-na-lixeira"]]);
    assert.equal(r.trashedBytes, 3);
    assert.ok(!existsSync(join(s.drive, "261110/261110_audio_tratado-81a61a72.wav")));
    assert.ok(existsSync(join(s.drive, "261109/261109_audio_tratado-81a61a72.wav")), "a original fica");
    assert.ok(existsSync(join(s.drive, "261111/261110_cta_card_vertical.png")), "referenciada pelo XML da pasta");
    assert.ok(existsSync(join(s.drive, "261110/vazio.mp4")));
    const del = s.callLines().filter((l) => l.startsWith("rclone deletefile"));
    assert.equal(del.length, 1);
    assert.ok(del[0].includes("--drive-use-trash=true"), del[0]);
    const reg = readFileSync(join(s.archive, "261110", ARCHIVE_REGISTRY_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(reg[0].kind, "duplicata");
    assert.match(reg[0].destino, /lixeira do Drive \(cópia de 261109\/261109_audio_tratado-81a61a72\.wav\)/);
    assert.equal(notDeletedFinding(r), null, "rodada limpa não avisa nada");
  });

  it("lixeira recusada por ser de outro dono: aviso, não falha", async () => {
    const s = setup({ lockedTrash: "261110_audio" });
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false);
    assert.equal(r.files[0].status, "duplicata-nao-apagada-sem-permissao");
    const finding = notDeletedFinding(r)!;
    assert.equal(finding.severity, "acao");
    assert.match(finding.body, /261110\/261110_audio_tratado-81a61a72\.wav/);
  });
});

describe("aviso da rotina diária (#13631)", () => {
  const rep = (files: ArchiveReport["files"]): ArchiveReport => ({
    at: "", applied: true, folders: [], finalsFolders: [], files, errors: [], warnings: [], driveFreeBefore: null, driveFreeAfter: null, archivedBytes: 0, trashedBytes: 0,
  });
  it("mesmo conjunto = mesmo fingerprint (a issue é reusada, sem ruído); conjunto novo = outro; só arquivado = nada", () => {
    const a = rep([{ folder: "261110", path: "x.mp4", sizeBytes: 1, status: "nao-apagado-sem-permissao" }]);
    const b = rep([{ folder: "261110", path: "x.mp4", sizeBytes: 1, status: "nao-apagado-sem-permissao" }, { folder: "261110", path: "y.mp4", sizeBytes: 1, status: "arquivado" }]);
    const c = rep([{ folder: "261111", path: "z.mp4", sizeBytes: 1, status: "duplicata-nao-apagada-sem-permissao" }]);
    assert.equal(notDeletedFinding(a)!.fingerprint, notDeletedFinding(b)!.fingerprint);
    assert.notEqual(notDeletedFinding(a)!.fingerprint, notDeletedFinding(c)!.fingerprint);
    assert.equal(notDeletedFinding(rep([{ folder: "261110", path: "y.mp4", sizeBytes: 1, status: "arquivado" }])), null);
  });
});

describe("mark-video-liberada (#13630)", () => {
  const onlyShorts = { ...DEFAULT_SHORTS_CONFIG, facebookPages: [], instagram: false, linkedinProfile: false, linkedinPageRepost: false, x: false, tiktok: false, threadsProfile: false, facebookProfile: false };
  const mk = () => {
    const data = mkdtempSync(join(tmpdir(), "liberada-"));
    const dir = join(data, "editions", "2611", "261117", "_internal");
    mkdirSync(dir, { recursive: true });
    return { data, dir };
  };

  it("sem o link do horizontal não libera", () => {
    const { data } = mk();
    const c = checkLiberada({ dataRoot: data, edition: "261117", shortsConfig: () => onlyShorts });
    assert.equal(c.horizontal, false);
    assert.equal(c.vertical, false);
    assert.ok(c.problems.length >= 2);
  });

  it("horizontal publicado e vertical terminal: libera; o marcador grava e é lido pela rotina", () => {
    const { data, dir } = mk();
    writeFileSync(join(dir, "05-youtube-published.json"), JSON.stringify({ aammdd: "261117", videoId: "abc" }));
    writeFileSync(join(dir, "06-shorts-published.json"), JSON.stringify({ aammdd: "261117", entries: [{ destination: "youtube_shorts", status: "published", id: "s1", at: "2026-11-17T12:00:00Z" }] }));
    const c = checkLiberada({ dataRoot: data, edition: "261117", shortsConfig: () => onlyShorts });
    assert.deepEqual([c.horizontal, c.vertical, c.problems], [true, true, []]);
    const path = writeLiberada(data, "261117", new Date("2026-11-17T23:00:00Z"), { forced: false });
    assert.equal(parseVideoLiberada(JSON.parse(readFileSync(path, "utf8")), "261117"), true);
    assert.equal(checkLiberada({ dataRoot: data, edition: "261117", shortsConfig: () => onlyShorts }).already, true);
  });

  it("vertical com destino pendente não libera", () => {
    const { data, dir } = mk();
    writeFileSync(join(dir, "05-youtube-published.json"), JSON.stringify({ aammdd: "261117", videoId: "abc" }));
    const c = checkLiberada({ dataRoot: data, edition: "261117", shortsConfig: () => ({ ...onlyShorts, instagram: true }) });
    assert.equal(c.vertical, false);
  });
});
