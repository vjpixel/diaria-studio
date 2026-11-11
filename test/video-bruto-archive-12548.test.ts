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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  brutoRefKey,
  decideFolder,
  duplicatePaths,
  editionsOfFolder,
  isBrutoFile,
  montageSourceRefs,
  parseMd5sumLine,
  parseRcloneLsjson,
  parseRcloneLsjsonDirs,
  parseRunLock,
  parseVerifiedRecord,
  referencingEditions,
  runLockIsStale,
  verifiedRecordTrusted,
  verifyCopy,
} from "../scripts/lib/diaria/video-bruto-archive.ts";
import { spawn } from "node:child_process";
import {
  acquireRunLock,
  bisyncIdle,
  createStopController,
  defaultConfig,
  isPermissionError,
  reportFailed,
  requestStop,
  runArchive,
  setAsideConflict,
} from "../scripts/archive-video-brutos.ts";

const TODAY = new Date("2026-11-09T00:00:00Z");

describe("isBrutoFile (#12548)", () => {
  it("pega os nomes de câmera, o bruto unido e o que está em Brutos/", async () => {
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

  it("deixa no Drive exports, prévias, áudio e o que está em Final/ e Editado/", async () => {
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
  it("lê AAMMDD e AAMMDD-DD, recusa o resto", async () => {
    assert.deepEqual(editionsOfFolder("261105"), ["261105"]);
    assert.deepEqual(editionsOfFolder("261109-10"), ["261109", "261110"]);
    assert.equal(editionsOfFolder("_marca"), null);
    assert.equal(editionsOfFolder("261110-09"), null);
  });

  it("entra com vídeo publicado em todas as edições do nome", async () => {
    const d = decideFolder({ name: "261105", published: { "261105": true } }, TODAY);
    assert.equal(d.eligible, true);
    assert.equal(d.reason, "publicado");
  });

  it("pasta de 2 edições só entra com as duas publicadas", async () => {
    const d = decideFolder({ name: "261109-10", published: { "261109": true, "261110": false } }, TODAY);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, "aguardando-publicacao");
  });

  it("sem registro de publicação, entra só depois do teto (edições anteriores ao publica-video)", async () => {
    assert.equal(decideFolder({ name: "261021", published: { "261021": false } }, TODAY).eligible, true);
    assert.equal(decideFolder({ name: "261030", published: { "261030": false } }, TODAY).eligible, false);
    const unknown = decideFolder({ name: "261105", published: { "261105": null } }, TODAY);
    assert.equal(unknown.eligible, false);
    assert.equal(unknown.reason, "publicacao-desconhecida");
  });

  it("nome fora do padrão nunca entra", async () => {
    assert.equal(decideFolder({ name: "_marca", published: {} }, TODAY).eligible, false);
  });
});

describe("conferência (#12548)", () => {
  it("parseia md5sum e lsjson", async () => {
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

  it("só libera apagar com tamanho e MD5 iguais", async () => {
    const remote = { path: "a.mp4", size: 3, md5: "aa".repeat(16) };
    assert.equal(verifyCopy(remote, { size: 3, md5: "aa".repeat(16) }), "ok");
    assert.equal(verifyCopy(remote, { size: 2, md5: "aa".repeat(16) }), "tamanho-diverge");
    assert.equal(verifyCopy(remote, { size: 3, md5: "bb".repeat(16) }), "md5-diverge");
    assert.equal(verifyCopy(remote, { size: 3, md5: null }), "md5-local-indisponivel");
    assert.equal(verifyCopy({ ...remote, md5: null }, { size: 3, md5: "aa".repeat(16) }), "sem-md5-no-drive");
  });

  it("reconhece a recusa por permissão do Drive", async () => {
    assert.equal(isPermissionError("googleapi: Error 403: The user does not have sufficient permissions, insufficientFilePermissions"), true);
    assert.equal(isPermissionError("Failed to delete: context deadline exceeded"), false);
  });
});

// ── executor contra um Drive falso ──────────────────────────────────────────

type DeleteMode = "ok" | "locked" | "ratelimit" | "apagou-mas-erro" | "erro";

function sandbox(
  opts: {
    lockedFiles?: string[];
    badMd5?: string[];
    deleteMode?: DeleteMode;
    failCopyto?: boolean;
    /** Lista o 1º bruto da pasta duas vezes (nome repetido no Drive). */
    dupFirst?: boolean;
    timerActive?: boolean;
    /** Quantas consultas `is-active` do serviço respondem "activating" antes de "inactive"; -1 = sempre. */
    serviceBusyPolls?: number;
    /** O que `is-active` do serviço imprime quando ocupado. */
    busyState?: string;
    failStart?: boolean;
    /** #12603: `deletefile` grava `hang` e fica parado (para mandar SIGTERM no meio). */
    hangDelete?: boolean;
    /** #12789: pastas que o `lsjson --dirs-only` lista duas vezes (pasta com nome repetido no Drive). */
    dupDirs?: string[];
  } = {},
) {
  const sb = mkdtempSync(join(tmpdir(), "bruto-archive-"));
  const mount = join(sb, "hd");
  const drive = join(sb, "drive");
  const local = join(mount, "GoogleDrive", "YouTube");
  const archive = join(mount, "arquivo-video");
  const data = join(sb, "data");
  const bin = join(sb, "bin");
  for (const d of [drive, local, archive, bin, join(data, "editions")]) mkdirSync(d, { recursive: true });
  const calls = join(sb, "calls.log");
  const hang = join(sb, "hang");

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
  const deleteMode: DeleteMode = opts.deleteMode ?? (locked ? "locked" : "ok");
  const dup = opts.dupFirst ? "1" : "";
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
    # #12789: --dirs-only (sem -R) lista as pastas de 1º nível, como o Drive sem espelho.
    case " $* " in *" --dirs-only "*)
      node -e 'const fs=require("fs"),dup=JSON.parse(process.argv[2]);const ds=fs.readdirSync(process.argv[1],{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>({Path:e.name,Name:e.name,Size:-1,IsDir:true}));console.log(JSON.stringify([...ds,...ds.filter(d=>dup.includes(d.Path))]))' "$(strip "$p")" '${JSON.stringify(opts.dupDirs ?? [])}'
      exit $? ;;
    esac
    node -e '
      const fs=require("fs"),path=require("path"),c=require("crypto");
      const root=process.argv[1], bad=JSON.parse(process.argv[2]); const out=[];
      const walk=(d,rel)=>{ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const r=rel?rel+"/"+e.name:e.name;
        if(e.isDirectory()) walk(path.join(d,e.name),r); else { const b=fs.readFileSync(path.join(d,e.name));
        out.push({Path:r,Size:b.length,IsDir:false,Hashes:{md5: bad.includes(r)?"0".repeat(32):c.createHash("md5").update(b).digest("hex")}}); } } };
      walk(root,""); if(process.argv[3] && out.length) out.push({...out.find(o=>!o.Path.includes(".xml"))});
      console.log(JSON.stringify(out));' "$(strip "$p")" '${bad}' '${dup}' ;;
  copyto) ${opts.failCopyto ? 'echo "copy falhou" >&2; exit 1' : 'cp "$(strip "$1")" "$2"'} ;;
  deletefile)
    for a in "$@"; do p="$a"; done
    f="$(strip "$p")"
    ${opts.hangDelete ? `touch "${hang}"; exec sleep 30` : ""}
    case "${deleteMode}" in
      locked)
        if echo "$f" | grep -E -q "${locked || "__nada__"}"; then
          echo "googleapi: Error 403: The user does not have sufficient permissions for this file., insufficientFilePermissions" >&2; exit 1
        fi ;;
      ratelimit) echo "googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded" >&2; exit 1 ;;
      apagou-mas-erro) rm "$f"; echo "Failed to delete: context deadline exceeded" >&2; exit 1 ;;
      erro) echo "Failed to delete: context deadline exceeded" >&2; exit 1 ;;
    esac
    rm "$f" ;;
  *) exit 2 ;;
esac
`,
  );
  // systemctl falso: timer ativo por padrão; o serviço do bisync fica "ocupado" por N consultas.
  const busyFile = join(sb, "busy-polls");
  writeFileSync(busyFile, String(opts.serviceBusyPolls ?? 0));
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> "${calls}"
if [ "$2" = "is-active" ]; then
  case "$3" in
    *.timer) ${opts.timerActive === false ? "echo inactive; exit 3" : "echo active; exit 0"} ;;
    *.service)
      n=$(cat "${busyFile}")
      if [ "$n" = "-1" ]; then echo "${opts.busyState ?? "activating"}"; exit 0; fi
      if [ "$n" -gt 0 ]; then echo $((n-1)) > "${busyFile}"; echo "${opts.busyState ?? "activating"}"; exit 0; fi
      echo inactive; exit 3 ;;
  esac
fi
${opts.failStart ? '[ "$2" = "start" ] && { echo "start falhou" >&2; exit 1; }' : ""}
exit 0
`,
  );
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
    // #12573: nunca a trava real em ~/.cache.
    lockPath: join(sb, "run.lock"),
  };
  // Mesmo arquivo nos dois lados = o espelho do bisync em dia.
  const both = (rel: string, content: string) => {
    put(drive, rel, content);
    put(local, rel, content);
  };
  return { sb, drive, local, archive, calls, hang, bin, data, mount, cfg, both, put, publish };
}

const posixOnly = { skip: process.platform === "win32" ? "precisa de /bin/sh" : false };

describe("runArchive contra Drive falso (#12548)", posixOnly, () => {
  it("dry-run lista e não toca nada", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(r.files.map((f) => [f.path, f.status]), [["20261104_124252.mp4", "sairia"]]);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!readFileSync(s.calls, "utf8").includes("deletefile"));
    assert.ok(!readFileSync(s.calls, "utf8").includes("systemctl"));
  });

  it("--apply move o bruto do espelho pro arquivo, apaga do Drive sem lixeira e deixa o resto", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto-1");
    s.both("261105/Brutos/20261103_000000.mp4", "bruto-2");
    s.both("261105/Final/export.mp4", "final");
    s.both("261105/261105 - previa youtube.mp4", "previa");
    s.both("261109-10/20261109_150417.mp4", "nao-publicado");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
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

  it("MD5 divergente não apaga e a rodada falha", async () => {
    const s = sandbox({ badMd5: ["20261104_124252.mp4"] });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-conferencia");
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(existsSync(join(s.local, "261105/20261104_124252.mp4")), "cópia continua no espelho");
    assert.match(readFileSync(s.calls, "utf8"), /start diaria-gdrive-bisync.timer/);
  });

  it("arquivo de outro dono: devolve a cópia ao espelho, guarda outra no arquivo e não conta como falha (#12570)", async () => {
    const s = sandbox({ lockedFiles: ["20261104_124252"] });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "nao-apagado-sem-permissao");
    assert.equal(reportFailed(r), false);
    assert.equal(readFileSync(join(s.local, "261105/20261104_124252.mp4"), "utf8"), "bruto", "voltou ao espelho");
    assert.equal(readFileSync(join(s.archive, "261105/20261104_124252.mp4"), "utf8"), "bruto", "cópia guardada no arquivo");
    assert.ok(!existsSync(join(s.archive, "261105/20261104_124252.mp4.partial")));
  });

  it("sem cópia no espelho, baixa do Drive direto para o arquivo", async () => {
    const s = sandbox();
    s.put(s.drive, "261105/20261104_124252.mp4", "so-no-drive");
    mkdirSync(join(s.local, "261105"), { recursive: true });
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "download");
    assert.equal(r.files[0].status, "arquivado");
    assert.equal(readFileSync(join(s.archive, "261105/20261104_124252.mp4"), "utf8"), "so-no-drive");
    assert.ok(!existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("HD desmontado: não faz nada e falha", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: { ...s.cfg, mountpointCmd: ["false"] }, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!existsSync(s.calls), "nenhuma chamada a rclone/systemctl");
  });

  // ── regressões do review da PR #12567 ──

  it("deletefile com erro mas o Drive apagou: relê, conta como arquivado e a cópia NÃO volta ao espelho", async () => {
    const s = sandbox({ deleteMode: "apagou-mas-erro" });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    assert.ok(existsSync(join(s.archive, "261105/20261104_124252.mp4")), "cópia conferida fica no arquivo");
    assert.ok(!existsSync(join(s.local, "261105/20261104_124252.mp4")), "não volta ao espelho (o bisync a apagaria)");
  });

  it("deletefile com erro e o arquivo continua no Drive: devolve ao espelho e falha", async () => {
    const s = sandbox({ deleteMode: "erro" });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-apagar");
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.local, "261105/20261104_124252.mp4")));
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("403 de rate limit é falha, não 'sem permissão'", async () => {
    const s = sandbox({ deleteMode: "ratelimit" });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-apagar");
    assert.equal(reportFailed(r), true);
  });

  it("nome repetido no Drive: não apaga nenhum dos dois", async () => {
    const s = sandbox({ dupFirst: true });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.ok(r.files.every((f) => f.status === "nome-duplicado-no-drive"));
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!readFileSync(s.calls, "utf8").includes("deletefile"));
  });

  it("download que falha não deixa .partial nem apaga nada", async () => {
    const s = sandbox({ failCopyto: true });
    s.put(s.drive, "261105/20261104_124252.mp4", "so-no-drive");
    mkdirSync(join(s.local, "261105"), { recursive: true });
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-download");
    assert.ok(!existsSync(join(s.archive, "261105/20261104_124252.mp4.partial")));
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("espera a rodada do bisync em curso e só então lista e apaga", async () => {
    const s = sandbox({ serviceBusyPolls: 2 });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    const calls = readFileSync(s.calls, "utf8").split("\n");
    const lastPoll = calls.map((l, i) => (l.includes("is-active diaria-gdrive-bisync.service") ? i : -1)).filter((i) => i >= 0).pop()!;
    const firstLsjson = calls.findIndex((l) => l.startsWith("rclone lsjson -R"));
    assert.ok(lastPoll < firstLsjson, "a listagem do Drive vem depois da pausa");
  });

  for (const busyState of ["activating", ""]) {
    it(`bisync que não termina ("${busyState || "vazio"}"): não apaga nada, religa o timer e falha`, async () => {
      const s = sandbox({ serviceBusyPolls: -1, busyState });
      s.both("261105/20261104_124252.mp4", "bruto");
      s.publish("261105");
      const r = await runArchive({ cfg: { ...s.cfg, waitMinutes: 0 }, apply: true, today: TODAY, unpublishedMaxDays: 14 });
      assert.equal(reportFailed(r), true);
      const calls = readFileSync(s.calls, "utf8");
      assert.ok(!calls.includes("deletefile") && !calls.includes("lsjson"));
      assert.match(calls, /start diaria-gdrive-bisync.timer/);
      assert.ok(existsSync(join(s.local, "261105/20261104_124252.mp4")));
    });
  }

  it("timer já parado fica parado no fim", async () => {
    const s = sandbox({ timerActive: false });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    const calls = readFileSync(s.calls, "utf8");
    assert.ok(!calls.includes("stop diaria-gdrive-bisync.timer") && !calls.includes("start diaria-gdrive-bisync.timer"));
  });

  it("falha ao religar o timer falha a rodada", async () => {
    const s = sandbox({ failStart: true });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    assert.equal(reportFailed(r), true);
  });

  it("retomada: cópia já no arquivo com o tamanho do Drive é conferida e o Drive é apagado", async () => {
    const s = sandbox();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto");
    s.put(s.archive, "261105/20261104_124252.mp4", "bruto");
    mkdirSync(join(s.local, "261105"), { recursive: true });
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "arquivo");
    assert.equal(r.files[0].status, "arquivado");
    assert.ok(!existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("cópia truncada no arquivo não trava: usa o espelho e a sobrescreve", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto-inteiro");
    s.put(s.archive, "261105/20261104_124252.mp4", "bru");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "espelho");
    assert.equal(r.files[0].status, "arquivado");
    assert.equal(readFileSync(join(s.archive, "261105/20261104_124252.mp4"), "utf8"), "bruto-inteiro");
  });

  it("pasta AAMMDD-DD entra com as duas edições publicadas", async () => {
    const s = sandbox();
    s.both("261103-04/20261102_094530.mp4", "bruto");
    s.publish("261103");
    s.publish("261104");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    assert.ok(existsSync(join(s.archive, "261103-04/20261102_094530.mp4")));
  });

  it("sem data/editions: só a pasta além do teto sai", async () => {
    const s = sandbox();
    s.both("261021/WIN_20261020_21_24_22_Pro.mp4", "velho");
    s.both("261105/20261104_124252.mp4", "novo");
    const r = await runArchive({ cfg: { ...s.cfg, dataRoot: join(s.sb, "sem-data") }, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(r.files.map((f) => [f.folder, f.status]), [["261021", "arquivado"]]);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });
});

describe("regressões puras do review (#12567)", () => {
  it("PXL_ com milissegundos é bruto", async () => {
    assert.equal(isBrutoFile("PXL_20261104_124252345.mp4"), true);
  });
  it("rate limit e cota nunca são 'sem permissão'", async () => {
    assert.equal(isPermissionError("googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded"), false);
    assert.equal(isPermissionError("googleapi: Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded"), false);
    assert.equal(isPermissionError("googleapi: Error 403: forbidden"), false);
  });
  it("md5sum que falhou não é 'conteúdo diferente'", async () => {
    assert.equal(verifyCopy({ path: "a", size: 1, md5: "aa".repeat(16) }, { size: 1, md5: null }), "md5-local-indisponivel");
  });
  it("duplicatePaths acha o nome repetido", async () => {
    const f = (path: string) => ({ path, size: 1, md5: null });
    assert.deepEqual([...duplicatePaths([f("a"), f("b"), f("a")])], ["a"]);
  });
  it("bisyncIdle só libera unit parada", async () => {
    assert.equal(bisyncIdle("inactive"), true);
    assert.equal(bisyncIdle("failed"), true);
    for (const s of ["", "active", "activating", "refreshing", "deactivating"]) assert.equal(bisyncIdle(s), false, s);
  });
  it("env numérica inválida falha cedo", async () => {
    assert.throws(() => defaultConfig({ VIDEO_ARCHIVE_WAIT_MINUTES: "abc" }));
  });
});

// ── #12602: bruto que outra edição ou o Short ainda usa ─────────────────────

describe("idade mínima da pasta publicada (#12602)", () => {
  it("horizontal publicado há menos de 4 dias fica (Short e cortes saem nos dias seguintes)", async () => {
    // TODAY = 261109; 261106 (sexta) tem 3 dias: o corte de terça ainda não saiu.
    const d = decideFolder({ name: "261106", published: { "261106": true } }, TODAY);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, "publicado-recente");
    assert.equal(decideFolder({ name: "261105", published: { "261105": true } }, TODAY).eligible, true);
    assert.equal(decideFolder({ name: "261106", published: { "261106": true } }, TODAY, 14, 3).eligible, true);
  });
});

describe("referências do source.json (#12602)", () => {
  it("chave é o nome do arquivo, em qualquer separador", async () => {
    assert.equal(brutoRefKey("G:/Meu Drive/Work/Mentoria Fluxo/VTSD/YouTube/261106/20261106_101010.mp4"), "20261106_101010.mp4");
    assert.equal(brutoRefKey("G:\\Meu Drive\\YouTube\\261106\\20261106_101010.MP4"), "20261106_101010.mp4");
    assert.equal(brutoRefKey("Brutos/20261103_000000.mp4"), "20261103_000000.mp4");
  });

  it("lê path e files[].path; formato estranho é null", async () => {
    assert.deepEqual(montageSourceRefs({ path: "a/x.mp4" }), ["a/x.mp4"]);
    assert.deepEqual(montageSourceRefs({ path: "a/x.mp4", files: [{ path: "a/x.mp4" }, { path: "b/y.mp4" }] }), ["a/x.mp4", "a/x.mp4", "b/y.mp4"]);
    assert.equal(montageSourceRefs({}), null);
    assert.equal(montageSourceRefs({ files: "x" }), null);
    assert.equal(montageSourceRefs({ path: "a", files: [{ id: "sem-path" }] }), null);
    assert.equal(montageSourceRefs([]), null);
  });

  it("referencingEditions casa pelo nome", async () => {
    const refs = new Map([["20261106_101010.mp4", ["261110"]]]);
    assert.deepEqual(referencingEditions("20261106_101010.mp4", refs), ["261110"]);
    assert.deepEqual(referencingEditions("Brutos/20261106_101010.mp4", refs), ["261110"]);
    assert.deepEqual(referencingEditions("20261106_999999.mp4", refs), []);
  });
});

describe("runArchive com montagem de outra edição em curso (#12602)", posixOnly, () => {
  const montage = (s: ReturnType<typeof sandbox>, ed: string, source: unknown) => {
    s.put(join(s.cfg.dataRoot, "editions", ed.slice(0, 4), ed), "_internal/video-montagem/source.json", typeof source === "string" ? source : JSON.stringify(source));
  };

  it("bruto da edição seguinte guardado na pasta publicada fica no Drive até ela sair; o resto sai", async () => {
    const s = sandbox();
    s.both("261105/20261105_090000.mp4", "bruto-da-261105");
    s.both("261105/20261105_100000.mp4", "bruto-da-261110");
    s.publish("261105");
    montage(s, "261105", { path: "G:/Meu Drive/Work/Mentoria Fluxo/VTSD/YouTube/261105/20261105_090000.mp4" });
    montage(s, "261110", {
      path: "G:/Meu Drive/Work/Mentoria Fluxo/VTSD/YouTube/261105/20261105_100000.mp4",
      files: [{ id: "20261105_100000", path: "G:\\Meu Drive\\Work\\Mentoria Fluxo\\VTSD\\YouTube\\261105\\20261105_100000.mp4" }],
    });
    const dry = await runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(
      dry.files.map((f) => [f.path, f.status]),
      [
        ["20261105_090000.mp4", "sairia"],
        ["20261105_100000.mp4", "em-uso-por-outra-edicao"],
      ],
    );
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    const used = r.files.find((f) => f.path === "20261105_100000.mp4")!;
    assert.equal(used.status, "em-uso-por-outra-edicao");
    assert.match(used.detail ?? "", /261110/);
    assert.ok(existsSync(join(s.drive, "261105/20261105_100000.mp4")), "bruto da 261110 continua no Drive");
    assert.ok(existsSync(join(s.local, "261105/20261105_100000.mp4")), "e no espelho");
    assert.ok(!existsSync(join(s.drive, "261105/20261105_090000.mp4")), "o bruto da própria 261105 sai");
    assert.equal(r.files.find((f) => f.path === "20261105_090000.mp4")!.status, "arquivado");
  });

  it("edição que referencia o bruto, publicada mas recente, ainda segura; passada a idade mínima, não segura mais", async () => {
    const s = sandbox();
    s.both("261105/20261105_100000.mp4", "bruto");
    s.publish("261105");
    s.publish("261107");
    montage(s, "261107", { path: "/x/261105/20261105_100000.mp4" });
    const held = await runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(held.files[0].status, "em-uso-por-outra-edicao");
    const later = await runArchive({ cfg: s.cfg, apply: false, today: new Date("2026-11-12T00:00:00Z"), unpublishedMaxDays: 14 });
    assert.equal(later.files[0].status, "sairia", "261107 com 5 dias já sairia: não segura");
  });

  it("source.json ilegível de edição em uso: erro e nada sai do Drive", async () => {
    const s = sandbox();
    s.both("261105/20261105_090000.mp4", "bruto");
    s.publish("261105");
    montage(s, "261110", "{ quebrado");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true);
    assert.match(r.errors.join("\n"), /261110.*source\.json ilegível/);
    assert.ok(existsSync(join(s.drive, "261105/20261105_090000.mp4")));
    assert.ok(!existsSync(s.calls) || !readFileSync(s.calls, "utf8").includes("deletefile"));
  });

  it("horizontal publicado ontem: a pasta fica (o Short da vertical nativa sai no dia útil seguinte)", async () => {
    const s = sandbox();
    s.both("261108/20261108_090000.mp4", "bruto");
    s.publish("261108");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.folders[0].reason, "publicado-recente");
    assert.deepEqual(r.files, []);
    assert.ok(existsSync(join(s.drive, "261108/20261108_090000.mp4")));
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

// ── #12603: sinal no meio da rodada e cópia de mesmo tamanho com MD5 errado ──

const BRUTOS_12603 = ["20261104_124252.mp4", "Brutos/20261103_000000.mp4"];

describe("regressões do review (#12603)", posixOnly, () => {
  it("cópia de mesmo tamanho e MD5 diferente no arquivo não trava: usa o espelho e a sobrescreve", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto-1");
    s.put(s.archive, "261105/20261104_124252.mp4", "bruto-X"); // mesmo tamanho, outro conteúdo
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    assert.equal(r.files[0].source, "espelho");
    assert.equal(r.files[0].status, "arquivado");
    assert.match(r.files[0].detail ?? "", /MD5 diferente/);
    assert.equal(readFileSync(join(s.archive, "261105/20261104_124252.mp4"), "utf8"), "bruto-1");
    assert.ok(!existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("cópia de mesmo tamanho e MD5 diferente no arquivo, sem espelho: baixa de novo e sobrescreve", async () => {
    const s = sandbox();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto-1");
    s.put(s.archive, "261105/20261104_124252.mp4", "bruto-X");
    mkdirSync(join(s.local, "261105"), { recursive: true });
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "download");
    assert.equal(r.files[0].status, "arquivado");
    assert.equal(readFileSync(join(s.archive, "261105/20261104_124252.mp4"), "utf8"), "bruto-1");
  });

  it("MD5 do Drive que não bate com nenhuma cópia continua falha e não apaga", async () => {
    const s = sandbox({ badMd5: ["20261104_124252.mp4"] });
    s.both("261105/20261104_124252.mp4", "bruto-1");
    s.put(s.archive, "261105/20261104_124252.mp4", "bruto-X");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-conferencia");
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(existsSync(join(s.local, "261105/20261104_124252.mp4")), "espelho intacto");
  });

  it("parada pedida no meio: para antes do próximo bruto, religa o timer e falha", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto-1");
    s.both("261105/Brutos/20261103_000000.mp4", "bruto-2");
    s.publish("261105");
    const stop = createStopController();
    let seen = 0;
    const r = await runArchive({
      cfg: s.cfg,
      apply: true,
      today: TODAY,
      unpublishedMaxDays: 14,
      stop,
      // Pede a parada ao começar o 1º bruto (o que o handler de SIGTERM faz em main).
      log: (l) => {
        if (/\.mp4 \(/.test(l) && seen++ === 0) requestStop(stop, "SIGTERM");
      },
    });
    assert.equal(reportFailed(r), true);
    assert.ok(r.errors.some((e) => /SIGTERM/.test(e)), JSON.stringify(r.errors));
    assert.equal(r.files.length, 1, "o 2º bruto nem começa");
    const other = BRUTOS_12603.find((p) => p !== r.files[0].path)!;
    assert.ok(existsSync(join(s.drive, "261105", other)) && existsSync(join(s.local, "261105", other)), "2º intacto no Drive e no espelho");
    assert.match(readFileSync(s.calls, "utf8"), /start diaria-gdrive-bisync.timer/);
  });

  it("SIGTERM no processo real durante um rclone: sai logo, religa o timer e grava o relatório", async () => {
    const s = sandbox({ hangDelete: true });
    s.both("261105/20261104_124252.mp4", "bruto-1");
    s.both("261105/Brutos/20261103_000000.mp4", "bruto-2");
    s.publish("261105");
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/archive-video-brutos.ts", "--apply", "--only", "261105"], {
      env: {
        ...process.env,
        HOME: s.sb,
        VIDEO_ARCHIVE_MOUNT: s.mount,
        VIDEO_ARCHIVE_LOCAL_ROOT: s.local,
        VIDEO_ARCHIVE_ROOT: s.archive,
        VIDEO_ARCHIVE_REMOTE_ROOT: "remote:",
        VIDEO_ARCHIVE_REMOTE: "remote:",
        VIDEO_ARCHIVE_DATA_ROOT: s.data,
        RCLONE_BIN: join(s.bin, "rclone"),
        SYSTEMCTL_BIN: join(s.bin, "systemctl"),
        MD5SUM_BIN: join(s.bin, "md5sum"),
        VIDEO_ARCHIVE_MOUNTPOINT_CMD: "true",
        VIDEO_ARCHIVE_POLL_SECONDS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    const deadline = Date.now() + 60_000;
    while (!existsSync(s.hang)) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        assert.fail(`deletefile nunca começou: ${stderr}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]);
    if (code === "timeout") child.kill("SIGKILL");
    assert.notEqual(code, "timeout", `o sinal foi ignorado (o rclone parado seguiria até o SIGKILL): ${stderr}`);
    assert.equal(code, 1, stderr);
    const calls = readFileSync(s.calls, "utf8");
    assert.ok(calls.lastIndexOf("start diaria-gdrive-bisync.timer") > calls.lastIndexOf("deletefile"), calls);
    assert.equal((calls.match(/deletefile/g) ?? []).length, 1, "nenhum bruto novo depois do sinal");
    const report = JSON.parse(readFileSync(join(s.sb, ".cache", "diaria", "video-bruto-archive", "last-report.json"), "utf8"));
    assert.ok(report.errors.some((e: string) => /SIGTERM/.test(e)), JSON.stringify(report.errors));
    assert.ok(
      BRUTOS_12603.some((p) => existsSync(join(s.drive, "261105", p)) && existsSync(join(s.local, "261105", p))),
      "o bruto que não começou segue no Drive e no espelho",
    );
    for (const p of BRUTOS_12603) {
      assert.ok(existsSync(join(s.drive, "261105", p)) || existsSync(join(s.archive, "261105", p)), `${p} nunca some dos dois lados`);
    }
  });
});

describe("bruto de outro dono guardado no arquivo (#12570)", posixOnly, () => {
  /** md5sum que registra cada chamada, para saber se a rodada recalculou. */
  const countingMd5 = (s: ReturnType<typeof sandbox>) => {
    const log = join(s.sb, "md5.log");
    const wrapper = join(s.bin, "md5sum-contado");
    writeFileSync(wrapper, `#!/bin/sh\necho "$1" >> "${log}"\nexec "${join(s.bin, "md5sum")}" "$1"\n`);
    chmodSync(wrapper, 0o755);
    s.cfg.md5sum = wrapper;
    return () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  };

  it("rodadas seguintes entram pela cópia do arquivo, gravam o MD5 conferido e param de recalcular; a dona apagando, a cópia fica", async () => {
    const s = sandbox({ lockedFiles: ["20261104_124252"] });
    const rel = "261105/20261104_124252.mp4";
    s.both(rel, "bruto-alheio");
    s.publish("261105");
    const md5Calls = countingMd5(s);
    const record = join(s.archive, `${rel}.md5.json`);

    const r1 = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual([r1.files[0].source, r1.files[0].status], ["espelho", "nao-apagado-sem-permissao"]);
    assert.ok(existsSync(join(s.archive, rel)) && existsSync(join(s.local, rel)));
    assert.ok(!existsSync(record), "cópia recém-copiada ainda não foi conferida: sem registro");

    const before2 = md5Calls().length;
    const r2 = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual([r2.files[0].source, r2.files[0].status], ["arquivo", "nao-apagado-sem-permissao"]);
    assert.deepEqual(md5Calls().slice(before2), [join(s.archive, rel)], "confere a cópia do arquivo uma vez");
    assert.ok(existsSync(record), "registro do MD5 gravado");
    assert.equal(reportFailed(r2), false);

    const before3 = md5Calls().length;
    const r3 = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual([r3.files[0].source, r3.files[0].status], ["arquivo", "nao-apagado-sem-permissao"]);
    assert.equal(md5Calls().length, before3, "sem recálculo do MD5");
    assert.equal((readFileSync(s.calls, "utf8").match(/rclone copyto/g) ?? []).length, 0, "nunca recopia do Drive");

    // A dona apaga do Drive e o bisync apaga o espelho: a cópia do arquivo é a que sobra.
    rmSync(join(s.drive, rel));
    rmSync(join(s.local, rel));
    const r4 = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r4.files.length, 0);
    assert.equal(readFileSync(join(s.archive, rel), "utf8"), "bruto-alheio");
  });

  it("cópia do arquivo mexida depois do registro: recalcula o MD5", async () => {
    const s = sandbox({ lockedFiles: ["20261104_124252"] });
    const rel = "261105/20261104_124252.mp4";
    s.both(rel, "bruto-alheio");
    s.publish("261105");
    const md5Calls = countingMd5(s);
    await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    // mesmo tamanho, outro conteúdo e outro mtime
    writeFileSync(join(s.archive, rel), "BRUTO-ALHEIO");
    utimesSync(join(s.archive, rel), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const before = md5Calls().length;
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.ok(md5Calls().length > before, "registro não vale mais: recalcula");
    assert.equal(r.files[0].status, "nao-apagado-sem-permissao");
    assert.equal(readFileSync(join(s.archive, rel), "utf8"), "bruto-alheio", "a cópia ruim foi trocada pela do espelho");
  });

  it("registro só vale com tamanho, mtime e MD5 do Drive iguais", async () => {
    const remote = { path: "a.mp4", size: 3, md5: "aa".repeat(16) };
    const rec = parseVerifiedRecord({ size: 3, mtimeMs: 10, md5: "AA".repeat(16) });
    assert.ok(rec);
    assert.equal(verifiedRecordTrusted(rec, { size: 3, mtimeMs: 10 }, remote), true);
    assert.equal(verifiedRecordTrusted(rec, { size: 3, mtimeMs: 11 }, remote), false);
    assert.equal(verifiedRecordTrusted(rec, { size: 4, mtimeMs: 10 }, remote), false);
    assert.equal(verifiedRecordTrusted(rec, { size: 3, mtimeMs: 10 }, { ...remote, md5: "bb".repeat(16) }), false, "a dona trocou o arquivo");
    assert.equal(verifiedRecordTrusted(rec, { size: 3, mtimeMs: 10 }, { ...remote, md5: null }), false);
    assert.equal(verifiedRecordTrusted(null, { size: 3, mtimeMs: 10 }, remote), false);
    assert.equal(parseVerifiedRecord({ size: 3, mtimeMs: 10, md5: "xyz" }), null);
    assert.equal(parseVerifiedRecord([]), null);
  });
});

describe("trava contra duas execuções (#12573)", posixOnly, () => {
  it("lock de PID vivo: a 2ª execução sai com erro sem tocar no timer nem no Drive", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    writeFileSync(s.cfg.lockPath, JSON.stringify({ pid: process.pid, startedAt: "x" }));
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true);
    assert.ok(r.errors.some((e) => /outra execução/.test(e)), JSON.stringify(r.errors));
    assert.ok(!existsSync(s.calls), "nenhuma chamada a rclone/systemctl");
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(existsSync(s.cfg.lockPath), "a trava alheia continua lá");
  });

  it("duas execuções ao mesmo tempo: só uma arquiva, o timer é parado e religado uma vez", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const [a, b] = await Promise.all([
      runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 }),
      runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 }),
    ]);
    const refused = [a, b].filter((r) => r.errors.some((e) => /outra execução/.test(e)));
    assert.equal(refused.length, 1);
    assert.equal(refused[0].files.length, 0);
    const calls = readFileSync(s.calls, "utf8");
    assert.equal((calls.match(/stop diaria-gdrive-bisync.timer/g) ?? []).length, 1);
    assert.equal((calls.match(/start diaria-gdrive-bisync.timer/g) ?? []).length, 1);
    assert.equal((calls.match(/deletefile/g) ?? []).length, 1);
    assert.ok(!existsSync(s.cfg.lockPath), "trava solta no fim");
  });

  it("lock de PID morto é retomado e solto no fim; dry-run não trava", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const dead = spawn("true");
    const deadPid = dead.pid!;
    await new Promise((r) => dead.on("exit", r));
    writeFileSync(s.cfg.lockPath, JSON.stringify({ pid: deadPid, startedAt: "x" }));
    const dry = await runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(dry), false);
    assert.equal(JSON.parse(readFileSync(s.cfg.lockPath, "utf8")).pid, deadPid, "dry-run não mexe na trava");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r.errors));
    assert.equal(r.files[0].status, "arquivado");
    assert.ok(!existsSync(s.cfg.lockPath));
  });

  it("trava é solta também quando a rodada falha", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: { ...s.cfg, mountpointCmd: ["false"] }, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true);
    assert.ok(!existsSync(s.cfg.lockPath));
  });

  it("runLockIsStale / parseRunLock", async () => {
    assert.equal(parseRunLock('{"pid":123,"startedAt":"x"}'), 123);
    assert.equal(parseRunLock("lixo"), null);
    assert.equal(parseRunLock('{"pid":-1}'), null);
    assert.equal(runLockIsStale(123, () => true), false);
    assert.equal(runLockIsStale(123, () => false), true);
    assert.equal(runLockIsStale(null, () => true), true, "trava ilegível é retomável");
  });

  it("acquireRunLock: segunda tentativa no mesmo processo é recusada até soltar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bruto-lock-"));
    const p = join(dir, "sub", "run.lock");
    const first = acquireRunLock(p);
    assert.ok("release" in first);
    assert.ok("error" in acquireRunLock(p));
    first.release();
    const again = acquireRunLock(p);
    assert.ok("release" in again);
    again.release();
    assert.ok(!existsSync(p));
  });
});

// ── #12789: pasta de vídeo sem espelho local (diaria-studio-video da diaria.editor) ──

describe("defaults sem espelho (#12789)", () => {
  it("aponta para gdrive-diaria:diaria-studio-video, sem espelho, e o env continua sobrepondo", () => {
    const d = defaultConfig({});
    assert.equal(d.remoteName, "gdrive-diaria:");
    assert.equal(d.remoteRoot, "gdrive-diaria:diaria-studio-video");
    assert.equal(d.localRoot, null);
    assert.equal(defaultConfig({ VIDEO_ARCHIVE_LOCAL_ROOT: "" }).localRoot, null, "vazio = sem espelho");
    const legacy = defaultConfig({
      VIDEO_ARCHIVE_REMOTE: "gdrive:",
      VIDEO_ARCHIVE_REMOTE_ROOT: "gdrive:Work/x/YouTube",
      VIDEO_ARCHIVE_LOCAL_ROOT: "/mnt/hd-sata/GoogleDrive/Work/x/YouTube",
    });
    assert.equal(legacy.remoteName, "gdrive:");
    assert.equal(legacy.remoteRoot, "gdrive:Work/x/YouTube");
    assert.equal(legacy.localRoot, "/mnt/hd-sata/GoogleDrive/Work/x/YouTube");
  });

  it("espelho sem a origem explícita é recusado (env sobrado do espelho antigo não confere contra a pasta nova)", () => {
    assert.throws(
      () => defaultConfig({ VIDEO_ARCHIVE_LOCAL_ROOT: "/mnt/hd-sata/GoogleDrive/Work/x/YouTube" }),
      /VIDEO_ARCHIVE_REMOTE_ROOT/,
    );
    assert.throws(
      () => defaultConfig({ VIDEO_ARCHIVE_REMOTE: "gdrive:", VIDEO_ARCHIVE_LOCAL_ROOT: "/mnt/x" }),
      /VIDEO_ARCHIVE_REMOTE_ROOT/,
    );
  });

  it("parseRcloneLsjsonDirs pega só pastas de 1º nível, ordenadas; JSON ilegível lança", () => {
    const text = JSON.stringify([
      { Path: "261109-10", IsDir: true, Size: -1 },
      { Path: "261105", IsDir: true, Size: -1 },
      { Path: "261105/Brutos", IsDir: true, Size: -1 },
      { Path: "solto.mp4", IsDir: false, Size: 3 },
    ]);
    assert.deepEqual(parseRcloneLsjsonDirs(text), { names: ["261105", "261109-10"], duplicates: [] });
    assert.throws(() => parseRcloneLsjsonDirs("{}"));
    assert.throws(() => parseRcloneLsjsonDirs("não é json"));
  });
});

describe("runArchive sem espelho (#12789)", posixOnly, () => {
  /** Só o "Drive" tem o bruto; nenhum espelho. */
  const noMirror = (opts: Parameters<typeof sandbox>[0] = {}) => {
    const s = sandbox(opts);
    rmSync(s.local, { recursive: true, force: true });
    return { ...s, cfg: { ...s.cfg, localRoot: null } };
  };
  const callLines = (s: { calls: string }) => (existsSync(s.calls) ? readFileSync(s.calls, "utf8").split("\n").filter(Boolean) : []);

  it("--apply lista as pastas pelo remote, baixa, confere e apaga do Drive, sem pausar bisync nenhum", async () => {
    const s = noMirror();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto-1");
    s.put(s.drive, "261105/Brutos/20261103_000000.mp4", "bruto-2");
    s.put(s.drive, "261105/Final/export.mp4", "final");
    s.put(s.drive, "261109-10/20261109_150417.mp4", "nao-publicado");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    assert.deepEqual(r.folders.map((f) => [f.name, f.eligible]), [["261105", true], ["261109-10", false]]);
    assert.deepEqual(r.files.map((f) => [f.path, f.source, f.status]).sort(), [
      ["20261104_124252.mp4", "download", "arquivado"],
      ["Brutos/20261103_000000.mp4", "download", "arquivado"],
    ]);
    assert.equal(readFileSync(join(s.archive, "261105/20261104_124252.mp4"), "utf8"), "bruto-1");
    assert.equal(readFileSync(join(s.archive, "261105/Brutos/20261103_000000.mp4"), "utf8"), "bruto-2");
    assert.ok(!existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!existsSync(join(s.archive, "261105/20261104_124252.mp4.partial")));
    assert.ok(existsSync(join(s.drive, "261105/Final/export.mp4")));
    assert.ok(existsSync(join(s.drive, "261109-10/20261109_150417.mp4")));
    assert.ok(!existsSync(s.local), "nenhum espelho criado");
    const calls = callLines(s);
    assert.ok(calls.some((l) => /^rclone lsjson --dirs-only --drive-skip-shortcuts remote:$/.test(l)), calls.join("\n"));
    assert.ok(!calls.some((l) => l.startsWith("systemctl")), "sem espelho, nenhum bisync a pausar");
    // download antes do deletefile
    const copy = calls.findIndex((l) => l.startsWith("rclone copyto") && l.includes("20261104_124252"));
    const del = calls.findIndex((l) => l.startsWith("rclone deletefile") && l.includes("20261104_124252"));
    assert.ok(copy >= 0 && del > copy, calls.join("\n"));
  });

  it("MD5 divergente depois do download: recusa apagar e a rodada falha", async () => {
    const s = noMirror({ badMd5: ["20261104_124252.mp4"] });
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "download");
    assert.equal(r.files[0].status, "falha-conferencia");
    assert.equal(r.files[0].verify, "md5-diverge");
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")), "continua no Drive");
    assert.ok(!callLines(s).some((l) => l.startsWith("rclone deletefile")), "nenhum deletefile");
  });

  it("dry-run lista pelo remote e não baixa nem apaga nada", async () => {
    const s = noMirror();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(r.files.map((f) => [f.path, f.status]), [["20261104_124252.mp4", "sairia"]]);
    const calls = callLines(s);
    assert.ok(!calls.some((l) => /copyto|deletefile|^systemctl/.test(l)), calls.join("\n"));
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("listagem das pastas no remote falha: erro, nada feito", async () => {
    const s = noMirror();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: { ...s.cfg, remoteRoot: "remote:nao-existe" }, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true);
    assert.ok(r.errors.some((e) => /dirs-only falhou/.test(e)), JSON.stringify(r.errors));
    assert.deepEqual(r.files, []);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!callLines(s).some((l) => /copyto|deletefile|^systemctl/.test(l)));
  });

  it("retomada sem espelho: cópia conferida já no arquivo não é baixada de novo", async () => {
    const s = noMirror();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto");
    s.put(s.archive, "261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "arquivo");
    assert.equal(r.files[0].status, "arquivado");
    assert.ok(!callLines(s).some((l) => l.startsWith("rclone copyto")));
  });
});

// ── #12789: regressões do review da PR #12796 ──────────────────────────────

/** Cópias guardadas como `{nome}.conflito-*` na pasta do arquivo. */
const conflicts = (dir: string, name: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${name}.conflito-`)) : [];

describe("regressões do review da PR #12796 (#12789)", () => {
  it("parseRcloneLsjsonDirs devolve os nomes de pasta repetidos", () => {
    const text = JSON.stringify([
      { Path: "261105", IsDir: true, Size: -1 },
      { Path: "261106", IsDir: true, Size: -1 },
      { Path: "261105", IsDir: true, Size: -1 },
    ]);
    assert.deepEqual(parseRcloneLsjsonDirs(text), { names: ["261105", "261106"], duplicates: ["261105"] });
  });

  it("env vazio conta como ausente; origem sem remote: é recusada", () => {
    const d = defaultConfig({ VIDEO_ARCHIVE_REMOTE: "", VIDEO_ARCHIVE_REMOTE_ROOT: "" });
    assert.equal(d.remoteName, "gdrive-diaria:");
    assert.equal(d.remoteRoot, "gdrive-diaria:diaria-studio-video");
    assert.throws(() => defaultConfig({ VIDEO_ARCHIVE_REMOTE_ROOT: "/mnt/hd-sata/video" }), /remote:/);
    assert.throws(() => defaultConfig({ VIDEO_ARCHIVE_REMOTE: "gdrive-diaria" }), /remote:/);
  });

  it("setAsideConflict move a cópia existente (e o registro de MD5 dela) e não inventa nada quando não há cópia", () => {
    const dir = mkdtempSync(join(tmpdir(), "bruto-conflito-"));
    const p = join(dir, "20261104_124252.mp4");
    assert.deepEqual(setAsideConflict(p), { moved: null });
    writeFileSync(p, "velho");
    writeFileSync(`${p}.md5.json`, "{}");
    const r = setAsideConflict(p, new Date("2026-11-14T06:00:00.123Z"));
    assert.ok("moved" in r && r.moved === `${p}.conflito-2026-11-14T06-00-00-123Z`, JSON.stringify(r));
    assert.equal(readFileSync(`${p}.conflito-2026-11-14T06-00-00-123Z`, "utf8"), "velho");
    assert.ok(!existsSync(p));
    assert.ok(!existsSync(`${p}.md5.json`), "o registro era da cópia que saiu");
  });
});

describe("runArchive: regressões do review da PR #12796 (#12789)", posixOnly, () => {
  const noMirror = (opts: Parameters<typeof sandbox>[0] = {}) => {
    const s = sandbox(opts);
    rmSync(s.local, { recursive: true, force: true });
    return { ...s, cfg: { ...s.cfg, localRoot: null } };
  };
  const callLines = (s: { calls: string }) => (existsSync(s.calls) ? readFileSync(s.calls, "utf8").split("\n").filter(Boolean) : []);

  it("pasta de edição duplicada no Drive: erro dela, nada baixado nem apagado dela, as outras seguem", async () => {
    const s = noMirror({ dupDirs: ["261104"] });
    s.put(s.drive, "261104/20261103_124252.mp4", "bruto-dup");
    s.put(s.drive, "261105/20261104_101010.mp4", "bruto-ok");
    s.publish("261104");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true, "o exit da rodada sinaliza o erro");
    assert.ok(r.errors.some((e) => /^261104: .*duplicado/.test(e)), JSON.stringify(r.errors));
    assert.deepEqual(r.folders.map((f) => f.name), ["261105"]);
    assert.deepEqual(r.files.map((f) => [f.folder, f.status]), [["261105", "arquivado"]]);
    assert.ok(existsSync(join(s.drive, "261104/20261103_124252.mp4")), "a duplicada fica no Drive");
    assert.ok(!existsSync(join(s.drive, "261105/20261104_101010.mp4")), "a outra edição sai");
    const calls = callLines(s);
    assert.ok(!calls.some((l) => l.includes("remote:261104") && /copyto|deletefile|lsjson -R/.test(l)), calls.join("\n"));
  });

  it("pasta duplicada fora do --only não acusa nada", async () => {
    const s = noMirror({ dupDirs: ["261104"] });
    s.put(s.drive, "261104/20261103_124252.mp4", "bruto-dup");
    s.put(s.drive, "261105/20261104_101010.mp4", "bruto-ok");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14, only: new Set(["261105"]) });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
  });

  it("dry-run também acusa a pasta duplicada e não a lista", async () => {
    const s = noMirror({ dupDirs: ["261104"] });
    s.put(s.drive, "261104/20261103_124252.mp4", "bruto-dup");
    s.publish("261104");
    const r = await runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true);
    assert.deepEqual(r.files, []);
  });

  it("listagens e deletefile não seguem atalhos do Drive", async () => {
    const s = noMirror();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    const calls = callLines(s).filter((l) => /^rclone (lsjson|deletefile)/.test(l));
    assert.ok(calls.some((l) => l.startsWith("rclone deletefile")), calls.join("\n"));
    assert.ok(calls.length >= 3 && calls.every((l) => l.includes("--drive-skip-shortcuts")), calls.join("\n"));
  });

  it("download que falha sem espelho: falha-download, sem .partial, nada apagado, a rodada falha", async () => {
    const s = noMirror({ failCopyto: true });
    s.put(s.drive, "261105/20261104_124252.mp4", "so-no-drive");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "download");
    assert.equal(r.files[0].status, "falha-download");
    assert.equal(reportFailed(r), true);
    assert.ok(!existsSync(join(s.archive, "261105/20261104_124252.mp4.partial")));
    assert.ok(!existsSync(join(s.archive, "261105/20261104_124252.mp4")));
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!callLines(s).some((l) => l.startsWith("rclone deletefile")));
  });

  it("cópia homônima diferente no arquivo, sem espelho: vai para .conflito-*, não é sobrescrita", async () => {
    const s = noMirror();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto-novo");
    s.put(s.archive, "261105/20261104_124252.mp4", "outro-bruto-da-pasta-antiga");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    assert.equal(r.files[0].source, "download");
    assert.equal(r.files[0].status, "arquivado");
    assert.match(r.files[0].detail ?? "", /conflito-/);
    const dir = join(s.archive, "261105");
    assert.equal(readFileSync(join(dir, "20261104_124252.mp4"), "utf8"), "bruto-novo");
    const c = conflicts(dir, "20261104_124252.mp4");
    assert.equal(c.length, 1, readdirSync(dir).join(","));
    assert.equal(readFileSync(join(dir, c[0]), "utf8"), "outro-bruto-da-pasta-antiga");
  });

  it("cópia homônima de mesmo tamanho e MD5 diferente, com espelho: vai para .conflito-* antes do rename", async () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto-1");
    s.put(s.archive, "261105/20261104_124252.mp4", "bruto-X");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "espelho");
    assert.equal(r.files[0].status, "arquivado");
    const dir = join(s.archive, "261105");
    assert.equal(readFileSync(join(dir, "20261104_124252.mp4"), "utf8"), "bruto-1");
    const c = conflicts(dir, "20261104_124252.mp4");
    assert.equal(c.length, 1);
    assert.equal(readFileSync(join(dir, c[0]), "utf8"), "bruto-X");
  });

  it("cópia que confere com o Drive não vira conflito", async () => {
    const s = noMirror();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto");
    s.put(s.archive, "261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = await runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "arquivo");
    assert.deepEqual(conflicts(join(s.archive, "261105"), "20261104_124252.mp4"), []);
  });
});
