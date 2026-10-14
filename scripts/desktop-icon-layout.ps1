param([switch]$Inspect)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'desktop-icon-layout.cs')
    $shell = New-Object -ComObject Shell.Application
    $windows = $shell.Windows()
    $desktopHandle = 0
    $desktop = $windows.FindWindowSW(0, $null, 8, [ref]$desktopHandle, 1)
    if ($null -eq $desktop) { throw 'Windows desktop is unavailable. Confirm Explorer is running.' }
    $before = [HubDesktopIconLayout]::Read($desktop)
    if (-not $Inspect) { [HubDesktopIconLayout]::Arrange($desktop) }
    $after = [HubDesktopIconLayout]::Read($desktop)
    [pscustomobject]@{ok=$true; inspected=[bool]$Inspect; before=$before; after=$after} | ConvertTo-Json -Depth 6 -Compress
} catch {
    [pscustomobject]@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress
    exit 1
}
