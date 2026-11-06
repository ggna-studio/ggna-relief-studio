param([Parameter(Mandatory=$true)][string]$EngineSource,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = [IO.Path]::GetFullPath($Destination)
$engineRoot = (Resolve-Path -LiteralPath $EngineSource).Path
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'dist-standalone/standalone/index.html'))) { throw 'Run npm ci and npm run build first.' }
if (Test-Path -LiteralPath $targetRoot) { throw 'Choose a new empty destination directory.' }
if (-not (Test-Path -LiteralPath (Join-Path $engineRoot 'python_embeded/python.exe'))) { throw 'EngineSource must contain python_embeded and ComfyUI.' }
New-Item -ItemType Directory -Path (Join-Path $targetRoot 'app/ui') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'python/ggna_server.py') -Destination (Join-Path $targetRoot 'app/ggna_server.py')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'python/workflow_api.json') -Destination (Join-Path $targetRoot 'app/workflow_api.json')
Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'dist-standalone') | Copy-Item -Destination (Join-Path $targetRoot 'app/ui') -Recurse
foreach ($name in @('KHOI-DONG.bat','DUNG_TOOL.bat')) { Copy-Item -LiteralPath (Join-Path $sourceRoot ('python/'+$name)) -Destination (Join-Path $targetRoot $name) }
foreach ($name in @('HUONG-DAN-SU-DUNG.txt','THIRD-PARTY-NOTICES.md','NOTICE.txt','MODEL-MANIFEST.json','licenses')) { Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $targetRoot $name) -Recurse }
& robocopy $engineRoot (Join-Path $targetRoot 'engine') /E /XJ /XD __pycache__ .git (Join-Path $engineRoot 'ComfyUI/user') (Join-Path $engineRoot 'ComfyUI/input') (Join-Path $engineRoot 'ComfyUI/output') (Join-Path $engineRoot 'ComfyUI/temp') (Join-Path $engineRoot 'ComfyUI/data') /XF *.pyc *.pyo .env .env.* extra_model_paths.yaml .comfy_environment was_suite_history.json was_suite_settings.json was_suite_config.json /R:1 /W:1 /NFL /NDL /NJH /NP
if ($LASTEXITCODE -gt 7) { throw 'Engine copy failed.' }
$wasConfig = Join-Path $targetRoot 'engine/ComfyUI/custom_nodes/was-node-suite-comfyui/was_suite_config.json'
@{ run_requirements=$false; suppress_uncomfy_warnings=$true; show_startup_junk=$false; show_inspiration_quote=$false; text_nodes_type='STRING'; webui_styles=$null; webui_styles_persistent_update=$false; history_display_limit=36; use_legacy_ascii_text=$false; wildcard_api=$false } | ConvertTo-Json | Set-Content -LiteralPath $wasConfig -Encoding utf8
Write-Host ('Bundle prepared: '+$targetRoot)
Write-Host 'Check model hashes and distribution rights before sharing.'
