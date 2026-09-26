#!/bin/sh
# Copies the engine into the web root (the site is plain static files, no bundler).
set -e
cd "$(dirname "$0")/.."
rm -rf web/engine && mkdir -p web/engine
cp engine/*.js web/engine/
echo "engine copied to web/engine"
