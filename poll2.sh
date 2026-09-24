#!/bin/bash
URL="https://sac.casaldotrafego.com/api/admin/diag-sotaque-temp?key=WHwgMI5mANY6ae9F7XwoG5DnxPTIBi-e4tLf4VmcbgA&phone=ig_5811884488874755"
for i in $(seq 1 40); do
  body=$(curl -s "$URL")
  code=$(curl -s -o /dev/null -w "%{http_code}" "$URL")
  if echo "$body" | grep -q '"messageCount"' || echo "$body" | grep -q 'lead não encontrado'; then
    echo "PRONTO: $code"
    echo "$body"
    exit 0
  fi
  echo "tentativa $i: HTTP $code (ainda deploy antigo)"
  sleep 6
done
echo "TIMEOUT"
