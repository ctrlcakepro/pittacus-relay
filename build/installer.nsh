; Picked up automatically by electron-builder (nsis.include defaults to build/installer.nsh).

; Remove the launch-at-login entry on a real uninstall, but keep it when the
; old version is uninstalled as part of an in-place upgrade.
; The value name is the app's AppUserModelId (appId in electron-builder.yml).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.ctrlcakepro.pittacus-relay"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "io.github.ctrlcakepro.pittacus-relay"
  ${endIf}
!macroend
