param([switch]$TriggerHotkey, [switch]$HoldSelection)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FixtureFocus {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);

    public static void Activate(IntPtr window) {
        uint current = GetCurrentThreadId();
        uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
        try { SetForegroundWindow(window); }
        finally { if (attached) AttachThreadInput(current, foreground, false); }
    }
}
'@
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'TermLens Selection Test'
$form.Width = 500
$form.Height = 180
$form.TopMost = $true
$box = [System.Windows.Forms.TextBox]::new()
$box.Multiline = $true
$box.Dock = 'Fill'
$box.Text = 'TermLens selection fixture'
$form.Controls.Add($box)
$state = @{ process = $null; task = $null; stage = 0; failure = ''; started = [DateTime]::UtcNow }
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 300
$timer.Add_Tick({
  try {
    if (([DateTime]::UtcNow - $state.started).TotalSeconds -gt 20) { throw "Native selection test timed out at stage $($state.stage); desktopAvailable=$([FixtureFocus]::GetForegroundWindow() -ne [IntPtr]::Zero); foreground=$([FixtureFocus]::GetForegroundWindow()); fixture=$($form.Handle); selectedLength=$($box.SelectionLength)." }
    if ($state.stage -eq 0) {
      [FixtureFocus]::Activate($form.Handle)
      $box.Focus() | Out-Null
      $box.Select(0, 8)
      $state.stage = -1
    } elseif ($state.stage -eq -1) {
      if ([FixtureFocus]::GetForegroundWindow() -ne $form.Handle) {
        [FixtureFocus]::Activate($form.Handle)
        return
      }
      $box.Focus() | Out-Null
      $box.Select(0, 8)
      if ($TriggerHotkey -or $HoldSelection) {
        [Console]::WriteLine("Selection fixture ready; hold=$HoldSelection; focused=$($box.Focused); selectedLength=$($box.SelectionLength).")
        if ($TriggerHotkey) { [System.Windows.Forms.SendKeys]::SendWait('^+ ') }
        $state.stage = 99
        $state.started = [DateTime]::UtcNow
        return
      }
      $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
      $startInfo.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $helper = Join-Path $PSScriptRoot 'selected-text.ps1'
      $startInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '" -OwnerProcessId 0'
      $startInfo.UseShellExecute = $false
      $startInfo.CreateNoWindow = $true
      $startInfo.RedirectStandardInput = $true
      $startInfo.RedirectStandardOutput = $true
      $startInfo.RedirectStandardError = $true
      $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $state.process = [System.Diagnostics.Process]::Start($startInfo)
      $state.process.StandardInput.WriteLine('read')
      $state.task = $state.process.StandardOutput.ReadLineAsync()
      $state.stage = 1
    } elseif ($state.stage -eq 1 -and $state.task.IsCompleted) {
      if ($null -eq $state.task.Result) { throw ('Native helper failed: ' + $state.process.StandardError.ReadToEnd()) }
      $result = $state.task.Result | ConvertFrom-Json
      if ($result.text -ne 'TermLens') { throw 'Native selection did not match the controlled fixture.' }
      $box.Select(0, 0)
      $state.process.StandardInput.WriteLine('read')
      $state.task = $state.process.StandardOutput.ReadLineAsync()
      $state.stage = 2
    } elseif ($state.stage -eq 2 -and $state.task.IsCompleted) {
      $result = $state.task.Result | ConvertFrom-Json
      if ($result.text -ne '') { throw 'Empty selection was not empty.' }
      $box.Multiline = $false
      $box.UseSystemPasswordChar = $true
      $box.SelectAll()
      $state.process.StandardInput.WriteLine('read')
      $state.task = $state.process.StandardOutput.ReadLineAsync()
      $state.stage = 3
    } elseif ($state.stage -eq 3 -and $state.task.IsCompleted) {
      $result = $state.task.Result | ConvertFrom-Json
      if ($result.text -ne '') { throw 'Password control exposed selected text.' }
      $timer.Stop()
      $form.Close()
    } elseif ($state.stage -eq 99 -and ([DateTime]::UtcNow - $state.started).TotalSeconds -gt 10) {
      [Console]::WriteLine("Selection fixture completed; foreground=$([FixtureFocus]::GetForegroundWindow() -eq $form.Handle); focused=$($box.Focused); selectedLength=$($box.SelectionLength).")
      $timer.Stop()
      $form.Close()
    }
  } catch { $state.failure = $_.Exception.Message; $timer.Stop(); $form.Close() }
})
$form.Add_Shown({ $timer.Start() })
try { [System.Windows.Forms.Application]::Run($form) }
finally {
  $timer.Dispose()
  if ($state.process -and !$state.process.HasExited) { $state.process.Kill() }
  $form.Dispose()
}
if ($state.failure) { throw $state.failure }
if (!$TriggerHotkey -and !$HoldSelection) { 'Native selection tests passed: selected text, empty selection, password control.' }
