@echo off
cd /d "%~dp0"

echo. >> refresh.log
echo === %date% %time% === >> refresh.log

REM Defer to an in-progress manual translation run (ops\translate-backlog.md),
REM which holds data\.manual-lock, so we don't race it on jokes.json / git. The
REM lock auto-expires after 8h so a crashed manual run can't block forever.
node\node.exe scripts\manual-translate.js locked >> refresh.log 2>&1
if not errorlevel 1 (
    echo Manual translation in progress; skipping this refresh >> refresh.log
    exit /b 0
)

git pull --ff-only >> refresh.log 2>&1
if errorlevel 1 (
    echo Pull failed; aborting >> refresh.log
    exit /b 1
)

node\node.exe scripts\fetch.js >> refresh.log 2>&1
if errorlevel 1 (
    echo Fetch failed; aborting >> refresh.log
    exit /b 1
)

REM Translation is no longer run here. It is done manually in a Claude Code
REM session via ops\translate-backlog.md ("do the thing"): claude -p + haiku was
REM unreliable and low quality. This task only downloads new jokes; the manual
REM procedure adds the Norwegian translations and commits them separately.

git add data/jokes.json
git diff --staged --quiet
if errorlevel 1 (
    git commit -m "chore: daily joke refresh" >> refresh.log 2>&1
    git push >> refresh.log 2>&1
) else (
    echo No changes >> refresh.log
)

exit /b 0
