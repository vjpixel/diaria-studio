/** Caixa estável da votação (#11200). Sem rede; dry-run por padrão. */
import { existsSync, mkdirSync, readFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { applyBoxPin, serializeConfigSurgically, type BoxesDivulgacaoConfig } from "./lib/box-slot-pin.ts";
import { readBallotInput } from "./voto-tema-open.ts";
import { formatPrazo, parseCicloVotacao, validarCedula } from "../workers/artigos/src/voto-tema-core.ts";

export const VOTO_BOX = "voto-tema-divulgacao.md";
export const VOTO_CTA = "https://apoia.se/diaria?utm_source=newsletter&utm_medium=email&utm_campaign=voto-tema";
type Input = ReturnType<typeof readBallotInput>;
interface Claim { ciclo: string; prazo: string; previous: unknown; pinned: boolean }

// expires é inclusivo e só tem precisão de dia. Retirar na data do prazo
// evita prometer voto numa edição que pode ser lida depois do fechamento.
export function boxExpiry(prazo: string): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(prazo));
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
export function buildVotoBox(ciclo: string, input: Input): string {
  const valid = validarCedula(input, { exigirPrazo: true });
  if (!valid.ok) throw new Error(valid.reason);
  return `<!--\nnome: Votação do Artigo Especial\naudience: diaria\nciclo: ${ciclo}\nexpires: ${boxExpiry(input.prazo!)}\n-->\n\n**Qual tema você quer ler no próximo Artigo Especial?**\n\nOs temas desta votação são: ${input.opcoes.map(o => o.titulo).join("; ")}.\n\nQuem apoia nos níveis Conselho e Núcleo pode votar. O prazo da votação é ${formatPrazo(input.prazo)}. A entrada no eleitorado depende da confirmação do apoio e do envio do link individual antes do prazo.\n\n[Apoie e participe da escolha](${VOTO_CTA})\n`;
}
export function validateVotoCopy(copy: string, input: Input): void {
  const body = copy.replace(/<!--[\s\S]*?-->/g, "");
  if (/R\s*\$|\breais\b|Mantenedor|Patrono|[←→]/i.test(body)) throw new Error("Copy contém preço, nível antigo ou seta.");
  for (const required of ["Conselho", "Núcleo", VOTO_CTA, formatPrazo(input.prazo)!, ...input.opcoes.map(o => o.titulo)]) {
    if (!body.includes(required)) throw new Error(`Copy perdeu campo obrigatório: ${required}`);
  }
}
export function updateVotoBox(o: { root: string; ciclo: string; push?: boolean; archive?: boolean; copy?: string; now?: Date }): string {
  if (!parseCicloVotacao(o.ciclo)) throw new Error("Ciclo precisa ser AAMM.");
  const base = resolve(o.root, "data/artigo-especial/votacao");
  const statePath = resolve(base, "divulgacao-claim.json");
  mkdirSync(base, { recursive: true });
  // Claim exclusivo da CAIXA, distinto do claim da issue. Nunca roubar ciclo ativo.
  const lock = resolve(base, ".divulgacao.lock");
  const fd = openSync(lock, "wx");
  try {
    const now = o.now ?? new Date();
    const state: Claim | null = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    if (state && state.ciclo !== o.ciclo && (o.archive || Date.parse(state.prazo) > now.getTime())) throw new Error(`Caixa reivindicada pelo ciclo ${state.ciclo}; não sobrescrever nem arquivar por outro ciclo.`);
    const configPath = resolve(o.root, "platform.config.json");
    const original = readFileSync(configPath, "utf8");
    const config = JSON.parse(original) as BoxesDivulgacaoConfig;
    const file = resolve(o.root, "data/snippets", VOTO_BOX);
    if (o.archive) {
      // Ownership duplo: ciclo do claim E arquivo do slot. Troca manual vence.
      if (!state) return "Sem claim da caixa; nada alterado.";
      let next = applyBoxPin(config, { slot: 1, filename: VOTO_BOX, pin: false });
      if (config.boxes_divulgacao?.slot1 === VOTO_BOX) {
        next = { ...next, boxes_divulgacao: { ...next.boxes_divulgacao, slot1: state.previous } };
        if (state.pinned) next = applyBoxPin(next, { slot: 1, filename: state.previous as string, pin: true });
      }
      if (o.push) {
        writeFileAtomic(configPath, serializeConfigSurgically(original, next, 1));
        if (existsSync(file)) {
          const archive = resolve(o.root, "data/snippets/_arquivo", `${o.ciclo}-${VOTO_BOX}`);
          mkdirSync(dirname(archive), { recursive: true });
          renameSync(file, archive);
        }
        unlinkSync(statePath);
      }
      return "Caixa arquivada e pin liberado (ou dry-run).";
    }
    if (existsSync(resolve(base, o.ciclo, "result.json"))) throw new Error("Ciclo fechado; arquivar a caixa em vez de divulgar.");
    const input = readBallotInput(resolve(base, o.ciclo, "ballot.json"));
    const seed = buildVotoBox(o.ciclo, input);
    if (Date.parse(input.prazo!) <= now.getTime()) throw new Error("Prazo encerrado; não divulgar votação fechada.");
    const warning = Date.parse(input.prazo!) - now.getTime() < 48 * 3600000
      ? "AVISO: menos de 48h para sync de apoio, tag, token e entrega do link; não prometer participação neste ciclo.\n" : "";
    const body = o.copy ? readFileSync(o.copy, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim() : seed.split("-->\n")[1].trim();
    validateVotoCopy(body, input);
    const content = seed.split("-->")[0] + "-->\n\n" + body + "\n";
    if (o.push) {
      if (!o.copy) throw new Error("--push exige --copy revisada por Humanizador + Clarice.");
      const claim: Claim = state?.ciclo === o.ciclo ? state : {
        ciclo: o.ciclo, prazo: input.prazo!, previous: config.boxes_divulgacao?.slot1 === VOTO_BOX && state ? state.previous : config.boxes_divulgacao?.slot1 ?? null,
        pinned: config.boxes_divulgacao?.slot1 === VOTO_BOX && state ? state.pinned : config.boxes_divulgacao_auto?.pinned_slots?.includes(1) ?? false,
      };
      claim.prazo = input.prazo!;
      if (claim.previous === VOTO_BOX) throw new Error("Pin manual sem fallback conhecido; resolver claim antes de publicar.");
      if (state && state.ciclo !== o.ciclo && existsSync(file)) {
        const archive = resolve(o.root, "data/snippets/_arquivo", `${state.ciclo}-${VOTO_BOX}`);
        mkdirSync(dirname(archive), { recursive: true });
        writeFileAtomic(archive, readFileSync(file, "utf8"));
      }
      // Claim antes do conteúdo: interrupção nunca permite outro ciclo tomar a caixa.
      writeFileAtomic(statePath, JSON.stringify(claim, null, 2) + "\n");
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, content);
      const next = applyBoxPin(config, { slot: 1, filename: VOTO_BOX, pin: true });
      writeFileAtomic(configPath, serializeConfigSurgically(original, next, 1));
    }
    return warning + content;
  } finally { closeSync(fd); unlinkSync(lock); }
}
if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  try {
    process.stdout.write(updateVotoBox({ root: resolve(import.meta.dirname, ".."), ciclo: values.ciclo ?? "", push: flags.has("push"), archive: flags.has("archive"), copy: values.copy }) + "\n");
  } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
}
