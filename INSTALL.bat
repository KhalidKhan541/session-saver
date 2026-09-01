@echo off
echo ===================================
echo  Session Saver - Icon Generator
echo ===================================
echo.
echo Chrome extension icons need to be PNG files.
echo.
echo Option 1: Open generate-icons.html in a browser,
echo           right-click each canvas, save as PNG
echo           to the icons\ folder.
echo.
echo Option 2: Use any image editor to create:
echo   icons\icon16.png   (16x16)
echo   icons\icon32.png   (32x32)
echo   icons\icon48.png   (48x48)
echo   icons\icon128.png  (128x128)
echo.
echo A simple blue circle with white "S" works great.
echo.
if not exist icons mkdir icons
echo Created icons\ directory if it didn't exist.
echo.
echo Once icons are in place, load the extension:
echo   1. Open chrome://extensions
echo   2. Enable "Developer mode"
echo   3. Click "Load unpacked"
echo   4. Select this folder: %CD%
echo.
pause
