#!/usr/bin/env bash
# Exercises the HTTP surface against an already-running server (npm start).
# Models must already be cached, or the first calls will block on downloads.
set -uo pipefail
BASE="${BASE:-http://localhost:8787}"
pass=0; fail=0
ok   () { echo "  ✓ $1"; pass=$((pass+1)); }
bad  () { echo "  ✖ $1 -- $2"; fail=$((fail+1)); }

echo "▸ static"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
[ "$code" = 200 ] && ok "GET / ($code)" || bad "GET /" "$code"
for f in app.js styles.css; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$f")
  [ "$code" = 200 ] && ok "GET /$f" || bad "GET /$f" "$code"
done

echo "▸ capabilities"
caps=$(curl -s "$BASE/api/capabilities")
echo "$caps" | grep -q '"capabilities"' && ok "shape" || bad "shape" "$caps"
n=$(echo "$caps" | tr ',' '\n' | grep -c '"key"')
[ "$n" = 7 ] && ok "7 capabilities listed" || bad "capability count" "$n"

echo "▸ SSE /api/events"
ev=$(curl -s --max-time 3 -N "$BASE/api/events" | head -c 200)
echo "$ev" | grep -q '"type":"hello"' && ok "hello frame" || bad "hello frame" "$ev"

echo "▸ chat (streaming)"
out=$(curl -s -N -X POST "$BASE/api/chat" -H 'Content-Type: application/json' \
  -d '{"history":[{"role":"user","content":"Reply with exactly: PONG"}]}')
echo "$out" | grep -q '"type":"token"' && ok "tokens streamed" || bad "tokens" "$(echo "$out"|head -c 200)"
echo "$out" | grep -q '"type":"done"'  && ok "done frame"     || bad "done"   "$(echo "$out"|head -c 200)"
text=$(echo "$out" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' | tr -d '\n')
echo "    → ${text:0:100}"

echo "▸ tts"
tts=$(curl -s -X POST "$BASE/api/tts" -H 'Content-Type: application/json' -d '{"text":"Testing one two three."}')
echo "$tts" | grep -q 'data:audio/wav;base64' && ok "wav returned" || bad "tts" "$(echo "$tts"|head -c 200)"

echo "▸ rag ingest + search"
ing=$(curl -s -X POST "$BASE/api/rag/ingest" -H 'Content-Type: application/json' \
  -d '{"documents":["The mascot of the QVAC demo is a green otter named Pico."]}')
echo "$ing" | grep -q '"ok":true' && ok "ingest" || bad "ingest" "$ing"
sr=$(curl -s -X POST "$BASE/api/rag/search" -H 'Content-Type: application/json' -d '{"query":"who is the mascot?"}')
echo "$sr" | grep -qi 'pico' && ok "search finds Pico" || bad "search" "$(echo "$sr"|head -c 200)"

echo "▸ grounded chat"
g=$(curl -s -N -X POST "$BASE/api/chat" -H 'Content-Type: application/json' \
  -d '{"history":[{"role":"user","content":"What is the name of the mascot?"}],"useRag":true}')
echo "$g" | grep -q '"type":"sources"' && ok "sources frame" || bad "sources" "$(echo "$g"|head -c 200)"
gt=$(echo "$g" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' | tr -d '\n')
echo "    → ${gt:0:140}"
echo "$gt" | grep -qi 'pico' && ok "grounded answer names Pico" || bad "grounded answer" "$gt"

echo "▸ transcribe (round-trip through the TTS wav)"
if [ -f data/smoke/tts.wav ]; then
  b64=$(base64 < data/smoke/tts.wav | tr -d '\n')
  tr_out=$(curl -s -X POST "$BASE/api/transcribe" -H 'Content-Type: application/json' \
    -d "{\"audio\":\"data:audio/wav;base64,$b64\"}")
  echo "    → $(echo "$tr_out" | head -c 160)"
  # Assert on ordinary words. "QVAC" is an invented acronym and engines render
  # it differently (Parakeet hears "QViac"), which says nothing about the pipeline.
  if echo "$tr_out" | grep -qi 'running' && echo "$tr_out" | grep -qi 'device'; then
    ok "transcribed"
  else
    bad "transcribe" "$(echo "$tr_out"|head -c 200)"
  fi
else
  echo "  - skipped (run: node smoke.js tts)"
fi

echo
echo "─────── http summary: $pass passed, $fail failed ───────"
[ "$fail" = 0 ]
