; VALORANT Store Watcher - per-user installer (no admin rights required)
; Built by scripts/build-win-installer.mjs with native makensis (no Wine needed).
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define APPNAME "VALORANT Store Watcher"
!define EXENAME "VALORANT Store Watcher.exe"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.vsw.valorant-store-watcher"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\valorant-store-watcher"
InstallDirRegKey HKCU "Software\valorant-store-watcher" "InstallDir"
BrandingText "${APPNAME} ${VERSION} (非公式)"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} Installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Unofficial fan-made tool. Not affiliated with Riot Games."

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXENAME}"
!define MUI_FINISHPAGE_RUN_TEXT "VALORANT Store Watcher を起動する"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "license_ja.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Japanese"

Function .onInit
  ; close a running instance so files can be replaced
  nsExec::Exec 'taskkill /IM "${EXENAME}" /F'
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${SRCDIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\valorant-store-watcher" "InstallDir" "$INSTDIR"
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "VALORANT Store Watcher contributors"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\${EXENAME}"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${REGKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${EXENAME}" /F'
  ; remove the login item created by the app (Electron registers it under this name)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.vsw.valorant-store-watcher"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.VALORANT Store Watcher"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "Software\valorant-store-watcher"
  ; user data (%APPDATA%\VALORANT Store Watcher: wishlist, history, encrypted webhook) is kept intentionally.
  MessageBox MB_YESNO "ウィッシュリスト・履歴・暗号化済みWebhook設定などのユーザーデータも削除しますか？" IDNO +2
    RMDir /r "$APPDATA\${APPNAME}"
SectionEnd
