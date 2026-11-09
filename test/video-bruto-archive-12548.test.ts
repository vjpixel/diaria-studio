/**
 * test/video-bruto-archive-12548.test.ts (#12548)
 *
 * Política pura do arquivamento dos brutos do vídeo + o executor
 * (`scripts/archive-video-brutos.ts`) contra um Drive FALSO: `rclone`,
 * `systemctl` e `md5sum` são scripts sh num tmpdir, o "Drive" é uma pasta
 * local. Nunca toca o remote real. Os testes do executor pedem /bin/sh e
 * ficam fora no Windows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decideFolder,
  editionsOfFolder,
  isBrutoFile,
  parseMd5sumLine,
  parseRcloneLsjson,
  verifyCopy,
} from "../scripts/lib/diaria/video-bruto-archive.ts";
import { defaultConfig, isPermissionError, reportFailed, runArchive } from "../scripts/archive-video-brutos.ts";

const TODAY = new Date("2026-11-09T00:00:00Z");

describe("isBrutoFile (#12548)", () => {
  it("pega os nomes de câmera, o bruto unido e o que está em Brutos/", () => {
    for (const p of [
      "20261104_124252.mp4",
      "20261027_135240.MP4",
      "WIN_20261020_21_24_22_Pro.mp4",
      "20261104_bruto_unido.mp4",
      "Brutos/20261021_203814.mp4",
      "brutos/qualquer nome.mov",
    ]) {
      assert.equal(isBrutoFile(p), true, p);
    }
  });

  it("deixa no Drive exports, prévias, áudio e o que está em Final/ e Editado/", () => {
    for (const p of [
      "261105 - previa youtube.mp4",
      "20261104_124252 previa.mp4",
      "Diaria comentada_Youtube_V1.mp4",
      "Diar.ia.br comentada_01_Final.mp4",
      "261105_audio_tratado-20790c96.wav",
      "Final/20261104_124252.mp4",
      "Editado/20261104_124252.mp4",
      "Brutos/notas.txt",
      "261027 - montagem (importar no Premiere).xml",
    ]) {
      assert.equal(isBrutoFile(p), false, p);
    }
  });
});

describe("editionsOfFolder / decideFolder (#12548)", () => {
  it("lê AAMMDD e AAMMDD-DD, recusa o resto", () => {
    assert.deepEqual(editionsOfFolder("261105"), ["261105"]);
    assert.deepEqual(editionsOfFolder("261109-10"), ["261109", "261110"]);
    assert.equal(editionsOfFolder("_marca"), null);
    assert.equal(editionsOfFolder("261110-09"), null);
  });

  it("entra com vídeo publicado em todas as edições do nome", () => {
    const d = decideFolder({ name: "261105", published: { "261105": true } }, TODAY);
    assert.equal(d.eligible, true);
    assert.equal(d.reason, "publicado");
  });

  it("pasta de 2 edições só entra com as duas publicadas", () => {
    const d = decideFolder({ name: "261109-10", published: { "261109": true, "261110": false } }, TODAY);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, "aguardando-publicacao");
  });

  it("sem registro de publicação, entra só depois do teto (edições anteriores ao publica-video)", () => {
    assert.equal(decideFolder({ name: "261021", published: { "261021": false } }, TODAY).eligible, true);
    assert.equal(decideFolder({ name: "261030", published: { "261030": false } }, TODAY).eligible, false);
    const unknown = decideFolder({ name: "261105", published: { "261105": null } }, TODAY);
    assert.equal(unknown.eligible, false);
    assert.equal(unknown.reason, "publicacao-desconhecida");
  });

  it("nome fora do padrão nunca entra", () => {
    assert.equal(decideFolder({ name: "_marca", published: {} }, TODAY).eligible, false);
  });
});

describe("conferência (#12548)", () => {
  it("parseia md5sum e lsjson", () => {
    assert.equal(parseMd5sumLine("D41D8CD98F00B204E9800998ECF8427E  /x/a.mp4\n"), "d41d8cd98f00b204e9800998ecf8427e");
    assert.equal(parseMd5sumLine("md5sum: x: No such file"), null);
    const files = parseRcloneLsjson(
      JSON.stringify([
        { Path: "Brutos", IsDir: true, Size: -1 },
        { Path: "a.mp4", Size: 3, IsDir: false, Hashes: { md5: "ABCDEFABCDEFABCDEFABCDEFABCDEFAB" } },
        { Path: "b.mp4", Size: 4, IsDir: false },
      ]),
    );
    assert.deepEqual(files, [
      { path: "a.mp4", size: 3, md5: "abcdefabcdefabcdefabcdefabcdefab" },
      { path: "b.mp4", size: 4, md5: null },
    ]);
    assert.throws(() => parseRcloneLsjson("não é json"));
  });

  it("só libera apagar com tamanho e MD5 iguais", () => {
    const remote = { path: "a.mp4", size: 3, md5: "aa".repeat(16) };
    assert.equal(verifyCopy(remote, { size: 3, md5: "aa".repeat(16) }), "ok");
    assert.equal(verifyCopy(remote, { size: 2, md5: "aa".repeat(16) }), "tamanho-diverge");
    assert.equal(verifyCopy(remote, { size: 3, md5: "bb".repeat(16) }), "md5-diverge");
    assert.equal(verifyCopy(remote, { size: 3, md5: null }), "md5-diverge");
    assert.equal(verifyCopy({ ...remote, md5: null }, { size: 3, md5: "aa".repeat(16) }), "sem-md5-no-drive");
  });

  it("reconhece a recusa por permissão do Drive", () => {
    assert.equal(isPermissionError("googleapi: Error 403: The user does not have sufficient permissions, insufficientFilePermissions"), true);
    assert.equal(isPermissionError("Failed to delete: context deadline exceeded"), false);
  });
});

// ── executor contra um Drive falso ──────────────────────────────────────────

function sandbox(opts: { lockedFiles?: string[]; badMd5?: string[] } = {}) {
  const sb = mkdtempSync(join(tmpdir(), "bruto-archive-"));
  const mount = join(sb, "hd");
  const drive = join(sb, "drive");
  const local = join(mount, "GoogleDrive", "YouTube");
  const archive = join(mount, "arquivo-video");
  const data = join(sb, "data");
  const bin = join(sb, "bin");
  for (const d of [drive, local, archive, bin, join(data, "editions")]) mkdirSync(d, { recursive: true });
  const calls = join(sb, "calls.log");

  const put = (root: string, rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const publish = (ed: string) => {
    const dir = join(data, "editions", ed.slice(0, 4), ed, "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "05-youtube-published.json"), JSON.stringify({ aammdd: ed, videoId: "abc" }));
  };

  // lsjson/about/copyto/deletefile sobre a pasta `drive`; md5 do Drive = md5 real do conteúdo,
  // salvo para os arquivos em `badMd5` (simula corrupção no Drive).
  const bad = JSON.stringify(opts.badMd5 ?? []);
  const locked = (opts.lockedFiles ?? []).join("|");
  writeFileSync(
    join(bin, "rclone"),
    `#!/bin/sh
echo "rclone $*" >> "${calls}"
cmd="$1"; shift
strip() { echo "$1" | sed "s|^remote:|${drive}/|"; }
case "$cmd" in
  about) echo '{"total":100,"free":50}' ;;
  lsjson)
    for a in "$@"; do p="$a"; done
    node -e '
      const fs=require("fs"),path=require("path"),c=require("crypto");
      const root=process.argv[1], bad=JSON.parse(process.argv[2]); const out=[];
      const walk=(d,rel)=>{ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const r=rel?rel+"/"+e.name:e.name;
        if(e.isDirectory()) walk(path.join(d,e.name),r); else { const b=fs.readFileSync(path.join(d,e.name));
        out.push({Path:r,Size:b.length,IsDir:false,Hashes:{md5: bad.includes(r)?"0".repeat(32):c.createHash("md5").update(b).digest("hex")}}); } } };
      walk(root,""); console.log(JSON.stringify(out));' "$(strip "$p")" '${bad}' ;;
  copyto) cp "$(strip "$1")" "$2" ;;
  deletefile)
    for a in "$@"; do p="$a"; done
    f="$(strip "$p")"
    if [ -n "${locked}" ] && echo "$f" | grep -E -q "${locked}"; then
      echo "googleapi: Error 403: insufficientFilePermissions" >&2; exit 1
    fi
    rm "$f" ;;
  *) exit 2 ;;
esac
`,
  );
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${calls}"\n[ "$2" = "is-active" ] && echo inactive\nexit 0\n`);
  writeFileSync(join(bin, "md5sum"), `#!/bin/sh\nnode -e 'const c=require("crypto");console.log(c.createHash("md5").update(require("fs").readFileSync(process.argv[1])).digest("hex")+"  "+process.argv[1])' "$1"\n`);
  for (const b of ["rclone", "systemctl", "md5sum"]) chmodSync(join(bin, b), 0o755);

  const cfg = {
    ...defaultConfig({}),
    mount,
    localRoot: local,
    archiveRoot: archive,
    remoteRoot: "remote:",
    remoteName: "remote:",
    dataRoot: data,
    rclone: join(bin, "rclone"),
    systemctl: join(bin, "systemctl"),
    md5sum: join(bin, "md5sum"),
    mountpointCmd: ["true"],
    pollSeconds: 0,
  };
  // Mesmo arquivo nos dois lados = o espelho do bisync em dia.
  const both = (rel: string, content: string) => {
    put(drive, rel, content);
    put(local, rel, content);
  };
  return { sb, drive, local, archive, calls, cfg, both, put, publish };
}

const posixOnly = { skip: process.platform === "win32" ? "precisa de /bin/sh" : false };

describe("runArchive contra Drive falso (#12548)", posixOnly, () => {
  it("dry-run lista e não toca nada", () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(r.files.map((f) => [f.path, f.status]), [["20261104_124252.mp4", "sairia"]]);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!readFileSync(s.calls, "utf8").includes("deletefile"));
    assert.ok(!readFileSync(s.calls, "utf8").includes("systemctl"));
  });

  it("--apply move o bruto do espelho pro arquivo, apaga do Drive sem lixeira e deixa o resto", () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto-1");
    s.both("261105/Brutos/20261103_000000.mp4", "bruto-2");
    s.both("261105/Final/export.mp4", "final");
    s.both("261105/261105 - previa youtube.mp4", "previa");
    s.both("261109-10/20261109_150417.mp4", "nao-publicado");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    assert.deepEqual(r.files.map((f) => f.status), ["arquivado", "arquivado"]);
    for (const rel of ["20261104_124252.mp4", "Brutos/20261103_000000.mp4"]) {
      assert.ok(!existsSync(join(s.drive, "261105", rel)), `${rel} saiu do Drive`);
      assert.ok(!existsSync(join(s.local, "261105", rel)), `${rel} saiu do espelho`);
      assert.ok(existsSync(join(s.archive, "261105", rel)), `${rel} está no arquivo`);
    }
    assert.ok(existsSync(join(s.drive, "261105/Final/export.mp4")));
    assert.ok(existsSync(join(s.drive, "261105/261105 - previa youtube.mp4")));
    assert.ok(existsSync(join(s.drive, "261109-10/20261109_150417.mp4")));
    const calls = readFileSync(s.calls, "utf8");
    assert.match(calls, /deletefile --drive-use-trash=false/);
    // bisync pausado antes e religado depois
    assert.ok(calls.indexOf("stop diaria-gdrive-bisync.timer") < calls.indexOf("deletefile"));
    assert.ok(calls.lastIndexOf("start diaria-gdrive-bisync.timer") > calls.lastIndexOf("deletefile"));
  });

  it("MD5 divergente não apaga e a rodada falha", () => {
    const s = sandbox({ badMd5: ["20261104_124252.mp4"] });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-conferencia");
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(existsSync(join(s.local, "261105/20261104_124252.mp4")), "cópia continua no espelho");
    assert.match(readFileSync(s.calls, "utf8"), /start diaria-gdrive-bisync.timer/);
  });

  it("arquivo de outro dono: devolve a cópia ao espelho e não conta como falha", () => {
    const s = sandbox({ lockedFiles: ["20261104_124252"] });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "nao-apagado-sem-permissao");
    assert.equal(reportFailed(r), false);
    assert.ok(existsSync(join(s.local, "261105/20261104_124252.mp4")), "voltou ao espelho");
    assert.ok(!existsSync(join(s.archive, "261105/20261104_124252.mp4")));
  });

  it("sem cópia no espelho, baixa do Drive direto para o arquivo", () => {
    const s = sandbox();
    s.put(s.drive, "261105/20261104_124252.mp4", "so-no-drive");
    mkdirSync(join(s.local, "261105"), { recursive: true });
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "download");
    assert.equal(r.files[0].status, "arquivado");
    assert.equal(readFileSync(join(s.archive, "261105/20261104_124252.mp4"), "utf8"), "so-no-drive");
    assert.ok(!existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("HD desmontado: não faz nada e falha", () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: { ...s.cfg, mountpointCmd: ["false"] }, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!existsSync(s.calls), "nenhuma chamada a rclone/systemctl");
  });
});

describe("task agendada (#12548)", () => {
  it("Diaria-Video-Bruto-Archive roda o script com --apply, sábado de madrugada, habilitada", async () => {
    const { getScheduledTaskByName } = await import("../scripts/lib/scheduled-tasks.ts");
    const t = getScheduledTaskByName("Diaria-Video-Bruto-Archive");
    assert.ok(t);
    assert.deepEqual(t.steps.map((s) => [s.script, s.args]), [["scripts/archive-video-brutos.ts", ["--apply"]]]);
    assert.deepEqual(t.schedule, { kind: "weekly", dayOfWeek: "Saturday", hour: 3, minute: 0 });
    assert.notEqual(t.enabled, false);
  });
});
