/**
 * Lote fetch-drive-video (rodada overnight 261029):
 * - #11577: a cópia que o fetch promoveu para `Final/` escondia uma exportação
 *   mais nova em `Editados/` (V6 depois do V5 promovido) — a próxima rodada
 *   publicava a versão velha.
 * - #11428: `Final/` só com o horizontal barrava `Editado/` para o Instagram e
 *   o corte `_Instagram_` certo virava `none`.
 * - #11423: com `Final/` só com o horizontal, um vertical de rascunho sem
 *   sufixo em `Editado/` virava o vertical publicado (`outras-redes`).
 * Sem rede (Drive mockado).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROMOTED_FROM_PROPERTY,
  isVerticalCutCandidate,
  selectDriveVideo,
  type DriveVideoFile,
} from "../scripts/lib/diaria/drive-video-source.ts";
import {
  runFetchDriveVideo,
  type DriveFetchInit,
  type FetchDriveVideoDeps,
  type FetchDriveVideoInput,
} from "../scripts/fetch-drive-video.ts";

const NOW = new Date("2026-10-29T23:00:00Z");
const FOLDER = "application/vnd.google-apps.folder";
const EDITION_ID = "ed";

const file = (id: string, name: string, extra: Partial<DriveVideoFile> = {}): DriveVideoFile => ({
  id,
  name,
  mimeType: "video/mp4",
  createdTime: "2026-10-29T20:00:00Z",
  modifiedTime: "2026-10-29T20:00:00Z",
  size: "5",
  ...extra,
});
const HORIZ = { videoMediaMetadata: { width: 1920, height: 1080 } };
const VERT = { videoMediaMetadata: { width: 1080, height: 1920 } };

const YT = (n: number, extra: Partial<DriveVideoFile> = {}) => file(`yt${n}`, `Diaria comentada_Youtube_V${n}.mp4`, { ...HORIZ, ...extra });
const OR = (n: number, extra: Partial<DriveVideoFile> = {}) => file(`or${n}`, `Diaria comentada_Outras redes_V${n}.mp4`, { ...VERT, ...extra });
const copyOf = (orig: DriveVideoFile, extra: Partial<DriveVideoFile> = {}): DriveVideoFile => ({
  ...orig,
  id: `${orig.id}-copy`,
  appProperties: { [PROMOTED_FROM_PROPERTY]: orig.id },
  ...extra,
});

function mockDrive(subfolders: Record<string, DriveVideoFile[]>) {
  const posts: { url: string; body: any }[] = [];
  const listed: string[] = [];
  const idOf = (name: string) => `sub-${name.replace(/\W+/g, "_")}`;
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url: string, init?: DriveFetchInit) {
      const u = new URL(url);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(init.body ?? "{}") });
        if (u.pathname.endsWith("/copy")) return Response.json({ id: `copy-of-${u.pathname.split("/").at(-2)}` });
        return Response.json({ id: "new-final" });
      }
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        for (const [name, files] of Object.entries(subfolders)) {
          if (q.includes(`'${idOf(name)}'`)) {
            listed.push(name);
            return Response.json({ files });
          }
        }
        if (q.includes(`'${EDITION_ID}'`)) {
          return Response.json({ files: Object.keys(subfolders).map((name) => ({ id: idOf(name), name, mimeType: FOLDER })) });
        }
        return Response.json({ files: [{ id: EDITION_ID, name: "261030", mimeType: FOLDER }] });
      }
      return Response.json({ id: "root", mimeType: FOLDER });
    },
  };
  return { deps, posts, listed, idOf };
}

async function run(subfolders: Record<string, DriveVideoFile[]>, opts: Partial<FetchDriveVideoInput> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fdv-batch-"));
  const logs: string[] = [];
  try {
    const drive = mockDrive(subfolders);
    const out = await runFetchDriveVideo(
      drive.deps,
      {
        aammdd: "261030",
        orientation: "horizontal",
        folderId: "root",
        editionDir: dir,
        now: NOW,
        windowHours: 36,
        dryRun: true,
        force: false,
        ...opts,
      },
      (l) => logs.push(l),
    );
    return { out, logs, posts: drive.posts, listed: drive.listed, idOf: drive.idOf };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- #11577 ----------

test("#11577: Final/{V5 promovido} + Editados/{V5, V6} escolhe o V6 e o promove", async () => {
  const { out, posts, listed, idOf, logs } = await run(
    { Final: [copyOf(YT(5))], Editados: [YT(5), YT(6, { modifiedTime: "2026-10-29T22:00:00Z" })] },
    { promote: true },
  );
  assert.equal(out.output.action, "dry-run", JSON.stringify(out.output));
  if (out.output.action === "dry-run") {
    assert.equal(out.output.file.id, "yt6");
    assert.match(out.output.premise ?? "", /V6/);
    assert.equal(out.output.promoted?.status, "copied");
  }
  assert.deepEqual(listed, ["Final", "Editados"], "Editados/ é listada mesmo com candidato em Final/");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/files\/yt6\/copy\?/);
  assert.deepEqual(posts[0].body.parents, [idOf("Final")]);
  assert.ok(logs.some((l) => /cópia promovida/.test(l)), logs.join("\n"));
});

test("#11577: Final/{V5 promovido} + Editados/{V5} mantém a cópia, sem nova promoção", async () => {
  const { out, posts } = await run({ Final: [copyOf(YT(5))], Editados: [YT(4), YT(5)] }, { promote: true });
  assert.equal(out.output.action, "dry-run", JSON.stringify(out.output));
  if (out.output.action === "dry-run") {
    assert.equal(out.output.file.id, "yt5-copy");
    assert.equal(out.output.promoted, undefined);
  }
  assert.equal(posts.length, 0);
});

test("#11577: depois de promover o V6, Final/{cópia V5, cópia V6} não é ambíguo — vale a cópia V6", async () => {
  const { out, posts } = await run(
    { Final: [copyOf(YT(5)), copyOf(YT(6))], Editados: [YT(5), YT(6)] },
    { promote: true },
  );
  assert.equal(out.output.action, "dry-run", JSON.stringify(out.output));
  if (out.output.action === "dry-run") assert.equal(out.output.file.id, "yt6-copy");
  assert.equal(posts.length, 0);
});

test("#11577: arquivo do editor em Final/ ao lado da cópia promovida segue needs-editor", async () => {
  const { out } = await run({ Final: [copyOf(YT(5)), YT(7, { id: "manual" })], Editados: [YT(5)] });
  assert.equal(out.output.action, "needs-editor", JSON.stringify(out.output));
});

test("#11577 (vertical): cópia promovida do Outras redes V1 cede ao V2 de Editados/", async () => {
  const { out } = await run(
    { Final: [copyOf(OR(1))], Editados: [OR(1), OR(2)] },
    { orientation: "vertical", target: "outras-redes" },
  );
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "or2");
});

test("#11577: Final/ só com arquivo do editor (sem cópia) não lista Editados/", async () => {
  const { out, listed } = await run({ Final: [YT(3)], Editados: [YT(9)] });
  assert.equal(out.output.action, "dry-run");
  if (out.output.action === "dry-run") assert.equal(out.output.file.id, "yt3");
  // #11542: Editados/ é listada só para achar o Still da capa; o vídeo continua vindo de Final/.
  assert.deepEqual(listed, ["Final", "Editados"]);
  if (out.output.action === "dry-run") assert.deepEqual(out.output.final_folder_ids?.length, 1);
});

// ---------- #11428 ----------

test("isVerticalCutCandidate: sufixo vertical ou proporção vertical/desconhecida; _Youtube_ e horizontal não", () => {
  assert.equal(isVerticalCutCandidate(YT(3)), false);
  assert.equal(isVerticalCutCandidate(file("h", "bruto.mp4", HORIZ)), false);
  assert.equal(isVerticalCutCandidate(OR(3)), true);
  assert.equal(isVerticalCutCandidate(file("ig", "Diaria comentada_Instagram_V1.mp4")), true);
  assert.equal(isVerticalCutCandidate(file("v", "corte.mp4", VERT)), true);
  assert.equal(isVerticalCutCandidate(file("u", "corte.mp4")), true, "proporção desconhecida conta (conservador)");
  assert.equal(isVerticalCutCandidate(file("j", "Still.jpg", { mimeType: "image/jpeg" })), false);
});

test("#11428: --target instagram com Final/ só com o horizontal desce em Editado/ e prefere _Outras redes_", async () => {
  const IG = file("ig", "Diaria comentada_Instagram_V2.mp4", VERT);
  const { out, listed } = await run(
    { Final: [YT(3)], Editado: [OR(2), IG] },
    { orientation: "vertical", target: "instagram" },
  );
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "or2");
  assert.deepEqual(listed, ["Final", "Editado"]);
});

test("#11428: Final/ com o vertical genérico do editor ainda barra Editado/ para o Instagram (#11419 preservado)", async () => {
  const { out, listed } = await run(
    { Final: [YT(3), OR(3)], Editado: [file("ig", "Diaria comentada_Instagram_V2.mp4", VERT)] },
    { orientation: "vertical", target: "instagram" },
  );
  // O _Instagram_ de Editado/ não vira o vídeo (#11419); a pasta só é listada atrás do Still (#11542).
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "or3");
  assert.deepEqual(listed, ["Final", "Editado"]);
});

// ---------- #11423 ----------

test("#11423: --target outras-redes com Final/ só com o horizontal não publica o rascunho sem sufixo de Editado/", async () => {
  const { out, listed } = await run(
    { Final: [YT(3)], Editado: [file("draft", "rascunho vertical.mp4", VERT)] },
    { orientation: "vertical", target: "outras-redes" },
  );
  assert.deepEqual(listed, ["Final", "Editado"]);
  assert.equal(out.output.action, "none", JSON.stringify(out.output));
});

test("#11423: com o sufixo _Outras redes_ em Editado/ o vertical é encontrado", async () => {
  const { out } = await run(
    { Final: [YT(3)], Editado: [file("draft", "rascunho vertical.mp4", VERT), OR(4)] },
    { orientation: "vertical", target: "outras-redes" },
  );
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "or4");
});

test("#11423: vertical sem sufixo em Final/ (não Editados/) continua valendo pela proporção", () => {
  const sel = selectDriveVideo([{ ...file("v", "corte.mp4", VERT), scope: "final-folder" }], {
    orientation: "vertical",
    now: NOW,
    editionFolderPresent: true,
  });
  assert.equal(sel.kind, "found");
});
