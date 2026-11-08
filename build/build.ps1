param(
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$distRoot = Join-Path $root 'dist'
$app = Join-Path $distRoot 'Antigravity Switcher'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (!(Test-Path $NodeExe)) { throw "node.exe not found: $NodeExe" }
if (!(Test-Path $csc)) { throw "csc.exe not found: $csc" }

if (Test-Path $distRoot) { Remove-Item $distRoot -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $app 'app') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $app 'runtime') -Force | Out-Null

Copy-Item $NodeExe (Join-Path $app 'runtime\node.exe')
Copy-Item (Join-Path $root 'agpanel.js') (Join-Path $app 'app\agpanel.js')
Copy-Item (Join-Path $root 'ui.js') (Join-Path $app 'app\ui.js')
Copy-Item (Join-Path $root 'cred.ps1') (Join-Path $app 'app\cred.ps1')
Copy-Item (Join-Path $root 'version.json') (Join-Path $app 'app\version.json')
Copy-Item (Join-Path $PSScriptRoot 'README-dist.txt') (Join-Path $app 'README.txt')
Copy-Item (Join-Path $root 'assets\icon.ico') (Join-Path $app 'app.ico')

$exe = Join-Path $app 'Antigravity Switcher.exe'
& $csc /nologo /target:winexe /optimize+ "/out:$exe" "/win32icon:$(Join-Path $app 'app.ico')" `
    /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
    (Join-Path $PSScriptRoot 'launcher.cs')
if ($LASTEXITCODE -ne 0 -or !(Test-Path $exe)) { throw 'csc failed' }

$zip = Join-Path $root 'Antigravity Switcher.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $app -DestinationPath $zip -CompressionLevel Optimal

Write-Host ("OK: {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
