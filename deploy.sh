#!/bin/bash
set -e
cd "$(dirname "$0")/client"
node scripts/bump-version.js
cd ..
flyctl deploy
