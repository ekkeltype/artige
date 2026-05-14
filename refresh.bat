@echo off
cd /d "%~dp0"

echo. >> refresh.log
echo === %date% %time% === >> refresh.log

git pull --ff-only >> refresh.log 2>&1
if errorlevel 1 (
    echo Pull failed; aborting >> refresh.log
    exit /b 1
)

node scripts\fetch.js >> refresh.log 2>&1
if errorlevel 1 (
    echo Fetch failed; aborting >> refresh.log
    exit /b 1
)

git add data/jokes.json
git diff --staged --quiet
if errorlevel 1 (
    git commit -m "chore: daily joke refresh" >> refresh.log 2>&1
    git push >> refresh.log 2>&1
) else (
    echo No changes >> refresh.log
)

exit /b 0
