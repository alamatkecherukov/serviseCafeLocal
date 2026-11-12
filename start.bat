@echo off
title Restaurant Server
cd /d "%~dp0"

echo ========================================
echo   Запуск сервера ресторана
echo ========================================
echo.
echo Папка: %CD%
echo.

where node
if errorlevel 1 goto no_node

if not exist "node_modules\better-sqlite3" goto bad_modules
if not exist "seed.js" goto no_seed
if not exist "server.js" goto no_server

if not exist "data.db" goto do_seed
goto run_server

:do_seed
echo [1/2] Создаю базу и импортирую меню...
echo.
node seed.js
if errorlevel 1 goto seed_fail
echo.
echo [OK] База создана.
echo.
goto run_server

:run_server
echo [2/2] Запускаю сервер...
echo.
echo ========================================
echo   Сервер работает. Ctrl+C — остановить.
echo ========================================
echo.
node server.js
echo.
echo Сервер остановлен (код: %errorlevel%).
goto end

:no_node
echo [ОШИБКА] Node.js не найден в PATH.
echo Установи с https://nodejs.org и перезапусти.
goto end

:bad_modules
echo [ОШИБКА] Нет node_modules\better-sqlite3.
echo Выполни: npm install
goto end

:no_seed
echo [ОШИБКА] Нет файла seed.js в %CD%
goto end

:no_server
echo [ОШИБКА] Нет файла server.js в %CD%
goto end

:seed_fail
echo.
echo [ОШИБКА] seed.js упал. Смотри сообщение выше.
goto end

:end
echo.
echo Нажми любую клавишу для выхода...
pause >nul