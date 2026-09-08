param([int]$OwnerProcessId = 0)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Windows.Automation.Text;

public static class SelectedTextReader {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    public static string Read(int excludedProcess) {
        uint activeProcess;
        GetWindowThreadProcessId(GetForegroundWindow(), out activeProcess);
        if (activeProcess == excludedProcess) return "";
        AutomationElement element = AutomationElement.FocusedElement;
        for (int depth = 0; element != null && depth < 5; depth++) {
            var info = element.Current;
            if (info.ProcessId == excludedProcess || info.IsPassword || info.ProcessId != activeProcess) return "";
            object pattern;
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
                TextPatternRange[] selection = ((TextPattern)pattern).GetSelection();
                if (selection.Length == 0) return "";
                return selection[0].GetText(16001).Trim();
            }
            element = TreeWalker.ControlViewWalker.GetParent(element);
        }
        return "";
    }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  if ($line -ne 'read') { continue }
  try {
    $text = [SelectedTextReader]::Read($OwnerProcessId)
    if ($text.Length -gt 16000) {
      $result = @{ text = ''; error = 'too_long' }
    } else { $result = @{ text = $text; error = '' } }
  } catch { $result = @{ text = ''; error = 'unavailable' } }
  [Console]::WriteLine(($result | ConvertTo-Json -Compress))
}
