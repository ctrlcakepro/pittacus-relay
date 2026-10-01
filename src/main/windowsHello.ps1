# Windows Hello prompt for Pittacus Relay, run by the main process through
# `powershell -Command -` (bundled into app.asar, so no loose script to tamper with).
# Input:  PR_HELLO_MODE = check | verify, PR_HELLO_HWND (window handle), PR_HELLO_MESSAGE
# Output: one line, the UserConsentVerifierAvailability (check) or
#         UserConsentVerificationResult (verify) value name.
& {
  $ErrorActionPreference = 'Stop'
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Await($op, [Type]$type) {
      $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
      $task.Wait()
      $task.Result
    }

    if ($env:PR_HELLO_MODE -eq 'check') {
      [string](Await ($verifier::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]))
      exit 0
    }

    # RequestVerificationAsync alone opens the prompt behind other windows for desktop apps;
    # the HWND-taking interop makes it modal to Pittacus Relay's window instead.
    Add-Type -ReferencedAssemblies ([System.WindowsRuntimeSystemExtensions].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;

[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IUserConsentVerifierInterop {
  [return: MarshalAs(UnmanagedType.IInspectable)]
  object RequestVerificationForWindowAsync(IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
}

public static class PittacusHello {
  public static object Request(Type verifier, IntPtr window, string message) {
    // IID of IAsyncOperation<UserConsentVerificationResult>.
    Guid iid = new Guid("fd596ffd-2318-558f-9dbe-d21df43764a5");
    var factory = (IUserConsentVerifierInterop)WindowsRuntimeMarshal.GetActivationFactory(verifier);
    return factory.RequestVerificationForWindowAsync(window, message, ref iid);
  }
}
'@
    $op = [PittacusHello]::Request($verifier, [IntPtr][Int64]$env:PR_HELLO_HWND, $env:PR_HELLO_MESSAGE)
    [string](Await $op ([Windows.Security.Credentials.UI.UserConsentVerificationResult]))
    exit 0
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
  }
}

