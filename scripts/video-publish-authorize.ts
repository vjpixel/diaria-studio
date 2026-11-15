#!/usr/bin/env node
/**
 * scripts/video-publish-authorize.ts (#12654, caminho A)
 *
 * O coordenador da `/diaria-publica` registra aqui, de forma durável, o que a
 * conversa decidiu sobre a publicação dos vídeos da edição. O registro é
 * `_internal/video-publish-authorizations.json`; a lógica, em
 * `scripts/lib/diaria/video-publish-authorization.ts`.
 *
 * Uso:
 *   npx tsx scripts/video-publish-authorize.ts grant AAMMDD --part horizontal|vertical \
 *       --plan-sha256 HASH --confirmation "texto da resposta do editor" [--only d1,d2]
 *       [--override-uncertain "o que o editor conferiu na conta"] [--replace-scheduled] [--edition-dir DIR]
 *   npx tsx scripts/video-publish-authorize.ts invalidate AAMMDD --part horizontal|vertical|all --reason "..." [--edition-dir DIR]
 *   npx tsx scripts/video-publish-authorize.ts check-task AAMMDD --part vertical --destination ID --command "..." [--edition-dir DIR]
 *   npx tsx scripts/video-publish-authorize.ts status AAMMDD [--edition-dir DIR]
 *
 * - `grant`: logo depois do "pode publicar" explícito do editor sobre o plano
 *   do dry-run. Lê o manifesto que o dry-run gravou
 *   (`_internal/video-publish-plan.{parte}.json`), confere que o hash é o que o
 *   editor viu (`plan_sha256` do JSON do dry-run) e grava uma autorização de uso
 *   único por destino executável da parte. Depois de consumo ou invalidação,
 *   exige releituras do registro gravadas (`video-publish-registry-status.ts
 *   --since ISO --record`) que cubram todos os eventos, e que o processo que
 *   consumiu a última autorização do destino esteja morto nesta máquina.
 *   `--override-uncertain`: só para o destino que a releitura acusou por estado
 *   incerto (marcador `pending` do horizontal, marca de envio sem registro),
 *   depois de o editor conferir a conta; o texto fica gravado na autorização.
 *   `--replace-scheduled` (#12279, só `--part vertical`): o grant da TROCA do
 *   vídeo de um vertical já agendado (V1 por V2). Lê o manifesto de
 *   substituição (`_internal/video-publish-plan.vertical-replace.json`, do
 *   dry-run `publish-shorts.ts AAMMDD --replace-scheduled`), confere cada post
 *   antigo contra o registro local (mesmo ID, agendado, mesmo horário, com
 *   folga, sem envio em aberto) e é a única exceção à recusa de nova
 *   autorização para destino já registrado. Sem a flag, a recusa segue igual.
 * - `invalidate`: SEMPRE que uma chamada de publisher voltar interrompida,
 *   rejeitada, com timeout ou sem saída, e quando o editor disser "não".
 *   Derruba as autorizações ativas da parte (ou de todas) e grava o evento.
 *   Exit != 0 aqui = a invalidação NÃO foi gravada e a autorização pode estar
 *   AINDA ATIVA: a skill trata como halt banner, nunca chama o publisher.
 * - `check-task`: antes de criar a task one-shot do `owners[]` do vertical.
 *   Sai 0 só com autorização ativa do destino cujo dono aprovado é essa task
 *   com esse comando; sem isso a task não é criada.
 * - `status`: o registro como está (só leitura).
 *
 * Não publica nada nem chama API. Saída: JSON no stdout. Exit 0 = feito;
 * exit 1 = recusado (motivo no stderr); exit 2 = uso.
 */
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import {
  checkTaskAuthorization,
  grantVideoPublishAuthorization,
  invalidateVideoPublishAuthorization,
  readAuthorizationStore,
  updateAuthorizationStore,
  type AuthResult,
  type VideoPublishAuthorization,
} from "./lib/diaria/video-publish-authorization.ts";
import { readVideoPlanManifest, VIDEO_PLAN_PARTS, type VideoPlanPart } from "./lib/diaria/video-publish-plan.ts";
import { replacementGrantRefusal } from "./lib/diaria/short-scheduled-replace.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import { openSendingMarks, readShortsSending } from "./lib/diaria/shorts-sending-marker.ts";

const USAGE =
  "uso: video-publish-authorize.ts grant AAMMDD --part horizontal|vertical --plan-sha256 HASH --confirmation TEXTO [--only d1,d2] [--override-uncertain TEXTO] [--replace-scheduled] [--edition-dir DIR]\n" +
  "     video-publish-authorize.ts invalidate AAMMDD --part horizontal|vertical|all --reason TEXTO [--edition-dir DIR]\n" +
  "     video-publish-authorize.ts check-task AAMMDD --part vertical --destination ID --command TEXTO [--edition-dir DIR]\n" +
  "     video-publish-authorize.ts status AAMMDD [--edition-dir DIR]";

export interface AuthorizeCliIo {
  log: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

const defaultIo: AuthorizeCliIo = { log: (l) => console.log(l), err: (l) => console.error(l), now: () => new Date() };

function usage(io: AuthorizeCliIo, msg?: string): number {
  if (msg) io.err(`video-publish-authorize: ${msg}`);
  io.err(USAGE);
  return 2;
}

function parsePart(raw: string | undefined, allowAll: boolean): VideoPlanPart | "all" | null {
  if (raw === undefined) return null;
  if (allowAll && raw === "all") return "all";
  return (VIDEO_PLAN_PARTS as readonly string[]).includes(raw) ? (raw as VideoPlanPart) : null;
}

export function main(argv: string[] = process.argv.slice(2), io: AuthorizeCliIo = defaultIo): number {
  const { flags, values, positional } = parseArgs(argv);
  const [cmd, aammdd] = positional;
  if (!cmd || !["grant", "invalidate", "check-task", "status"].includes(cmd)) return usage(io, cmd ? `subcomando desconhecido: ${cmd}` : undefined);
  if (!aammdd || !/^\d{6}$/.test(aammdd)) return usage(io, "AAMMDD obrigatório (6 dígitos)");
  for (const k of ["part", "plan-sha256", "confirmation", "reason", "destination", "command", "only", "override-uncertain", "edition-dir"]) {
    if (flags.has(k)) return usage(io, `--${k} exige um valor`);
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));

  try {
    if (cmd === "status") {
      io.log(JSON.stringify(readAuthorizationStore(dir, aammdd), null, 2));
      return 0;
    }
    if (cmd === "grant") {
      const part = parsePart(values["part"], false) as VideoPlanPart | null;
      if (!part) return usage(io, "--part horizontal|vertical obrigatório");
      if (!values["plan-sha256"]) return usage(io, "--plan-sha256 obrigatório (o plan_sha256 do dry-run mostrado ao editor)");
      if (values["confirmation"] === undefined) return usage(io, "--confirmation obrigatório (o texto da resposta explícita do editor)");
      if (values["replace-scheduled"] !== undefined) return usage(io, `--replace-scheduled não leva valor (recebeu "${values["replace-scheduled"]}")`);
      const replacement = flags.has("replace-scheduled");
      if (replacement && part !== "vertical") return usage(io, "--replace-scheduled só vale com --part vertical (#12279)");
      const manifest = readVideoPlanManifest(dir, part, { replacement });
      if (!manifest) {
        io.err(
          replacement
            ? `video-publish-authorize: sem o manifesto da substituição nesta edição: rode publish-shorts.ts ${aammdd} --replace-scheduled (dry-run) antes (#12279)`
            : `video-publish-authorize: sem o manifesto do dry-run do ${part} nesta edição: rode o dry-run antes`,
        );
        return 1;
      }
      if (replacement) {
        // #12279: o post antigo de cada destino ainda é o registrado, agendado, no mesmo horário, com folga.
        const entries = readShortsRegistry(dir, aammdd).entries;
        const refusal = replacementGrantRefusal(manifest, entries, io.now(), openSendingMarks(readShortsSending(dir, aammdd), entries));
        if (refusal) {
          io.err(`video-publish-authorize: grant recusado: ${refusal}`);
          return 1;
        }
      }
      const only = values["only"] ? values["only"].split(",").map((s) => s.trim()).filter(Boolean) : null;
      const r = updateAuthorizationStore<AuthResult<VideoPublishAuthorization[]>>(dir, aammdd, (store) => {
        const g = grantVideoPublishAuthorization(store, {
          manifest, planSha256: values["plan-sha256"], confirmation: values["confirmation"], now: io.now(), only,
          overrideUncertain: values["override-uncertain"] ?? null,
          replacement,
        });
        return g.ok ? { store: g.store, result: g } : { store: null, result: g };
      });
      if (!r.ok) {
        io.err(`video-publish-authorize: grant recusado: ${r.error}`);
        return 1;
      }
      io.log(JSON.stringify({ granted: r.value.map((a) => ({ part: a.part, destination: a.destination, plan_sha256: a.plan_sha256, owner: a.owner, ...(a.replacement ? { replacement: a.replacement } : {}) })) }, null, 2));
      io.err(`[ok] ${part}: autorização de uso único${replacement ? " de SUBSTITUIÇÃO (#12279)" : ""} gravada para ${r.value.map((a) => a.destination).join(", ")}`);
      return 0;
    }
    if (cmd === "invalidate") {
      const part = parsePart(values["part"], true);
      if (!part) return usage(io, "--part horizontal|vertical|all obrigatório");
      if (!values["reason"]) return usage(io, "--reason obrigatório (interrompida, rejeitada, \"não\" do editor...)");
      const out = updateAuthorizationStore(dir, aammdd, (store) => {
        const r = invalidateVideoPublishAuthorization(store, { part, reason: values["reason"], now: io.now() });
        return { store: r.store, result: r.invalidated };
      });
      io.log(JSON.stringify({ invalidated: out.map((a) => ({ part: a.part, destination: a.destination })) }, null, 2));
      io.err(`[ok] invalidação gravada (${part}): ${out.length ? out.map((a) => `${a.part}/${a.destination}`).join(", ") : "nenhuma ativa"}. Nova publicação só com releitura do registro (--record) e novo "pode publicar".`);
      return 0;
    }
    // check-task
    const part = parsePart(values["part"], false) as VideoPlanPart | null;
    if (!part || !values["destination"] || !values["command"]) return usage(io, "check-task exige --part, --destination e --command");
    const r = checkTaskAuthorization(readAuthorizationStore(dir, aammdd), { part, destination: values["destination"], command: values["command"] });
    if (!r.ok) {
      io.err(`video-publish-authorize: ${r.error}`);
      return 1;
    }
    io.log(JSON.stringify({ task_authorized: true, destination: r.authorization.destination, plan_sha256: r.authorization.plan_sha256 }, null, 2));
    return 0;
  } catch (e) {
    io.err(`video-publish-authorize: ${(e as Error).message}`);
    if (cmd === "invalidate") {
      io.err(
        "video-publish-authorize: invalidação NÃO gravada — a autorização pode estar AINDA ATIVA. Não chame o publisher: " +
          "halt banner, conferir o registro (_internal/video-publish-authorizations.json) e repetir o invalidate (#12654).",
      );
    }
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
