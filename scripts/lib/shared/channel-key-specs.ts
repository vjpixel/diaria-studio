/**
 * channel-key-specs.ts (#7173, Passo 1)
 *
 * `ChannelKeySpec`, `CHANNEL_KEY_SPECS` e `assertValidChannelKeySpecs`,
 * movidos de `scripts/lib/cac.ts` para `scripts/lib/shared/` — sem NENHUM
 * import além de `scripts/lib/shared/attribution-keys.ts` (também puro, sem
 * `dotenv`), ao contrário de `cac.ts` (que importa de
 * `scripts/cohort-engagement.ts`, cujo `import "dotenv/config"` no topo
 * polui `process.env` como side effect de import — ver a docstring de
 * `attribution-keys.ts` para o achado medido).
 *
 * `scripts/lib/cac.ts` RE-EXPORTA deste módulo — nenhum consumidor existente
 * muda de import. `scripts/lib/metrics/acquisition-class.ts` (F1) importa
 * DIRETO daqui, nunca de `cac.ts`.
 *
 * Nenhuma função aqui toca disco/rede. @pure em todo o módulo.
 */

import {
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  type CohortWindow,
} from "./attribution-keys.ts";

/**
 * Um recorte dentro de um canal (#5496) — `utm_source`/`referring_site`
 * (normalizados por `normalizeKey`) que identificam um PAGO MEDIDO no
 * snapshot, opcionalmente restrito a um SUB-canal (`subcanal` casa com
 * `SpendRow.subcanal`; ausente = "o canal inteiro").
 *
 * `ambigua: true` marca uma chave que TAMBÉM é usada por tráfego orgânico
 * (ex: `google.com` — pode ser busca orgânica ou clique de anúncio que
 * perdeu a query string) — nesse caso `janela` é OBRIGATÓRIA
 * (`assertValidChannelKeySpecs` lança se faltar) e só cadastros DENTRO dela
 * contam como pagos. Fora da janela, esses cadastros nunca entram nesta
 * spec (ficam de fora do canal, subestimando por construção — decisão
 * documentada da issue #5493: "conservador, aceitando subestimar cadastros
 * pagos" é preferível a contaminar com orgânico sem aviso).
 */
export interface ChannelKeySpec {
  canal: string;
  subcanal?: string;
  keys: readonly string[];
  /** Obrigatória quando `ambigua: true`; ignorada (mas aceita) em spec não-ambígua. */
  janela?: CohortWindow;
  ambigua?: boolean;
}

/**
 * Specs por (canal, sub-canal) — fonte única de verdade. Ver a docstring
 * original em `scripts/lib/cac.ts` (histórico #4466/#5254/#5493/#5496/260816)
 * para o raciocínio completo por trás de cada spec — reproduzido aqui só o
 * necessário para quem lê o módulo isoladamente.
 *
 * Google Ads: `android.googlequicksearchbox`/`googlesyndication`/
 * `googleadservices` (sub-canal "PMax") confirmados em #4466/#5254.
 * `google.com` (sub-canal "Search") é AMBÍGUA — pode ser busca orgânica — e
 * só conta dentro da janela da campanha (dez/2025 a fev/2026, #5496: 34 dos
 * 41 cadastros `google.com` dentro dessa janela e 7 fora).
 *
 * LinkedIn: nenhuma campanha rodou até 260814 (spend R$0) — as chaves são a
 * convenção já usada pelo projeto (`LINKEDIN_POST_PIXEL_UTM.source` em
 * `scripts/lib/shared/utm-registry.ts` usa `"linkedin"`).
 *
 * Meta/Microsoft Advertising deliberadamente NÃO têm spec de REFERRER
 * (#5493) — só `RESERVED_CHANNEL_NAMES` reserva os nomes canônicos.
 *
 * As 3 specs "teste 2608" (§8.2) casam por `utm_source` EXATO que os
 * próprios anúncios do teste escrevem na URL final — nunca domínio de
 * plataforma, que também carrega orgânico (#5493).
 */
export const CHANNEL_KEY_SPECS: readonly ChannelKeySpec[] = [
  {
    canal: "Google Ads",
    subcanal: "PMax",
    keys: ["android.googlequicksearchbox", "googlesyndication", "googlesyndication.com", "googleadservices", "googleadservices.com"],
  },
  {
    canal: "Google Ads",
    subcanal: "Search",
    keys: ["google.com"],
    ambigua: true,
    janela: {
      since: parseSinceToEpochSeconds("2025-12-01"),
      untilExclusive: parseUntilToEpochSecondsExclusive("2026-02-28"),
    },
  },
  {
    canal: "LinkedIn",
    keys: ["linkedin", "linkedin.com", "l.linkedin.com", "www.linkedin.com"],
  },
  // Teste de 3 canais (260816, §8.2) — chaves de utm_source que NÓS
  // escrevemos nas URLs finais dos anúncios, não adivinhação de referrer
  // (ver docstring acima). Nomes de canal EXATOS: são as strings gravadas
  // na coluna `canal` de `data/aquisicao/spend.csv` por este teste.
  {
    canal: "Google Ads (teste 2608)",
    keys: ["google-ads"],
  },
  {
    canal: "Microsoft Ads (teste 2608)",
    keys: ["microsoft-ads"],
  },
  {
    canal: "Meta Ads (teste 2608)",
    keys: ["meta-ads"],
  },
];

/** Nomes canônicos reservados para Meta/Microsoft Advertising (#5493) —
 *  usar exatamente estas strings na coluna `canal` de `spend.csv`/scripts de
 *  ingestão assim que existir gasto real, MESMO sem spec ainda em
 *  `CHANNEL_KEY_SPECS` (a linha aparece como "canal desconhecido" avisado
 *  até a spec entrar — nunca como `measured` silenciosamente errado). */
export const RESERVED_CHANNEL_NAMES = ["Meta", "Microsoft Advertising"] as const;

/** Lança se alguma spec `ambigua: true` não tiver `janela` — chave ambígua
 *  sem janela é pior que canal desconhecido (produziria um número plausível
 *  e falso, silenciosamente). Chamada no load do módulo: `CHANNEL_KEY_SPECS`
 *  é estático, então um erro de configuração quebra IMEDIATAMENTE (import
 *  falha), nunca em runtime só quando aquele canal específico for
 *  relatado. Exportada pra ser testável com fixtures inválidas sem precisar
 *  quebrar o import do módulo real. @pure */
export function assertValidChannelKeySpecs(specs: readonly ChannelKeySpec[]): void {
  for (const spec of specs) {
    if (spec.ambigua && !spec.janela) {
      throw new Error(
        `[cac] CHANNEL_KEY_SPECS: spec ambígua sem janela obrigatória — canal="${spec.canal}"` +
          `${spec.subcanal ? ` subcanal="${spec.subcanal}"` : ""}. Chave ambígua (colide com tráfego ` +
          `orgânico) só pode contar como paga dentro de uma janela declarada.`,
      );
    }
  }
}
assertValidChannelKeySpecs(CHANNEL_KEY_SPECS);
