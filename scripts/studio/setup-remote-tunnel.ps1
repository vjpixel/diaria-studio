<#
.SYNOPSIS
    Guia o editor pela ativação do acesso remoto ao studio-server via
    Cloudflare Tunnel (#3560, fatia 6 do epic "Studio UI" #3554).

.DESCRIPTION
    Prepara e (quando possível) executa os passos de setup do Cloudflare
    Tunnel que expõe o studio-server local (http://127.0.0.1:4174) num
    hostname público dedicado (ex: studio.diar.ia.br), SEM abrir porta
    nenhuma — o tunnel é uma conexão de saída do cloudflared pra borda
    Cloudflare.

    Este script NÃO configura o Cloudflare Access (allowlist de e-mail +
    OTP/IdP) — isso é feito no painel Cloudflare (dash.cloudflare.com > Zero
    Trust > Access > Applications), não em código nem via este script. Ver
    docs/studio-ui-remote-setup.md para o passo-a-passo completo do Access.

    Passos cobertos (nessa ordem, idempotente — pode rodar de novo a
    qualquer momento pra retomar de onde parou):

      1. Verifica se `cloudflared` está instalado (senão, imprime instruções
         de instalação — winget/download direto).
      2. Verifica se já há login (cert.pem em ~/.cloudflared) — senão,
         IMPRIME a instrução `cloudflared tunnel login` pro editor rodar
         manualmente (abre browser pra autenticar na conta Cloudflare —
         não é automatizável, e este script nunca autentica em nome do
         editor).
      3. Cria o tunnel nomeado (idempotente — se já existir, reusa).
      4. Gera `~/.cloudflared/config.yml` apontando ingress pro
         studio-server local.
      5. Roteia o DNS do hostname público pro tunnel
         (`cloudflared tunnel route dns`) — cria/atualiza um CNAME na zona
         Cloudflare do domínio.
      6. Registra uma task no Task Scheduler (mesmo padrão do watchdog
         overnight #2688 — ver scripts/overnight/setup-watchdog-schedule.ps1)
         pra rodar `cloudflared tunnel run` no logon do editor, mantendo o
         tunnel ativo sem terminal aberto.

    Os passos 3, 5 e 6 mutam recursos reais (tunnel na conta Cloudflare do
    editor / task local) — por isso só rodam quando o EDITOR executa este
    script na própria máquina, autenticado com a própria conta. Use
    -DryRun pra ver o plano sem executar nada.

.PARAMETER TunnelName
    Nome do tunnel Cloudflare (default: "diaria-studio").

.PARAMETER Hostname
    Hostname público dedicado (ex: studio.diar.ia.br). Obrigatório pros
    passos 5 (DNS) — sem ele, o script para depois do passo 4 e imprime a
    instrução de rodar de novo com -Hostname.

.PARAMETER Port
    Porta local do studio-server (default: 4174, igual DEFAULT_PORT em
    scripts/studio-ui/server.ts).

.PARAMETER DryRun
    Mostra o plano (o que seria instalado/criado/registrado) sem executar
    nenhum comando que mute estado.

.PARAMETER Unregister
    Remove a task "Diaria-Studio-Tunnel" do Task Scheduler (não desfaz o
    tunnel nem o DNS na Cloudflare — isso é feito no painel CF ou via
    `cloudflared tunnel delete`).

.EXAMPLE
    # Ver o plano sem executar nada:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File scripts\studio\setup-remote-tunnel.ps1 -Hostname studio.diar.ia.br -DryRun

.EXAMPLE
    # Rodar de fato (após já ter feito `cloudflared tunnel login` uma vez):
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File scripts\studio\setup-remote-tunnel.ps1 -Hostname studio.diar.ia.br

.EXAMPLE
    # Remover a task agendada (não desfaz o tunnel/DNS na Cloudflare):
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File scripts\studio\setup-remote-tunnel.ps1 -Unregister

.NOTES
    Issue: #3560 (fatia 6 do epic #3554)
    Documentação: docs/studio-ui-remote-setup.md
    Requer: Windows, cloudflared instalado, conta Cloudflare com o domínio
    (diar.ia.br) já ativo na zona.
#>
param(
    [string]$TunnelName = "diaria-studio",
    [string]$Hostname = "",
    [int]$Port = 4174,
    [switch]$DryRun,
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TaskName = "Diaria-Studio-Tunnel"
$TaskDesc = "Diar.ia Studio: mantém o Cloudflare Tunnel ativo pra acesso remoto (#3560) — roda cloudflared tunnel run no logon."
$CloudflaredDir = Join-Path $env:USERPROFILE ".cloudflared"
$CertPath = Join-Path $CloudflaredDir "cert.pem"
$ConfigPath = Join-Path $CloudflaredDir "config.yml"

function Write-Step($msg) {
    Write-Output ""
    Write-Output "=== $msg ==="
}

# ---------------------------------------------------------------------------
# Remover
# ---------------------------------------------------------------------------
if ($Unregister) {
    $Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($Existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Task '$TaskName' removida."
    } else {
        Write-Output "Task '$TaskName' não encontrada (já removida ou nunca registrada)."
    }
    Write-Output ""
    Write-Output "Isso NÃO remove o tunnel nem o DNS na Cloudflare. Pra desfazer de vez:"
    Write-Output "  cloudflared tunnel route dns --overwrite-dns $TunnelName <old-hostname-se-quiser-liberar>"
    Write-Output "  cloudflared tunnel delete $TunnelName"
    Write-Output "  (e remover o Access Application correspondente no painel CF)"
    exit 0
}

# ---------------------------------------------------------------------------
# Passo 1: cloudflared instalado?
# ---------------------------------------------------------------------------
Write-Step "1/6 — Verificando cloudflared"

$cloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredCmd) {
    Write-Output "cloudflared não encontrado no PATH."
    Write-Output ""
    Write-Output "Instale com winget (recomendado):"
    Write-Output "  winget install --id Cloudflare.cloudflared"
    Write-Output ""
    Write-Output "Ou baixe o binário direto:"
    Write-Output "  https://github.com/cloudflare/cloudflared/releases/latest"
    Write-Output ""
    Write-Output "Depois de instalar, reabra o terminal (PATH precisa recarregar) e rode este script de novo."
    exit 1
}
Write-Output "cloudflared encontrado: $($cloudflaredCmd.Source)"
if (-not $DryRun) {
    & cloudflared --version
}

# ---------------------------------------------------------------------------
# Passo 2: login (cert.pem) — nunca automatizado, é OAuth no browser
# ---------------------------------------------------------------------------
Write-Step "2/6 — Verificando autenticação com a conta Cloudflare"

if (-not (Test-Path $CertPath)) {
    Write-Output "Nenhuma sessão autenticada encontrada ($CertPath ausente)."
    Write-Output ""
    Write-Output "Rode manualmente (abre o browser pra você logar na sua conta Cloudflare"
    Write-Output "e escolher a zona diar.ia.br):"
    Write-Output ""
    Write-Output "  cloudflared tunnel login"
    Write-Output ""
    Write-Output "Depois de autenticar, rode este script de novo pra continuar do passo 3."
    exit 1
}
Write-Output "Sessão autenticada encontrada: $CertPath"

if ($DryRun) {
    Write-Output ""
    Write-Output "[-DryRun] Pararia aqui a verificação de pré-requisitos. Próximos passos (não executados):"
    Write-Output "  3. cloudflared tunnel create $TunnelName"
    Write-Output "  4. gerar $ConfigPath (ingress -> http://127.0.0.1:$Port)"
    if ($Hostname) {
        Write-Output "  5. cloudflared tunnel route dns $TunnelName $Hostname"
    } else {
        Write-Output "  5. (pulado — sem -Hostname) cloudflared tunnel route dns $TunnelName <hostname>"
    }
    Write-Output "  6. registrar task '$TaskName' no Task Scheduler (roda no logon)"
    exit 0
}

# ---------------------------------------------------------------------------
# Passo 3: criar o tunnel (idempotente)
# ---------------------------------------------------------------------------
Write-Step "3/6 — Tunnel '$TunnelName'"

$existingList = & cloudflared tunnel list 2>&1 | Out-String
$tunnelId = $null
if ($existingList -match "(?m)^([0-9a-f-]{36})\s+$([regex]::Escape($TunnelName))\s") {
    $tunnelId = $Matches[1]
    Write-Output "Tunnel '$TunnelName' já existe (id: $tunnelId) — reusando."
} else {
    Write-Output "Criando tunnel '$TunnelName'..."
    & cloudflared tunnel create $TunnelName
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Falha ao criar o tunnel. Veja a saída acima."
        exit 1
    }
    $existingList = & cloudflared tunnel list 2>&1 | Out-String
    if ($existingList -match "(?m)^([0-9a-f-]{36})\s+$([regex]::Escape($TunnelName))\s") {
        $tunnelId = $Matches[1]
    }
}

if (-not $tunnelId) {
    Write-Error "Não consegui determinar o Tunnel ID de '$TunnelName' via 'cloudflared tunnel list'. Rode 'cloudflared tunnel list' manualmente e confira."
    exit 1
}
Write-Output "Tunnel ID: $tunnelId"

# ---------------------------------------------------------------------------
# Passo 4: gerar config.yml
# ---------------------------------------------------------------------------
Write-Step "4/6 — Gerando $ConfigPath"

$credentialsFile = Join-Path $CloudflaredDir "$tunnelId.json"
if (-not (Test-Path $credentialsFile)) {
    Write-Output "Aviso: arquivo de credenciais esperado não encontrado em $credentialsFile"
    Write-Output "  (normal se 'cloudflared tunnel create' salvou em outro lugar — confira a saída acima)."
}

$ingressHostLine = if ($Hostname) {
    "  - hostname: $Hostname`n    service: http://127.0.0.1:$Port"
} else {
    "  # (defina -Hostname e rode de novo pra preencher a linha de ingress abaixo)`n  # - hostname: studio.diar.ia.br`n  #   service: http://127.0.0.1:$Port"
}

$configContent = @"
# Gerado por scripts\studio\setup-remote-tunnel.ps1 (#3560) — idempotente, seguro sobrescrever.
tunnel: $tunnelId
credentials-file: $credentialsFile

ingress:
$ingressHostLine
  - service: http_status:404
"@

Set-Content -Path $ConfigPath -Value $configContent -Encoding UTF8
Write-Output "Escrito: $ConfigPath"

# ---------------------------------------------------------------------------
# Passo 5: DNS
# ---------------------------------------------------------------------------
Write-Step "5/6 — DNS"

if (-not $Hostname) {
    Write-Output "Nenhum -Hostname informado — pulando o roteamento DNS."
    Write-Output "Rode de novo com -Hostname studio.diar.ia.br (ou o hostname que preferir) pra completar."
} else {
    Write-Output "Roteando $Hostname -> tunnel $TunnelName..."
    & cloudflared tunnel route dns $TunnelName $Hostname
    if ($LASTEXITCODE -ne 0) {
        Write-Output "Aviso: 'cloudflared tunnel route dns' retornou erro (pode já existir um registro — confira no painel CF > DNS)."
    } else {
        Write-Output "DNS roteado: $Hostname -> $TunnelName"
    }
}

# ---------------------------------------------------------------------------
# Passo 6: registrar task no Task Scheduler (mesmo padrão do watchdog #2688)
# ---------------------------------------------------------------------------
Write-Step "6/6 — Registrando task '$TaskName' no Task Scheduler"

$Action = New-ScheduledTaskAction `
    -Execute  $cloudflaredCmd.Source `
    -Argument "tunnel --config `"$ConfigPath`" run $TunnelName"

$Trigger = New-ScheduledTaskTrigger -AtLogOn

$Settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RestartCount         999 `
    -RestartInterval      (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit   (New-TimeSpan -Hours 0) # 0 = sem limite (processo de longa duração)

# Register-ScheduledTask -Force cria OU sobrescreve (idempotente) e aceita -Description.
# NÃO usar Set-ScheduledTask no branch de update: ele não tem parâmetro -Description
# (falhava com "NamedParameterNotFound" ao re-rodar sobre uma task existente).
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description $TaskDesc -RunLevel Limited -Force | Out-Null

# #3780 (mesmo bug do #3775): Register-ScheduledTask -Force substitui a task
# INTEIRA (ao contrário de Set-ScheduledTask, que só atualiza os campos
# passados) — qualquer propriedade não especificada nesta chamada volta ao
# default, incluindo Enabled=True. Se o editor tinha desabilitado a task
# manualmente, restaurar esse estado aqui; senão o -Force reativa a task
# silenciosamente, sem log nem aviso.
if ($ExistingTask -and $ExistingTask.State -eq "Disabled") {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

if ($ExistingTask) {
    Write-Output "Task '$TaskName' atualizada."
} else {
    Write-Output "Task '$TaskName' registrada — vai iniciar automaticamente no próximo logon."
}

Write-Output ""
Write-Output "Pra iniciar agora sem esperar o próximo logon:"
Write-Output "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Output ""
Write-Output "=== Resumo ==="
Write-Output "  Tunnel     : $TunnelName ($tunnelId)"
Write-Output "  Config     : $ConfigPath"
Write-Output "  Hostname   : $(if ($Hostname) { $Hostname } else { '(não configurado — rode de novo com -Hostname)' })"
Write-Output "  Studio local: http://127.0.0.1:$Port"
Write-Output "  Task       : $TaskName (Task Scheduler, roda no logon)"
Write-Output ""
Write-Output "PRÓXIMO PASSO (fora deste script, no painel Cloudflare):"
Write-Output "  Configurar o Cloudflare Access na frente do hostname — ver docs/studio-ui-remote-setup.md."
Write-Output "  Sem isso, o hostname fica exposto (mesmo atrás do tunnel) — Access é o que exige login."
Write-Output ""
Write-Output "Depois de configurar o Access, valide com:"
Write-Output "  npx tsx scripts\studio\verify-remote-tunnel.ts --url https://$(if ($Hostname) { $Hostname } else { '<hostname>' })"
