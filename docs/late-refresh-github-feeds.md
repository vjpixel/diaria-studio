# Refresh tardio do gate 4: feeds do GitHub de xAI, DeepSeek e Qwen (#9424)

O refresh tardio (`scripts/late-refresh-candidates.ts`, miolo em
`scripts/lib/late-refresh.ts`, §4c.9 do Stage 4) lista o que saiu nas fontes
oficiais dos laboratórios depois da pesquisa do Stage 1. Até 07/10/2026 três
labs da lista da #9370 ficavam sem fonte: xAI, DeepSeek e Qwen. Nenhum dos três
publica RSS legível (sondagem de 02/10 na issue). A decisão do editor de
07/10/2026 foi usar o **GitHub oficial da org**, que é fonte oficial e não
envolve scraping nem risco de ToS.

## O que a sondagem de 07/10/2026 mostrou

GET simples com User-Agent (`DiariaBot/1.0`), sem token, nas cinco orgs
candidatas: `deepseek-ai`, `QwenLM`, `xai-org`, `mistralai` e `meta-llama`.

1. **Repo de pesos de modelo não publica release.** `QwenLM/Qwen3`,
   `QwenLM/Qwen3.8`, `QwenLM/Qwen-Image-2.1`, `xai-org/grok-1`,
   `xai-org/grok-build`, `deepseek-ai/FlashMLA` devolvem o Atom de releases
   vazio; `deepseek-ai/DeepSeek-V3` quase não publica (uma única release,
   v1.0.0, 06/2025).
   O lançamento de modelo aparece como **repo novo da org** (Qwen3.8-Flash-Next
   em 24/08, Qwen-Image-2.1 em 14/09, grok-build em 14/07, deepseek-harness em
   13/08). Só ler releases deixaria de fora justo o lançamento de modelo.
2. **O Atom de atividade da org (`github.com/{org}.atom`) vem vazio** (200, sem
   nenhum `<entry>`) para as cinco orgs. Não serve.
3. **A API de eventos da org (`/orgs/{org}/events`)** é dominada por
   Watch/Fork: as 100 entradas cobrem poucas horas. Não serve como janela.
4. **Release só existe nos repos de ferramenta/SDK**, com muito ruído: o
   `qwen-code` solta nightly diário e preview, o `deepseek-harness` só tem
   alpha/rc, o `xai-sdk-python` tem bump de patch.

## Fontes escolhidas

| Lab | Repos novos (API REST) | Releases (Atom) | Filtro de tag |
|---|---|---|---|
| Qwen | `QwenLM` | `QwenLM/qwen-code` | `^v\d+\.\d+\.0$` |
| DeepSeek | `deepseek-ai` | `deepseek-ai/deepseek-harness` | `^dsh-v\d+\.\d+\.0$` |
| xAI | `xai-org` | `xai-org/xai-sdk-python` | `^v\d+\.\d+\.0$` |

- **Repos novos** (`method: "github-new-repos"`):
  `GET https://api.github.com/orgs/{org}/repos?sort=created&direction=desc&per_page=30&type=sources`
  (`type=sources` já exclui fork na API; a URL é derivada da org em
  `githubNewReposUrl`, fonte única). Entra repo público com `created_at`
  depois do corte; fork, arquivado, privado, entrada sem nome e repo que se
  declara interno ("An internal component used by DeepSeek Harness") ficam
  fora. Sem token: 60 requisições/hora por IP, e o gate faz 3.
- **Releases** (`method: "github-releases"`): Atom oficial
  `https://github.com/{org}/{repo}/releases.atom`, lido pelo mesmo parser do
  `fetch-rss.ts`. O Atom não expõe o flag `prerelease`, então o filtro é pela
  tag: só release estável de minor/major. Saem nightly, preview, rc, alpha,
  sub-pacote (`sdk-typescript-v…`, `desktop-v…`) e bump de patch.

## Falha e mudança de formato

- Erro HTTP do GitHub vira mensagem acionável no relatório:
  `HTTP 403 (rate limit, reset HH:MM BRT)` (lê `x-ratelimit-remaining`/`reset`),
  `HTTP 404 (org não encontrada)` ou `HTTP 404 (repo não encontrado)`, ou o
  `message` do corpo. O feed fica `ok: false`.
- Lab com TODOS os feeds falhando na rodada entra em `uncovered_labs` (calculado
  em runtime, `uncoveredLabsAtRuntime`), e o bloco do gate diz "Nada novo nas
  fontes que responderam — N feed(s) com falha", em vez de um "nada novo" sem
  ressalva.
- Cada feed registra `raw_entries` (entradas brutas) e `after_filter` (depois
  do filtro do método, antes do corte por data). Quando há entradas e
  nenhuma foi reconhecida no formato esperado (`format_suspect`), o bloco
  avisa "formato mudou?". Filtro de tag que zera tudo por só haver alpha/rc
  (caso atual do deepseek-harness) não dispara o aviso, porque é o filtro
  funcionando.

## Labs que ficaram de fora do GitHub

- **Meta (`meta-llama`)**: nenhum repo público novo desde 05/2025 e os repos de
  modelo não publicam release. A Meta já é coberta pelo feed oficial da tag AI
  do Newsroom (`about.fb.com/news/tag/ai/feed/`, #9447).
- **Mistral (`mistralai`)**: os repos novos de 2026 são forks e infra
  (`vllm` fork, `search-starter-app`, `mistral-compute-openapi`). O blog
  oficial (`mistral.ai/news/rss`, #9441) já traz os lançamentos.

## Link oficial em LANÇAMENTOS (#160)

`scripts/lib/official-domains.ts` passou a aceitar, para DeepSeek e xAI, o
mesmo recorte que já valia para o Qwen desde 22/09: raiz do repo da org
oficial (`github.com/{org}/{repo}`) e, agora também para os três, a página de
UMA release de tag estável (`github.com/{org}/{repo}/releases/tag/v0.25.0`,
`dsh-v0.2.0`), via `githubOrgRepoPattern`. Tag com sufixo (`-nightly.…`,
`-rc.2`, `-alpha.1`, `-preview.0`) não conta — o padrão vale também no
Stage 1 (categorize e `has_official_link` do scoring), e build noturno não é
link de lançamento. `github.com` inteiro continua não oficial, e issues,
PRs, blobs e a lista de releases não contam.

Efeito no Stage 1, intencional e igual ao QwenLM: uma URL de repo de
`deepseek-ai`/`xai-org` que a pesquisa trouxer passa a cair em lançamento
oficial (travado por teste em `test/official-domains.test.ts`). Por isso o refresh tardio sugere LANÇAMENTOS para esses itens e o
`validate-lancamentos.ts` aceita o link se o editor incluir.

## Limitações conhecidas

- Repo criado privado e aberto depois tem `created_at` da criação, não da
  abertura. Se ele foi criado antes do corte, o refresh não o vê. A API pública
  não expõe a data em que o repo virou público. Esse caso continua coberto só
  pelas newsletters.
- O feed de repos novos traz benchmark e biblioteca de kernel junto com modelo
  (DeepGEMM-Ascend, D2K-Bench). Na janela típica do gate (poucas horas) isso dá
  zero ou um item. A inclusão é sempre decisão do editor.
- O Stage 1 não lê essas fontes (`test/primary-sources-stage1-9644.test.ts`
  lista o motivo de cada uma).
