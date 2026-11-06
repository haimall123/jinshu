param([string]$GraalHome = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
if (-not $GraalHome) { throw '请将 JAVA_HOME 设置为包含 native-image 的 GraalVM 21。' }
$javac = Join-Path $GraalHome 'bin\javac.exe'
$nativeImage = Join-Path $GraalHome 'bin\native-image.cmd'
if (-not (Test-Path -LiteralPath $javac) -or -not (Test-Path -LiteralPath $nativeImage)) {
    throw '未找到 GraalVM javac 或 native-image。'
}
$project = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('moira-engine-' + [guid]::NewGuid().ToString('N'))
$classes = Join-Path $buildDirectory 'classes'
$output = Join-Path $buildDirectory 'native'
New-Item -ItemType Directory -Force -Path $classes, $output | Out-Null
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.java' -Recurse | ForEach-Object { $_.FullName })
if ($sources.Count -lt 60) { throw '原始计算源码不完整。' }
& $javac --release 8 -encoding UTF-8 -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw '原计算源码编译失败。' }
$env:JAVA_HOME = $GraalHome
& $nativeImage --no-fallback -O1 -march=compatibility '-Dfile.encoding=UTF-8' '-Djava.locale.providers=COMPAT,CLDR' '-Djava.awt.headless=true' '-H:IncludeLocales=en,zh' '-H:+AddAllCharsets' '--initialize-at-run-time=org.athomeprojects' -cp $classes -o (Join-Path $output 'moira-engine') EmbeddedEngine
$nativeExitCode = $LASTEXITCODE
if ($nativeExitCode -ne 0) { throw '计算核心本机编译失败。' }
$destination = Join-Path $project 'src-tauri\resources\runtime\bin'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $output 'moira-engine.exe') -Destination $destination -Force
Get-ChildItem -LiteralPath $output -Filter '*.dll' -File | Copy-Item -Destination $destination -Force
$licenses = Join-Path $project 'src-tauri\resources\runtime\licenses\graalvm'
New-Item -ItemType Directory -Force -Path $licenses | Out-Null
Copy-Item -LiteralPath (Join-Path $GraalHome 'LICENSE_NATIVEIMAGE.txt') -Destination $licenses -Force
Copy-Item -LiteralPath (Join-Path $GraalHome 'legal') -Destination $licenses -Recurse -Force
Write-Output "计算核心已生成：$destination"
