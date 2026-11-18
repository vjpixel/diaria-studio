/**
 * scripts/lib/shared/email-dark-mode.ts (#13525)
 *
 * Modo escuro de verdade para os e-mails (mensal Clarice/Kit apoiadores e o
 * documento completo da diária, que a Brevo diária envia).
 *
 * ## O defeito
 *
 * Os e-mails declaram `<meta name="color-scheme" content="light dark">`, ou
 * seja, dizem ao cliente que suportam o modo escuro e que ele não precisa
 * inverter nada. Até aqui o único CSS de dark mode era `darkCanvasMediaRule`
 * (#2645/#3104), que escurece só o canvas em volta do card. Uma leitora da
 * Clarice News no Mail do iOS em modo escuro recebeu o card escuro com o texto
 * continuando escuro (#13525): títulos e parágrafos sumiram.
 *
 * ## O mecanismo
 *
 * Toda cor do e-mail é inline (`style="color:#171411"`), e inline vence
 * qualquer regra de `<style>` que não seja `!important`. Em vez de espalhar
 * classes à mão por cada `render*` (dezenas de pontos, fácil de esquecer num
 * render novo), `applyDarkModeClasses` passa UMA vez no HTML final, lê as cores
 * inline de cada tag e acrescenta a classe correspondente (`dm-c-171411`,
 * `dm-bg-ffffff`, `dm-bd-ebe5d0`). `darkModeMediaRules` emite as regras dessas
 * classes dentro de `@media (prefers-color-scheme: dark)` (Apple Mail, iOS
 * Mail, Outlook para Mac, Thunderbird) e também sob `[data-ogsc]`/`[data-ogsb]`
 * (Outlook.com/Outlook app, que marcam o `<body>` com esses atributos quando
 * aplicam o próprio modo escuro).
 *
 * Classe e não seletor de atributo (`[style*="color:#171411"]`) porque o ESP
 * pode reescrever o `style` (espaços, caixa do hex) e o seletor de atributo
 * deixaria de casar em silêncio; a classe sobrevive.
 *
 * Cor que não está no mapa fica como está (fail-soft visível: aparece no modo
 * escuro com a cor clara original, nunca some). Gmail ignora
 * `prefers-color-scheme` e aplica a própria inversão; não há o que fazer
 * daqui além de manter as cores declaradas.
 *
 * ## Paleta escura
 *
 * Mesma família do DS (tinta quente, bege, teal), com contraste AA medido
 * contra o fundo mais claro em que cada cor de texto aparece (o bege dos
 * boxes, `#35302A`): texto `#EDE7DC` ~10:1, teal `#4CC9C9` ~6,6:1.
 */
import { COLORS } from "./design-tokens.ts";

/** Cor clara (hex maiúsculo) → cor no modo escuro, por papel da propriedade. */
export interface DarkModeMap {
  /** `color:` — texto. */
  readonly color: Readonly<Record<string, string>>;
  /** `background`/`background-color`/`bgcolor` — fundos. */
  readonly background: Readonly<Record<string, string>>;
  /** `border*` — fios e contornos. */
  readonly border: Readonly<Record<string, string>>;
}

export const DARK_MODE_MAP: DarkModeMap = {
  color: {
    [COLORS.ink]: "#EDE7DC", // texto principal
    [COLORS.brand]: "#4CC9C9", // links, kickers, marcadores teal
    [COLORS.onInk]: COLORS.ink, // texto claro sobre botão de tinta (o fundo vira claro abaixo)
  },
  background: {
    "#FFFFFF": "#211D19", // card / página (PAPER/SHELL/PAGE_BG)
    [COLORS.paper]: "#2A2621", // pílulas e boxes contorno
    [COLORS.paperAlt]: "#35302A", // boxes bege (fio condutor, É IA?, cupons)
    [COLORS.ink]: "#EDE7DC", // botão de tinta vira claro, texto dele vira tinta (acima)
  },
  border: {
    [COLORS.paperAlt]: "#4A433A", // hairline bege
    [COLORS.ink]: "#EDE7DC", // régua forte
  },
};

type Role = "c" | "bg" | "bd";

/**
 * Ícones de rede do convite social (`encerramento-snippet.ts`): glifo de tinta
 * sobre PNG transparente, que some no card escuro. Em dark mode ganham uma
 * plaqueta clara atrás (classe `dm-icon-ink`). Casado pelo `src` aqui, e não
 * por uma classe no renderer, para não mudar o fragmento da diária (Kit e
 * Beehiiv), que não passa por este módulo.
 */
const INK_ICON_SRC_RE = /\/icons\/social\//;
export const INK_ICON_CLASS = "dm-icon-ink";
const INK_ICON_PLATE = "#EDE7DC";

const HEX_RE = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i;

function normalizeHex(raw: string): string {
  let h = raw.replace("#", "").toUpperCase();
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  return `#${h}`;
}

function roleOfProperty(prop: string): Role | null {
  const p = prop.trim().toLowerCase();
  if (p === "color") return "c";
  if (p === "background" || p === "background-color") return "bg";
  if (/^border(-(top|right|bottom|left))?(-color)?$/.test(p)) return "bd";
  return null;
}

function mapFor(role: Role, map: DarkModeMap): Readonly<Record<string, string>> {
  return role === "c" ? map.color : role === "bg" ? map.background : map.border;
}

export function darkModeClassName(role: Role, hex: string): string {
  return `dm-${role}-${normalizeHex(hex).slice(1).toLowerCase()}`;
}

/** Classes de dark mode que um `style` inline (e um `bgcolor`) pedem. */
export function darkModeClassesForStyle(style: string, bgcolor: string | null = null, map: DarkModeMap = DARK_MODE_MAP): string[] {
  const out = new Set<string>();
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const role = roleOfProperty(decl.slice(0, idx));
    if (!role) continue;
    const m = decl.slice(idx + 1).match(HEX_RE);
    if (!m) continue;
    const hex = normalizeHex(m[0]);
    if (hex in mapFor(role, map)) out.add(darkModeClassName(role, hex));
  }
  if (bgcolor) {
    const m = bgcolor.match(HEX_RE);
    if (m && normalizeHex(m[0]) in map.background) out.add(darkModeClassName("bg", m[0]));
  }
  return [...out];
}

// Tag de abertura com atributos. Atributo entre aspas duplas ou simples.
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)(\s(?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");

/**
 * Acrescenta as classes `dm-*` a cada tag cujo `style`/`bgcolor` inline usa uma
 * cor do mapa. Idempotente (classe já presente não duplica). Não toca no
 * `<body>` nem em `.ds-canvas`: esses são o canvas, que `darkCanvasMediaRule`
 * já escurece com a cor própria do canvas (uma classe de card ali empataria em
 * especificidade e trocaria o canvas pela cor do card).
 */
export function applyDarkModeClasses(html: string, map: DarkModeMap = DARK_MODE_MAP): string {
  return html.replace(OPEN_TAG_RE, (tag, name: string, attrs: string) => {
    const lower = name.toLowerCase();
    if (lower === "body" || lower === "html" || lower === "style" || lower === "script") return tag;
    const styleM = attrs.match(ATTR_RE("style"));
    const bgM = attrs.match(ATTR_RE("bgcolor"));
    const srcM = lower === "img" ? attrs.match(ATTR_RE("src")) : null;
    const isInkIcon = !!srcM && INK_ICON_SRC_RE.test(srcM[2] ?? srcM[3] ?? "");
    if (!styleM && !bgM && !isInkIcon) return tag;
    const style = styleM ? (styleM[2] ?? styleM[3] ?? "") : "";
    const bgcolor = bgM ? (bgM[2] ?? bgM[3] ?? null) : null;
    const wanted = darkModeClassesForStyle(style, bgcolor, map);
    if (isInkIcon) wanted.push(INK_ICON_CLASS);
    if (wanted.length === 0) return tag;
    const classM = attrs.match(ATTR_RE("class"));
    if (classM) {
      const current = (classM[2] ?? classM[3] ?? "").split(/\s+/).filter(Boolean);
      if (current.includes("ds-canvas")) return tag;
      const merged = [...current, ...wanted.filter((c) => !current.includes(c))];
      if (merged.length === current.length) return tag;
      const newAttrs = attrs.replace(classM[0], ` class="${merged.join(" ")}"`);
      return `<${name}${newAttrs}>`;
    }
    // Classe nova vai no FIM dos atributos: quem lê o HTML por prefixo
    // (`<a href=...`, `<p style=...`) continua casando.
    const selfClose = /\s*\/\s*$/.exec(attrs);
    const head = selfClose ? attrs.slice(0, selfClose.index) : attrs;
    const tail = selfClose ? selfClose[0] : "";
    return `<${name}${head} class="${wanted.join(" ")}"${tail}>`;
  });
}

/**
 * Regras CSS das classes `dm-*` (sem `<style>` envolvente). Primeira linha sem
 * espaço líder, mesma convenção de `darkCanvasMediaRule`: o caller indenta.
 */
export function darkModeMediaRules(map: DarkModeMap = DARK_MODE_MAP): string {
  const colorRules: string[] = [];
  const bgRules: string[] = [];
  const bdRules: string[] = [];
  for (const [light, dark] of Object.entries(map.color)) colorRules.push(`.${darkModeClassName("c", light)} { color:${dark} !important; }`);
  // Só background-color: o inline `background:#FFFFFF` (shorthand) define a cor
  // de fundo, e trocar o shorthand aqui apagaria uma eventual imagem de fundo.
  for (const [light, dark] of Object.entries(map.background)) bgRules.push(`.${darkModeClassName("bg", light)} { background-color:${dark} !important; }`);
  for (const [light, dark] of Object.entries(map.border)) bdRules.push(`.${darkModeClassName("bd", light)} { border-color:${dark} !important; }`);
  const iconRule = `.${INK_ICON_CLASS} { background-color:${INK_ICON_PLATE} !important; border-radius:6px !important; }`;
  const inMedia = [...colorRules, ...bgRules, ...bdRules, iconRule].map((r) => `    ${r}`).join("\n");
  // Outlook.com/app: [data-ogsc] marca a cor de texto que ele trocou, [data-ogsb] o fundo.
  const outlook = [
    ...colorRules.map((r) => `  [data-ogsc] ${r}`),
    ...[...bgRules, iconRule].map((r) => `  [data-ogsb] ${r}`),
  ].join("\n");
  return `@media (prefers-color-scheme: dark) {
${inMedia}
  }
${outlook}`;
}
