@echo off
rem Sets up this clone on Windows: checks the tools, installs and builds the core, writes factory.cmd,
rem installs the Claude Code plugin (user scope). Then run "factory.cmd init" yourself. Safe to run again.
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%" || exit /b 1

rem 1. Tools. Node must be 22 or newer.
where node >nul 2>nul || (echo node is missing: install it from https://nodejs.org & exit /b 1)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" || (echo node is too old: install version 22 or newer from https://nodejs.org & exit /b 1)
where git >nul 2>nul || (echo git is missing: install it from https://git-scm.com & exit /b 1)
where claude >nul 2>nul || (echo claude is missing: install it from https://docs.claude.com/claude-code & exit /b 1)
where gh >nul 2>nul || (echo gh is missing: install it from https://cli.github.com & exit /b 1)

rem 2. Dependencies and build.
pushd core || exit /b 1
call npm ci || exit /b 1
popd
pushd plugin || exit /b 1
call npm ci || exit /b 1
popd
pushd core || exit /b 1
call npm run build || exit /b 1
popd

rem 3. Launcher (git-ignored). It sets FACTORY_ROOT to its own folder.
> "%ROOT%\factory.cmd" (
  echo @echo off
  echo set "FACTORY_ROOT=%%~dp0"
  echo if "%%FACTORY_ROOT:~-1%%"=="\" set "FACTORY_ROOT=%%FACTORY_ROOT:~0,-1%%"
  echo node "%%FACTORY_ROOT%%\core\dist\cli.js" %%*
)

rem 4. The plugin, unless it is already installed.
claude plugin list 2>nul | findstr /c:"factory@the-software-factory" >nul
if errorlevel 1 goto install_plugin
echo plugin factory@the-software-factory is already installed
goto plugin_done
:install_plugin
rem "marketplace add" fails when the marketplace is already registered: add it only when it is missing.
claude plugin marketplace list 2>nul | findstr /c:"the-software-factory" >nul
if errorlevel 1 (
  call claude plugin marketplace add "%ROOT%" || exit /b 1
) else (
  echo marketplace the-software-factory is already registered
)
call claude plugin install factory@the-software-factory || exit /b 1
:plugin_done

rem 5. Next step: the wizard is run by the user.
echo Note: the factory steps themselves (git worktrees, the guard hook, shell checks) have not been tested on Windows yet.
echo.
echo Setup is done. Next, run: factory.cmd init
exit /b 0
