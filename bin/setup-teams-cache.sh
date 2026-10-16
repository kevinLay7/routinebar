#!/bin/bash
set -euo pipefail
DATA="${ROUTINEBAR_HOME:-$HOME/.routinebar}"
python3 -m venv "$DATA/tools/teams-cache"
"$DATA/tools/teams-cache/bin/python" -m pip install 'ccl_chromium_reader @ git+https://github.com/cclgroupltd/ccl_chromium_reader.git@ef840de30221c4d65bc96d2f4d9057e9ef2f526d'
