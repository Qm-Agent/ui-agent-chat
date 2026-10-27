$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$project = Join-Path $repo "native-automation/providers/windows/DTGuiComputer.WindowsProvider.csproj"
$output = Join-Path $repo "native-automation/target/native-provider/windows"
$runtime = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }

New-Item -ItemType Directory -Force -Path $output | Out-Null
dotnet publish $project `
  --configuration Release `
  --runtime $runtime `
  --self-contained true `
  -p:PublishSingleFile=true `
  --output $output

$provider = Join-Path $output "DTGuiComputer.WindowsProvider.exe"

Write-Host "[native-automation] Windows UI Automation Provider: $provider"
