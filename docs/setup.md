# Setup completo (1x por máquina)

## rembg para capas de vídeo (#11071)

Premissa original: **Neo, Windows x64 do editor**, é a máquina de mídia/capas.
Desde o #11223 (viagem do editor, o Neo ligado poucas horas por dia) o mesmo
setup também roda no **300 (Linux x86_64)**, para o `/diaria-publica-video`
sair inteiro de lá, comandado do celular. Este patch só versiona o setup; não
instala dependências no host que implementa a issue. A instalação em cada
máquina fica pendente até executar os comandos abaixo.

Para saber o que falta numa máquina (ffmpeg, Codex CLI, Georgia, este venv),
sem instalar nada:

```bash
npx tsx scripts/check-video-env.ts
```

Exit 0 = a capa sai ali; exit 1 = o relatório diz, por item, o passo bloqueado
e o comando de setup. Em 27/10/2026, no 300, só o venv do rembg faltava.

Instalar CPython **3.11.9 x64** (python.org). Na raiz do checkout no Neo:

```powershell
py -3.11 scripts/setup-rembg.py
.\.venv-rembg\Scripts\python.exe scripts/setup-rembg.py --check
.\.venv-rembg\Scripts\python.exe scripts/setup-rembg.py --input retrato-original.png --output retrato.png
```

No **300 (Linux x86_64)**, a mesma versão exata, via `uv` (sem mexer no
Python do sistema). Na raiz do checkout:

```bash
uv python install 3.11.9
"$(uv python find 3.11.9)" scripts/setup-rembg.py
.venv-rembg/bin/python scripts/setup-rembg.py --check
.venv-rembg/bin/python scripts/setup-rembg.py --input retrato-original.png --output retrato.png
```

O lock (`scripts/rembg-requirements.txt`) é o mesmo das duas máquinas; no
Linux ele ainda não foi instalado de ponta a ponta. Se o `pip install
--only-binary=:all:` recusar alguma versão por falta de wheel Linux, o erro
aborta o setup (nada é trocado em silêncio): ajustar o pin com o editor.

Georgia no 300: a fonte é proprietária e não entra no repo (#4090). Em
27/10/2026 ela já resolvia no raster do 300; se o check acusar falta, copiar
`georgia*.ttf` do Neo (`C:\Windows\Fonts`) para `~/.local/share/fonts/` e
rodar `fc-cache -f`. Codex CLI: `docs/codex-image-setup.md`, login pela conta
ChatGPT.

O setup exige essa versão exata, cria `.venv-rembg/` na raiz deste checkout
(ignorado pelo git, fora de `data/`/OneDrive), fixa pip 25.0.1 e instala
`scripts/rembg-requirements.txt` (rembg 2.0.67, ONNX Runtime CPU 1.20.1 e
dependências transitivas pinadas). É repetível; não ativa venv nem depende
de `rembg` no PATH. Para recriar, apagar apenas `.venv-rembg/` e repetir.
O recorte usa `birefnet-portrait`, CPU, e cache `.venv-rembg/models/`;
a primeira execução baixa o modelo e requer rede. Falha de download/importação
ou versão divergente aborta com erro, sem substituição de modelo ou imagem.

Quem valida esse ambiente é o passo de recorte (`--input/--output` roda o
`--check` antes). `gen-youtube-thumb.ts` só consome o PNG já recortado, não
exige o venv (#11162: a capa horizontal sai em qualquer máquina com o retrato
em mãos) e recusa retrato sem transparência. O Short usa um frame via ffmpeg, sem rembg;
seu fluxo permanece independente. Composição/testes unitários não requerem
instalar Python ou baixar modelos. A validação real de DLLs/modelo e um recorte
de ponta a ponta devem ser feitos na máquina (Neo ou 300) após o setup.

## Vídeo: montagem (#11642)

`/diaria-video-montagem` roda no Neo (bruto em `G:`, Drive for desktop) e no
300 (pasta da edição pela API do Drive, #11639/#11640/#11641). Precisa de
ffmpeg, de um Python com faster-whisper e do modelo `large-v3-turbo` no cache do
Hugging Face: a transcrição roda com `HF_HUB_OFFLINE=1`, então o modelo tem de
estar baixado antes. O diagnóstico, que é o Passo 0 da skill:

```bash
npx tsx scripts/check-video-env.ts --montagem --edition AAMMDD
```

Setup do venv próprio (o `video-montagem.ts` usa `~/.venv-video-montagem`
sozinho quando ele existe; `DIARIA_VIDEO_PYTHON` aponta para outro). Linux (o 300):

```bash
uv venv --python 3.12 ~/.venv-video-montagem
VIRTUAL_ENV=~/.venv-video-montagem uv pip install faster-whisper
~/.venv-video-montagem/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', device='cpu', compute_type='int8')"
```

O último comando baixa o modelo (~1,6 GB, uma vez, com rede). No 300, em
29/10/2026, `python` resolvia para o venv do Hermes (que tinha faster-whisper
por acaso) e o cache só tinha os modelos `base` e `small`: daí o venv próprio. O
Neo segue com o Python do usuário (`python` do PATH).

No 300 o bruto é baixado para `~/.cache/diaria-video-montagem/{AAMMDD}/bruto/`
(em disco: o `/tmp` dele é tmpfs) e o check pede 3x o tamanho do bruto livre;
apagar a pasta da edição depois do `/diaria-publica-video` libera o espaço.
Auth: o OAuth do projeto (`data/.credentials.json`), o mesmo do
`fetch-drive-video.ts`.

## Demais dependências

> Gerador de imagens via assinatura ChatGPT (Codex CLI, sem custo por uso): ver `docs/codex-image-setup.md` (#9088).

Movido do `CLAUDE.md` na rodada de enxugamento do #8228 — conteúdo de
instalação/troubleshooting não precisa estar no arquivo carregado
incondicionalmente em toda sessão e todo dispatch de subagente. `CLAUDE.md`
§"Como usar" mantém só a lista de passos + este ponteiro.

Se você está montando uma máquina do zero pela primeira vez, `docs/installation.md`
é o walkthrough mais didático (pré-requisitos em tabela, validação por seção);
este arquivo é o texto original que o `CLAUDE.md` carregava — mais denso,
mesmo conteúdo operacional, com achados ao vivo (#7106, #4823 etc.) que o
`installation.md` não repete.

1. Exportar `CLARICE_API_KEY` no ambiente do shell. **Uma key serve os dois caminhos** da Clarice: o MCP (`.mcp.json` manda no header `X-Clarice-Api-Key`, montado pelo `headersHelper` `scripts/mcp/clarice-headers.mjs`, que lê a key do `.env` do projeto, #11251 — o Claude Code tira do ambiente do helper as vars com `KEY` no nome, então a exportada no shell não chega a ele; ela só vale pelo `${CLARICE_API_KEY}` estático, que cobre pasta sem trust aceito, `claude -p` sem trust e máquina sem a key no `.env`, onde o helper devolve `{}`. Ponha a key no `.env` **e** no ambiente) e o REST fallback (`scripts/clarice-correct.ts` → `cortex.clarice.ai`). Pegue a sua em https://cortex.clarice.ai (cada usuário usa a própria — o servidor é passthrough, não tem key compartilhada). No Windows (persistente, requer reabrir o terminal):
   ```powershell
   [Environment]::SetEnvironmentVariable("CLARICE_API_KEY", "SEU_TOKEN_AQUI", "User")
   ```
   Sem ela o invariant `clarice-key-set` **halta a pipeline no Stage 0**. Veja `.env.example`.
1a. **Node ≥22.18 (recomendado: Node 24, `.nvmrc` do repo — mesma versão do CI).** Dois pisos distintos, o maior manda: `node:sqlite` (`scripts/lib/clarice-db.ts`, usado pelo dashboard Clarice/Brevo e pelo Studio) é builtin a partir do 22.5; o **type-stripping nativo de TypeScript sem flag** só vem no 22.18 (#7106) — e a `statusLine` de `.claude/settings.json` roda `node scripts/overnight-statusline.ts` direto, sem transpiler, então abaixo disso a barra de progresso simplesmente não sobe. Node do sistema/distro costuma vir mais antigo (achado ao vivo #4823: Ubuntu com Node 20.20.2 via `apt` derrubou o Studio server com erro nativo opaco). Use `nvm use`/`fnm use`/`asdf install` antes de `npm install`.
1b. **(Opcional, recomendado) `.env` completo via Doppler em vez de copiar ~40 chaves à mão (#5149).** O vault do projeto (workspace `diar.ia.br`, plano Developer/grátis) já tem todas as secrets do `.env.example` sincronizadas. Instalar o CLI (https://docs.doppler.com/docs/install-cli), `doppler login` (1x por máquina — o `doppler.yaml` versionado neste repo já aponta pro projeto/config certo, sem precisar de `doppler setup` interativo), depois `npm run sync-env` sempre que precisar puxar o snapshot atual. Sem acesso ao workspace: seguir o passo 1 acima + preencher `.env.example` manualmente (fallback que sempre funcionou). Detalhes: `docs/doppler-env-sync.md`.
2. `npm install` no diretório.
2a. `npm run setup-hooks` — instala o hook `pre-commit` (regenera `context/sources.md` automaticamente ao editar `seed/sources.csv`; **e, desde o #8878, também recusa `git commit` direto em `master`/`main` neste checkout** — ver `scripts/lib/master-commit-guard.ts`). No checkout compartilhado do `300` isto é especialmente importante: é o único guard que cobre commit feito pelo agente NATIVO do gateway Hermes/Telegram (fora do Claude Code inteiramente, então `.claude/hooks/block-continuo-master-commit.mjs` não o alcança) — reinstalar sempre que o checkout for recriado (hooks git não são versionados).
2b. **`data/` mora no OneDrive, não no repo.** A pasta `data/` é uma *directory junction* local apontando para `~/OneDrive/Documentos/diaria-studio-data` (sync entre máquinas, business-sensitive não vai pro GH). Criar 1x por máquina, **antes de rodar qualquer skill** (`data/` não existe num clone fresco — scripts que tentarem escrever ali vão falhar):
   ```powershell
   # Windows + OneDrive PT-BR (default desta máquina):
   New-Item -ItemType Junction -Path "data" -Target "$env:USERPROFILE\OneDrive\Documentos\diaria-studio-data"
   ```
   **Ajustar o target ao OneDrive local** — varia por OS/idioma:
   - Windows EN: `$env:USERPROFILE\OneDrive\Documents\diaria-studio-data`
   - macOS: `ln -s ~/Library/CloudStorage/OneDrive-Personal/Documents/diaria-studio-data data` (ou path equivalente do app instalado)
   - Linux (rclone/onedriver): `ln -s <mount-point>/Documents/diaria-studio-data data`

   A pasta-alvo no OneDrive precisa existir antes (criar manualmente na 1ª máquina; nas demais, o OneDrive já sincronizou). Toda `data/` está em `.gitignore` blanket — nada lá dentro vai pro repo.
3. `npm run sync-sources` para gerar `context/sources.md`.
3a. **Instalar a skill `humanizador`** (repo separado, instalação global — não é vendorada aqui, ver #1676):
   ```bash
   git clone https://github.com/vjpixel/humanizador.git ~/.claude/skills/humanizador
   ```
   **Não é opcional:** o Stage 2 invoca `Skill("humanizador", …)` 2× (newsletter + social) e, por decisão do #1072, ausência/no-op = **abort do Stage 2** após 3 retries — nunca fallback silencioso. `verify-stage-2` também trata `02-humanized.md ≠ 02-normalized.md` como invariante. Confirme com `/humanizador` ou reabrindo o Claude Code.
3b. **Plugin `pr-review-toolkit`** (agentes do review automatizado, #4234). A habilitação já vem versionada em `.claude/settings.json` (`enabledPlugins`), mas os arquivos do plugin vêm do marketplace por máquina — na 1ª sessão de um clone novo, rodar:
   ```
   /plugin install pr-review-toolkit@claude-plugins-official
   /reload-plugins
   ```
   Confirme com `/agents`: `pr-review-toolkit:code-reviewer` deve aparecer. **É opcional de propósito** — sem ele o hook pós-PR e as Fases 1.5 caem no `general-purpose` com rubrico inline (review pior, nunca review nenhum). Diferente do `humanizador` (3a), que aborta o Stage 2 se faltar.
4. Abrir Claude Code neste diretório: `cd diaria-studio && claude`.
5. Confirmar que os MCPs estão ativos: `/mcp` deve listar `clarice` (HTTP, de `.mcp.json` — header-auth via `headersHelper` que lê `CLARICE_API_KEY` do `.env`, #11251, **não** OAuth; a var do ambiente só entra pelo `${CLARICE_API_KEY}` estático, quando o helper não roda ou devolve `{}`; 401 com a key certa no `.env` = pasta do projeto sem trust aceito, o helper não roda), `claude.ai Beehiiv` e `claude.ai Gmail` (conectores nativos). Para Fase 2 (imagens), instalar ComfyUI local (ver `docs/comfyui-setup.md`). Para Fase 3 (publicação), instalar e logar a extensão `Claude in Chrome` em Beehiiv/LinkedIn/Facebook (ver `docs/browser-publish-setup.md`). Para o MCP `google-ads` (opcional): requer `pipx` (para instalar o servidor) + `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` via Doppler materializada com `npx tsx scripts/materialize-google-ads-credentials.ts` — ver `docs/google-ads-api-setup.md` (#6450). **Instalar o servidor uma vez com `pipx install git+https://github.com/googleads/google-ads-mcp.git`** (#8994): o wrapper `scripts/mcp/run-google-ads-mcp.mjs` usa o binário instalado quando existe e só cai em `pipx run --spec` (que re-resolve o repo git — medido 54,5s com cache frio no Neo, acima do timeout de 30s do harness; 9,3s com cache quente) se ele faltar, avisando em stderr.
5a. **MCP `doppler` (opcional, #8676) — consulta interativa de secrets dentro da sessão.** Distinto do `doppler run` (injeção de env vars em processos automatizados, inalterado) — este MCP é pra buscar/conferir um secret sem sair da sessão. `.mcp.json` já declara o server (`npx -y @dopplerhq/mcp-server --read-only`, via wrapper `scripts/mcp/run-doppler-mcp.mjs`, que repassa `DOPPLER_MCP_TOKEN` como `DOPPLER_TOKEN` e, sem token, sai com erro claro em stderr em vez de subir o servidor vazio — #8994). Gerar um **Service Account Token dedicado, escopo SOMENTE LEITURA** no painel do Doppler (workspace `diar.ia.br` → Access → Service Tokens) — **não reusar** o token que autentica `doppler login`/`doppler run` nesta máquina, que tem escopo mais amplo do que uma sessão interativa precisa (princípio de menor privilégio; o pedido original da #8676 já sinalizava isso). Gravar como `DOPPLER_MCP_TOKEN=` no `.env` do projeto (o wrapper lê de lá, #8994; variável de ambiente exportada também vale e tem precedência) — nunca literal em `.mcp.json` nem em arquivo versionado. O `--read-only` no comando bloqueia os write tools no client, mas é defesa em profundidade — o escopo do token é a defesa real (docs.doppler.com/docs/mcp confirma: "all token permissions are ultimately validated by the Doppler API"). Confirmar com `/mcp`.
5b. **MCPs stdio `google-ads` e `doppler` sobem por wrapper Node (#8994).** O harness interpola `${VAR}` do `.mcp.json` só a partir do ambiente do próprio processo do Claude Code, que **não** carrega o `.env` do projeto — credencial que vive só no `.env` chegava vazia ao servidor. Por isso `.mcp.json` aponta `node scripts/mcp/run-{google-ads,doppler}-mcp.mjs`, que leem do `.env` só as chaves que o servidor usa (`GOOGLE_ADS_*`/`GOOGLE_APPLICATION_CREDENTIALS`; `DOPPLER_MCP_TOKEN`), sem sobrescrever var já presente e não vazia no ambiente. Basta a credencial estar no `.env` — não precisa exportar como variável de usuário do Windows. Os `args` do `.mcp.json` são caminhos relativos à raiz do repo: a sessão do Claude Code precisa começar na raiz do repo (não num subdiretório) para os wrappers serem encontrados.
6. **Inbox editorial** (endereço em `docs/gmail-inbox-setup.md`): nenhum setup necessário — o drain busca direto na pasta Enviados da conta pessoal. Isso permite enviar links/temas durante o dia que são considerados na próxima edição automaticamente.
7. Rodar `/diaria-atualiza-audiencia` para importar respostas de survey do Beehiiv em `data/audience-raw.json` (re-rodar semanalmente ou quando quiser recalibrar). O `context/audience-profile.md` é regenerado automaticamente no Stage 0, combinando CTR comportamental (primário) e survey (secundário).
8. **Config do Claude Code entre máquinas (#4804).** `~/.claude` (settings, comandos, agentes, CLAUDE.md global) é sincronizado via repo privado `github.com/vjpixel/claude-config`, não via OneDrive — nova máquina roda `git clone https://github.com/vjpixel/claude-config.git ~/claude-config && ~/claude-config/bootstrap.sh` (`bootstrap.ps1` no Windows). **A propagação é automática desde o #6310** — antes nada puxava, e config commitada valia só na máquina de origem, em silêncio. Conservador por padrão (nunca força, nunca resolve conflito sozinho); estado do último check em `~/claude-config/.sync-state.json`. Ver `docs/claude-config-sync.md` para o mecanismo completo, o que fica de fora de propósito (credenciais) e o estado pendente do rollout. **`memory/` NÃO fica mais de fora** — a política de "nunca commitar" foi revertida em 06/09/2026 (#7533): sincroniza via repo git próprio e privado (distinto do `claude-config`), `MEMORY.md` passa a ser gerado (nunca editado à mão) por `scripts/extract-memory-index.ts`/`scripts/regenerate-memory-index.ts`, e `scripts/memory-sync.ts` faz o auto-commit + `pull --rebase` — ver `docs/claude-config-sync.md` §"Política de `memory/`" para o setup manual 1x do repo remoto.

   **⚠️ Máquina nova no Windows: ligar o Modo Desenvolvedor e RELOGAR ANTES do bootstrap** — o privilégio de symlink só entra no token no próximo logon, e sem ele o bootstrap cai num fallback de cópia que faz o `git pull` atualizar o repo sem o conteúdo nunca chegar a `~/.claude`. A falha é silenciosa: a máquina roda config velha indefinidamente (era o estado do Neo até 06/09). Conferir depois, sem confiar no "sucesso" que o bootstrap imprime — comando e diagnóstico em `docs/claude-config-sync.md`.
