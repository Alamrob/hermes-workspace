#!/bin/sh
set -eu
test "$#" -eq 0
mkdir -p /tmp/runtime-identity/ipc /tmp/runtime-identity/cwd /tmp/runtime-identity/temporary
printf 'fixture-only\n' > /tmp/runtime-identity/secret
printf 'immutable\n' > /tmp/runtime-identity/seed
chown 0:10000 /tmp/runtime-identity/secret
chmod 0440 /tmp/runtime-identity/secret
chmod 0444 /tmp/runtime-identity/seed
chown 10000:10000 /tmp/runtime-identity/seed
chmod 2770 /tmp/runtime-identity/ipc
chown 10000:11000 /tmp/runtime-identity/ipc
chmod 0710 /tmp/runtime-identity/cwd
chown 10002:10000 /tmp/runtime-identity/cwd
chmod 0711 /tmp/runtime-identity/temporary
chown 10000:10000 /tmp/runtime-identity/temporary
exec /usr/bin/setpriv \
  --reuid=10000 \
  --regid=10000 \
  --clear-groups \
  --inh-caps=+chown,+setgid,+setuid,+setpcap \
  --ambient-caps=+chown,+setgid,+setuid,+setpcap \
  --bounding-set=-all,+chown,+setgid,+setuid,+setpcap \
  --no-new-privs \
  -- /usr/local/bin/node /workspace/scripts/test-linux-runtime-identity.mjs
