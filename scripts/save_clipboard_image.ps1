param([Parameter(Mandatory=$true)][string]$Path)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) {
  Write-Error "Clipboard does not contain an image"
  exit 2
}
try {
  $img.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $Path
} finally {
  $img.Dispose()
}
