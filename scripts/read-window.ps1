param([int]$OwnerProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class WindowReader {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    public static string[] Read(int owner) {
        var handle = GetForegroundWindow();
        uint process;
        GetWindowThreadProcessId(handle, out process);
        if (handle == IntPtr.Zero || process == owner) throw new InvalidOperationException();
        var root = AutomationElement.FromHandle(handle);
        string title = root.Current.Name;
        var focused = AutomationElement.FocusedElement;
        for (int depth = 0; focused != null && depth < 8; depth++) {
            var info = focused.Current;
            if (info.ProcessId != process || info.IsPassword) throw new InvalidOperationException();
            object value;
            if (focused.TryGetCurrentPattern(TextPattern.Pattern, out value)) {
                var text = ((TextPattern)value).DocumentRange.GetText(500001);
                if (GetForegroundWindow() != handle) throw new InvalidOperationException();
                return new string[] { title, text };
            }
            focused = TreeWalker.ControlViewWalker.GetParent(focused);
        }
        throw new InvalidOperationException();
    }
}
'@
try {
    $content = [WindowReader]::Read($OwnerProcessId)
    [Console]::WriteLine((@{ title = $content[0]; text = $content[1] } | ConvertTo-Json -Compress))
} catch {
    [Console]::WriteLine('{"error":"unavailable"}')
}
