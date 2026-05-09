@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PYTHON=%~dp0python\python.exe"
set "DEV_PYTHON=%~dp0src-tauri\target\debug\python\python.exe"
set "APP_STATE=%APPDATA%\com.elishapervez.ultimateamv"

set "HW_PACKAGES=torch torchvision torchaudio audio-separator onnxruntime onnxruntime-gpu transnetv2-pytorch scenedetect opencv-python nelux pandas scipy scikit-learn sympy numba llvmlite networkx"

if not exist "!PYTHON!" goto python_missing
goto menu

:python_missing
echo Bundled Python not found at "!PYTHON!"
echo Place the embeddable Python distribution in python\ first.
pause
exit /b 1

:sync_dev_python
if not exist "src-tauri\target\debug" exit /b 0
echo Rebuilding dev target python from root bundled Python...
if exist "src-tauri\target\debug\python" rmdir /s /q "src-tauri\target\debug\python"
xcopy "python" "src-tauri\target\debug\python\" /E /I /H /Y /Q >nul
if errorlevel 2 (
    echo Failed to copy python\ into src-tauri\target\debug\python.
    exit /b 1
)
exit /b 0

:menu
cls
echo.
echo Ultimate AMV - Dev Manager
echo ==========================
echo.
echo Uninstall hardware-dependent packages from the bundled/dev Python runtime.
echo (Overlapping core packages from bundle-deps.ps1 are NOT touched.)
echo.
echo   1. Uninstall PyTorch (torch + torchvision + torchaudio)
echo   2. Uninstall audio-separator
echo   3. Uninstall ONNX Runtime (both CPU and GPU variants)
echo   4. Uninstall ALL hardware-dependent packages
echo.
echo   5. Reset config only (delete app config so wizard reappears)
echo   6. Full fresh-user reset (4 + 5)
echo.
echo   7. Show what's currently installed
echo   8. NUKE site-packages and re-run bundle-deps.ps1 (fix corrupted Python)
echo   0. Exit
echo.
set "choice="
set /p choice="Enter choice: "

if "!choice!"=="1" goto uninstall_pytorch
if "!choice!"=="2" goto uninstall_separator
if "!choice!"=="3" goto uninstall_onnx
if "!choice!"=="4" goto uninstall_all
if "!choice!"=="5" goto reset_config
if "!choice!"=="6" goto full_reset
if "!choice!"=="7" goto list_installed
if "!choice!"=="8" goto nuke_rebuild
if "!choice!"=="0" exit /b 0

echo Invalid choice.
pause
goto menu

:uninstall_pytorch
echo.
echo Uninstalling PyTorch packages...
echo Root bundled Python:
"!PYTHON!" -I -m pip uninstall -y torch torchvision torchaudio
if exist "!DEV_PYTHON!" (
    echo.
    echo Dev target Python:
    "!DEV_PYTHON!" -I -m pip uninstall -y torch torchvision torchaudio
)
goto done

:uninstall_separator
echo.
echo Uninstalling audio-separator...
echo Root bundled Python:
"!PYTHON!" -I -m pip uninstall -y audio-separator
if exist "!DEV_PYTHON!" (
    echo.
    echo Dev target Python:
    "!DEV_PYTHON!" -I -m pip uninstall -y audio-separator
)
goto done

:uninstall_onnx
echo.
echo Uninstalling ONNX Runtime variants...
echo Root bundled Python:
"!PYTHON!" -I -m pip uninstall -y onnxruntime onnxruntime-gpu
if exist "!DEV_PYTHON!" (
    echo.
    echo Dev target Python:
    "!DEV_PYTHON!" -I -m pip uninstall -y onnxruntime onnxruntime-gpu
)
goto done

:uninstall_all
echo.
echo Uninstalling all hardware-dependent packages...
echo Root bundled Python:
"!PYTHON!" -I -m pip uninstall -y !HW_PACKAGES!
if exist "!DEV_PYTHON!" (
    echo.
    echo Dev target Python:
    "!DEV_PYTHON!" -I -m pip uninstall -y !HW_PACKAGES!
)
goto done

:reset_config
echo.
if exist "!APP_STATE!\config.json" del "!APP_STATE!\config.json"
if exist "backend\config.json" del "backend\config.json"
if exist "src-tauri\target\debug\backend\config.json" del "src-tauri\target\debug\backend\config.json"
if exist "src-tauri\target\release\backend\config.json" del "src-tauri\target\release\backend\config.json"
echo Deleted config.json. Wizard will appear on next launch.
goto done

:full_reset
echo.
echo Full fresh-user reset...
echo Root bundled Python:
"!PYTHON!" -I -m pip uninstall -y !HW_PACKAGES!
call :clear_app_state
call :sync_dev_python
if errorlevel 1 goto done
echo Deleted app state and rebuilt the dev target Python runtime.
echo.
echo Done. Next launch will show the setup wizard from scratch.
goto done

:list_installed
echo.
echo Hardware-dependent package status:
echo.
echo Root bundled Python:
"!PYTHON!" -I -m pip show !HW_PACKAGES! 2>nul | findstr /B /C:"Name:" /C:"Version:"
if errorlevel 1 echo   None installed.
echo.
if exist "!DEV_PYTHON!" (
    echo Dev target Python:
    "!DEV_PYTHON!" -I -m pip show !HW_PACKAGES! 2>nul | findstr /B /C:"Name:" /C:"Version:"
    if errorlevel 1 echo   None installed.
) else (
    echo Dev target Python:
    echo   Not built yet.
)
echo.
goto done

:nuke_rebuild
echo.
echo This will completely delete python\Lib\site-packages\ and re-run bundle-deps.ps1.
echo You will then need to run the wizard again to install hardware-dependent packages.
echo.
set "confirm="
set /p confirm="Type YES to proceed: "
if not "!confirm!"=="YES" goto done
echo.
echo Deleting python\Lib\site-packages\ ...
if exist "python\Lib\site-packages" rmdir /s /q "python\Lib\site-packages"
echo Deleting python\Lib\__pycache__\ if any...
if exist "python\Lib\__pycache__" rmdir /s /q "python\Lib\__pycache__"
echo Deleting backend\config.json ...
call :clear_app_state
echo Deleting dev target python directory...
if exist "src-tauri\target\debug\python" rmdir /s /q "src-tauri\target\debug\python"
echo.
echo Re-running bundle-deps.ps1 to populate fresh site-packages...
powershell -NoProfile -ExecutionPolicy Bypass -File ".\bundle-deps.ps1"
if errorlevel 1 (
    echo.
    echo bundle-deps.ps1 failed. Check the output above.
    goto done
)
call :sync_dev_python
if errorlevel 1 goto done
echo.
echo Done. Bundled Python is freshly populated. Launch the app to run the setup wizard.
goto done

:clear_app_state
if exist "!APP_STATE!" rmdir /s /q "!APP_STATE!"
if exist "backend\config.json" del "backend\config.json"
if exist "backend\audio_history.json" del "backend\audio_history.json"
if exist "backend\app_logs.json" del "backend\app_logs.json"
if exist "backend\logs" rmdir /s /q "backend\logs"
if exist "src-tauri\target\debug\backend\config.json" del "src-tauri\target\debug\backend\config.json"
if exist "src-tauri\target\debug\backend\audio_history.json" del "src-tauri\target\debug\backend\audio_history.json"
if exist "src-tauri\target\debug\backend\app_logs.json" del "src-tauri\target\debug\backend\app_logs.json"
if exist "src-tauri\target\debug\backend\logs" rmdir /s /q "src-tauri\target\debug\backend\logs"
if exist "src-tauri\target\release\backend\config.json" del "src-tauri\target\release\backend\config.json"
if exist "src-tauri\target\release\backend\audio_history.json" del "src-tauri\target\release\backend\audio_history.json"
if exist "src-tauri\target\release\backend\app_logs.json" del "src-tauri\target\release\backend\app_logs.json"
if exist "src-tauri\target\release\backend\logs" rmdir /s /q "src-tauri\target\release\backend\logs"
exit /b 0

:done
echo.
pause
goto menu
