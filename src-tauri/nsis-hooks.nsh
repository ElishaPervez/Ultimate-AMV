; Ultimate AMV NSIS installer hooks
;
; Tauri's installer template calls NSIS_HOOK_PREINSTALL right at the start
; of Section Install, BEFORE the CheckIfAppIsRunning macro and BEFORE any
; File copy. We use it to make sure no Python sidecar (clip server, audio
; worker) is still holding python\python.exe / _bz2.pyd / FFmpeg DLLs
; open : otherwise NSIS fails the file overwrite with "Error opening file
; for writing" on update.
;
; The main exe also pins itself to a Windows Job Object with
; KILL_ON_JOB_CLOSE (see setup_kill_on_close_job in src/lib.rs), so its
; children die automatically when the OS releases the job handle. This
; hook is the belt-and-suspenders pass that covers unusual cases (older
; main exes without the Job Object, orphans from a hard crash, sidecars
; spawned with CREATE_BREAKAWAY_FROM_JOB).

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running Ultimate AMV processes..."
  ; /F = force terminate, /T = kill the whole process tree (catches every
  ; child python.exe / pythonw.exe spawned by the main exe). Failure is
  ; expected and silent when the app is not running.
  nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  ; Brief settle so the OS finishes releasing file handles before File copy.
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering .umv project icon..."
  ${If} ${FileExists} "$INSTDIR\icons\project-file.ico"
    WriteRegStr HKCU "Software\Classes\.umv\DefaultIcon" "" "$INSTDIR\icons\project-file.ico,0"
    WriteRegStr HKCU "Software\Classes\UltimateAMV.umv\DefaultIcon" "" "$INSTDIR\icons\project-file.ico,0"
  ${Else}
    WriteRegStr HKCU "Software\Classes\.umv\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
    WriteRegStr HKCU "Software\Classes\UltimateAMV.umv\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  ${EndIf}
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
