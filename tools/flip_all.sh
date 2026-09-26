#!/bin/sh
# FLIP every <name>_orig.png / <name>_edit.png pair in a match output folder -> <name>.flip.json
cd "${1:-out}"
for o in *_orig.png; do n="${o%_orig.png}"; python3 ../tools/flip_eval.py "$o" "${n}_edit.png" "${n}_faces.json" > "${n}.flip.json"; echo "$n $(cat ${n}.flip.json)"; done
