# Crawlers de IA ficam liberados nas nossas superfícies

Movido do `CLAUDE.md` (#6935 PR 2 — curadoria do teto de bytes). Enforcement
real é a config de zona da Cloudflare + os `robots.txt` servidos pelos
Workers de curadoria, auditados diariamente por `Diaria-Robots-Txt-Drift-Check`
(arme: `docs/robots-txt-drift-check-setup.md`) — mover este texto não muda
nenhuma config, só onde a decisão é documentada.

## A decisão (260803)

GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider e afins podem ler o
conteúdo público do projeto — ser citado por assistente é canal de
descoberta, e as páginas de curadoria são curadoria e link, não texto
autoral das edições.

## Estado atual, confirmado ao vivo em 12/08/2026 (#5120)

Nenhum Worker de curadoria (`arquivo.diar.ia.br`, `livros.diar.ia.br` e
demais) serve mais o bloco gerenciado da Cloudflare — o `robots.txt` de
cada um hoje é só `Content-Signal: search=yes,ai-train=yes,use=reference`
+ `Allow: /` no grupo `*`, com **`Amazonbot` e
`CloudflareBrowserRenderingCrawler` bloqueados** (`Disallow: /`) e
`Sitemap:` declarado.

**O apex `diar.ia.br` é caso à parte** (medido ao vivo em 19/08/2026,
#5641): não é um Worker, é servido pela Beehiiv, e o que sai é o
`robots.txt` DEFAULT dela — sem `Content-Signal`, sem `Allow: /`
explícito, com `Amazonbot` e `Nutch` em `Disallow: /` e
`AhrefsBot`/`adsbot-google` restritos a `/login`.

Nenhum dos dois formatos bloqueia os 9 crawlers de assistente/treino
(GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider, meta-externalagent,
Applebot-Extended e os 2 de busca/citação) — a decisão desta seção está no
ar nos dois hosts, só o arquivo servido difere.

## Não reabrir via Worker se reaparecer

Um `robots.txt` custom no Worker não basta — o bloco gerenciado da
Cloudflare (quando ligado) é ANEXADO depois e vence por especificidade RFC
9309, então a correção é sempre no dashboard da zona (desligar o bloco
gerenciado), não no arquivo servido pelo Worker (histórico detalhado do
incidente: issues #4910 e #5120 no GitHub).

Ao subir Worker novo, `curl https://{host}/robots.txt` pra confirmar que o
bloco gerenciado não reapareceu — é o que `Diaria-Robots-Txt-Drift-Check`
audita diariamente (registro completo da task: `docs/scheduled-tasks-registry.md`).
