#!/bin/bash
# OneCard Lab for macOS: double-click this file in Finder. Terminal opens and starts the lab, and
# the lab console opens in your web browser. Close the Terminal window, or press Ctrl+C, to stop.
# (docs/DESIGN.md §13; start-onecard-lab.sh and scripts/launch.cjs do the work.)
#
# The first time, macOS may say it cannot check this file: right-click it, choose Open, then Open.
cd "$(dirname "$0")" || exit 1
exec /bin/bash ./start-onecard-lab.sh "$@"
