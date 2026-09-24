#!/bin/bash
URL="https://sac.casaldotrafego.com/api/admin/diag-sotaque-temp?key=WHwgMI5mANY6ae9F7XwoG5DnxPTIBi-e4tLf4VmcbgA&phone=ig_5811884488874755"
for i in $(seq 1 40); do
  code=$(curl -s -o /tmp/wt-diag-sotaque/result.json -w "%{http_code}" "$URL")
  echo "tentativa $i: HTTP $code"
  if [ "$code" = "200" ] || [ "$code" = "404" ]; then
    echo "PRONTO: $code"
    cat /tmp/wt-diag-sotaque/result.json
    exit 0
  fi
  sleep 5
done
echo "TIMEOUT"
