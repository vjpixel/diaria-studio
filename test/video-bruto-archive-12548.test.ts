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
  brutoRefKey,
  decideFolder,
  duplicatePaths,
  editionsOfFolder,
  isBrutoFile,
  montageSourceRefs,
  parseMd5sumLine,
  parseRcloneLsjson,
  referencingEditions,
  verifyCopy,
} from "../scripts/lib/diaria/video-bruto-archive.ts";
import { bisyncIdle, defaultConfig, isPermissionError, reportFailed, runArchive } from "../scripts/archive-video-brutos.ts";

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
    assert.equal(verifyCopy(remote, { size: 3, md5: null }), "md5-local-indisponivel");
    assert.equal(verifyCopy({ ...remote, md5: null }, { size: 3, md5: "aa".repeat(16) }), "sem-md5-no-drive");
  });

  it("reconhece a recusa por permissão do Drive", () => {
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

  // ── regressões do review da PR #12567 ──

  it("deletefile com erro mas o Drive apagou: relê, conta como arquivado e a cópia NÃO volta ao espelho", () => {
    const s = sandbox({ deleteMode: "apagou-mas-erro" });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    assert.ok(existsSync(join(s.archive, "261105/20261104_124252.mp4")), "cópia conferida fica no arquivo");
    assert.ok(!existsSync(join(s.local, "261105/20261104_124252.mp4")), "não volta ao espelho (o bisync a apagaria)");
  });

  it("deletefile com erro e o arquivo continua no Drive: devolve ao espelho e falha", () => {
    const s = sandbox({ deleteMode: "erro" });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-apagar");
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.local, "261105/20261104_124252.mp4")));
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("403 de rate limit é falha, não 'sem permissão'", () => {
    const s = sandbox({ deleteMode: "ratelimit" });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-apagar");
    assert.equal(reportFailed(r), true);
  });

  it("nome repetido no Drive: não apaga nenhum dos dois", () => {
    const s = sandbox({ dupFirst: true });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.ok(r.files.every((f) => f.status === "nome-duplicado-no-drive"));
    assert.equal(reportFailed(r), true);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
    assert.ok(!readFileSync(s.calls, "utf8").includes("deletefile"));
  });

  it("download que falha não deixa .partial nem apaga nada", () => {
    const s = sandbox({ failCopyto: true });
    s.put(s.drive, "261105/20261104_124252.mp4", "so-no-drive");
    mkdirSync(join(s.local, "261105"), { recursive: true });
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "falha-download");
    assert.ok(!existsSync(join(s.archive, "261105/20261104_124252.mp4.partial")));
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("espera a rodada do bisync em curso e só então lista e apaga", () => {
    const s = sandbox({ serviceBusyPolls: 2 });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    const calls = readFileSync(s.calls, "utf8").split("\n");
    const lastPoll = calls.map((l, i) => (l.includes("is-active diaria-gdrive-bisync.service") ? i : -1)).filter((i) => i >= 0).pop()!;
    const firstLsjson = calls.findIndex((l) => l.startsWith("rclone lsjson -R"));
    assert.ok(lastPoll < firstLsjson, "a listagem do Drive vem depois da pausa");
  });

  for (const busyState of ["activating", ""]) {
    it(`bisync que não termina ("${busyState || "vazio"}"): não apaga nada, religa o timer e falha`, () => {
      const s = sandbox({ serviceBusyPolls: -1, busyState });
      s.both("261105/20261104_124252.mp4", "bruto");
      s.publish("261105");
      const r = runArchive({ cfg: { ...s.cfg, waitMinutes: 0 }, apply: true, today: TODAY, unpublishedMaxDays: 14 });
      assert.equal(reportFailed(r), true);
      const calls = readFileSync(s.calls, "utf8");
      assert.ok(!calls.includes("deletefile") && !calls.includes("lsjson"));
      assert.match(calls, /start diaria-gdrive-bisync.timer/);
      assert.ok(existsSync(join(s.local, "261105/20261104_124252.mp4")));
    });
  }

  it("timer já parado fica parado no fim", () => {
    const s = sandbox({ timerActive: false });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    const calls = readFileSync(s.calls, "utf8");
    assert.ok(!calls.includes("stop diaria-gdrive-bisync.timer") && !calls.includes("start diaria-gdrive-bisync.timer"));
  });

  it("falha ao religar o timer falha a rodada", () => {
    const s = sandbox({ failStart: true });
    s.both("261105/20261104_124252.mp4", "bruto");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    assert.equal(reportFailed(r), true);
  });

  it("retomada: cópia já no arquivo com o tamanho do Drive é conferida e o Drive é apagado", () => {
    const s = sandbox();
    s.put(s.drive, "261105/20261104_124252.mp4", "bruto");
    s.put(s.archive, "261105/20261104_124252.mp4", "bruto");
    mkdirSync(join(s.local, "261105"), { recursive: true });
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "arquivo");
    assert.equal(r.files[0].status, "arquivado");
    assert.ok(!existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });

  it("cópia truncada no arquivo não trava: usa o espelho e a sobrescreve", () => {
    const s = sandbox();
    s.both("261105/20261104_124252.mp4", "bruto-inteiro");
    s.put(s.archive, "261105/20261104_124252.mp4", "bru");
    s.publish("261105");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].source, "espelho");
    assert.equal(r.files[0].status, "arquivado");
    assert.equal(readFileSync(join(s.archive, "261105/20261104_124252.mp4"), "utf8"), "bruto-inteiro");
  });

  it("pasta AAMMDD-DD entra com as duas edições publicadas", () => {
    const s = sandbox();
    s.both("261103-04/20261102_094530.mp4", "bruto");
    s.publish("261103");
    s.publish("261104");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(r.files[0].status, "arquivado");
    assert.ok(existsSync(join(s.archive, "261103-04/20261102_094530.mp4")));
  });

  it("sem data/editions: só a pasta além do teto sai", () => {
    const s = sandbox();
    s.both("261021/WIN_20261020_21_24_22_Pro.mp4", "velho");
    s.both("261105/20261104_124252.mp4", "novo");
    const r = runArchive({ cfg: { ...s.cfg, dataRoot: join(s.sb, "sem-data") }, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(r.files.map((f) => [f.folder, f.status]), [["261021", "arquivado"]]);
    assert.ok(existsSync(join(s.drive, "261105/20261104_124252.mp4")));
  });
});

describe("regressões puras do review (#12567)", () => {
  it("PXL_ com milissegundos é bruto", () => {
    assert.equal(isBrutoFile("PXL_20261104_124252345.mp4"), true);
  });
  it("rate limit e cota nunca são 'sem permissão'", () => {
    assert.equal(isPermissionError("googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded"), false);
    assert.equal(isPermissionError("googleapi: Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded"), false);
    assert.equal(isPermissionError("googleapi: Error 403: forbidden"), false);
  });
  it("md5sum que falhou não é 'conteúdo diferente'", () => {
    assert.equal(verifyCopy({ path: "a", size: 1, md5: "aa".repeat(16) }, { size: 1, md5: null }), "md5-local-indisponivel");
  });
  it("duplicatePaths acha o nome repetido", () => {
    const f = (path: string) => ({ path, size: 1, md5: null });
    assert.deepEqual([...duplicatePaths([f("a"), f("b"), f("a")])], ["a"]);
  });
  it("bisyncIdle só libera unit parada", () => {
    assert.equal(bisyncIdle("inactive"), true);
    assert.equal(bisyncIdle("failed"), true);
    for (const s of ["", "active", "activating", "refreshing", "deactivating"]) assert.equal(bisyncIdle(s), false, s);
  });
  it("env numérica inválida falha cedo", () => {
    assert.throws(() => defaultConfig({ VIDEO_ARCHIVE_WAIT_MINUTES: "abc" }));
  });
});

// ── #12602: bruto que outra edição ou o Short ainda usa ─────────────────────

describe("idade mínima da pasta publicada (#12602)", () => {
  it("horizontal publicado há menos de 4 dias fica (Short e cortes saem nos dias seguintes)", () => {
    // TODAY = 261109; 261106 (sexta) tem 3 dias: o corte de terça ainda não saiu.
    const d = decideFolder({ name: "261106", published: { "261106": true } }, TODAY);
    assert.equal(d.eligible, false);
    assert.equal(d.reason, "publicado-recente");
    assert.equal(decideFolder({ name: "261105", published: { "261105": true } }, TODAY).eligible, true);
    assert.equal(decideFolder({ name: "261106", published: { "261106": true } }, TODAY, 14, 3).eligible, true);
  });
});

describe("referências do source.json (#12602)", () => {
  it("chave é o nome do arquivo, em qualquer separador", () => {
    assert.equal(brutoRefKey("G:/Meu Drive/Work/Mentoria Fluxo/VTSD/YouTube/261106/20261106_101010.mp4"), "20261106_101010.mp4");
    assert.equal(brutoRefKey("G:\\Meu Drive\\YouTube\\261106\\20261106_101010.MP4"), "20261106_101010.mp4");
    assert.equal(brutoRefKey("Brutos/20261103_000000.mp4"), "20261103_000000.mp4");
  });

  it("lê path e files[].path; formato estranho é null", () => {
    assert.deepEqual(montageSourceRefs({ path: "a/x.mp4" }), ["a/x.mp4"]);
    assert.deepEqual(montageSourceRefs({ path: "a/x.mp4", files: [{ path: "a/x.mp4" }, { path: "b/y.mp4" }] }), ["a/x.mp4", "a/x.mp4", "b/y.mp4"]);
    assert.equal(montageSourceRefs({}), null);
    assert.equal(montageSourceRefs({ files: "x" }), null);
    assert.equal(montageSourceRefs({ path: "a", files: [{ id: "sem-path" }] }), null);
    assert.equal(montageSourceRefs([]), null);
  });

  it("referencingEditions casa pelo nome", () => {
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

  it("bruto da edição seguinte guardado na pasta publicada fica no Drive até ela sair; o resto sai", () => {
    const s = sandbox();
    s.both("261105/20261105_090000.mp4", "bruto-da-261105");
    s.both("261105/20261105_100000.mp4", "bruto-da-261110");
    s.publish("261105");
    montage(s, "261105", { path: "G:/Meu Drive/Work/Mentoria Fluxo/VTSD/YouTube/261105/20261105_090000.mp4" });
    montage(s, "261110", {
      path: "G:/Meu Drive/Work/Mentoria Fluxo/VTSD/YouTube/261105/20261105_100000.mp4",
      files: [{ id: "20261105_100000", path: "G:\\Meu Drive\\Work\\Mentoria Fluxo\\VTSD\\YouTube\\261105\\20261105_100000.mp4" }],
    });
    const dry = runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.deepEqual(
      dry.files.map((f) => [f.path, f.status]),
      [
        ["20261105_090000.mp4", "sairia"],
        ["20261105_100000.mp4", "em-uso-por-outra-edicao"],
      ],
    );
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), false, JSON.stringify(r, null, 2));
    const used = r.files.find((f) => f.path === "20261105_100000.mp4")!;
    assert.equal(used.status, "em-uso-por-outra-edicao");
    assert.match(used.detail ?? "", /261110/);
    assert.ok(existsSync(join(s.drive, "261105/20261105_100000.mp4")), "bruto da 261110 continua no Drive");
    assert.ok(existsSync(join(s.local, "261105/20261105_100000.mp4")), "e no espelho");
    assert.ok(!existsSync(join(s.drive, "261105/20261105_090000.mp4")), "o bruto da própria 261105 sai");
    assert.equal(r.files.find((f) => f.path === "20261105_090000.mp4")!.status, "arquivado");
  });

  it("edição que referencia o bruto, publicada mas recente, ainda segura; passada a idade mínima, não segura mais", () => {
    const s = sandbox();
    s.both("261105/20261105_100000.mp4", "bruto");
    s.publish("261105");
    s.publish("261107");
    montage(s, "261107", { path: "/x/261105/20261105_100000.mp4" });
    const held = runArchive({ cfg: s.cfg, apply: false, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(held.files[0].status, "em-uso-por-outra-edicao");
    const later = runArchive({ cfg: s.cfg, apply: false, today: new Date("2026-11-12T00:00:00Z"), unpublishedMaxDays: 14 });
    assert.equal(later.files[0].status, "sairia", "261107 com 5 dias já sairia: não segura");
  });

  it("source.json ilegível de edição em uso: erro e nada sai do Drive", () => {
    const s = sandbox();
    s.both("261105/20261105_090000.mp4", "bruto");
    s.publish("261105");
    montage(s, "261110", "{ quebrado");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
    assert.equal(reportFailed(r), true);
    assert.match(r.errors.join("\n"), /261110.*source\.json ilegível/);
    assert.ok(existsSync(join(s.drive, "261105/20261105_090000.mp4")));
    assert.ok(!existsSync(s.calls) || !readFileSync(s.calls, "utf8").includes("deletefile"));
  });

  it("horizontal publicado ontem: a pasta fica (o Short da vertical nativa sai no dia útil seguinte)", () => {
    const s = sandbox();
    s.both("261108/20261108_090000.mp4", "bruto");
    s.publish("261108");
    const r = runArchive({ cfg: s.cfg, apply: true, today: TODAY, unpublishedMaxDays: 14 });
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
