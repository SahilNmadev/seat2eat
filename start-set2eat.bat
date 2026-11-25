
@echo off
title Set2Eat Auto Start

cd /d "D:\major project collage"

start "Set2Eat Server" /min cmd /c "npm start"

timeout /t 8 /nobreak >nul

start "" "http://localhost:3000/login.html"

exit
