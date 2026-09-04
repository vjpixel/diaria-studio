#!/usr/bin/env bash
# Run Diar.i.br pipeline for 260904 (D+1)

set -e
cd /home/vjpixel/diaria-studio
export CLI_CODE="python3"

echo "Starting pipeline for 260904..."
npx tsx --eval "\
import('./scripts/overnight/run-sao-paulo.js').then(async ({orchestrat}) => {
  const res = await orchestrat('260904', true, false)
  console.log(JSON.stringify(res, null, 2))
});\n" --export=run-260904 --timeout=300
