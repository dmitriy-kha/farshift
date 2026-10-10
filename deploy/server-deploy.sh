#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
umask 077
[[ $EUID == 0 ]] || { echo 'Root required' >&2; exit 1; }

if [[ $# == 2 && $1 == --install ]]; then
  public_key=$2
  [[ $public_key =~ ^ssh-ed25519\ [a-zA-Z0-9+/]+={0,2}(\ [a-zA-Z0-9._@-]+)?$ ]]
  getent passwd farshift-deploy >/dev/null
  install -d -o root -g root -m 755 /opt/farshift /opt/farshift/.ssh
  install -d -o root -g root -m 700 /opt/farshift/releases \
    /opt/farshift/data /opt/farshift/data/{acme,certificates}
  install -d -o root -g root -m 755 /opt/farshift/data/challenges
  if [[ $(readlink -f "$0") != /opt/farshift/server-deploy.sh ]]; then
    install -o root -g root -m 755 "$0" /opt/farshift/server-deploy.sh
  fi
  chown root:root /opt/farshift/server-deploy.sh
  chmod 755 /opt/farshift/server-deploy.sh
  printf '%s%s\n' 'restrict,command="/usr/bin/sudo -n /opt/farshift/server-deploy.sh" ' \
    "$public_key" > /opt/farshift/.ssh/authorized_keys
  chmod 644 /opt/farshift/.ssh/authorized_keys
  printf '%s\n' 'farshift-deploy ALL=(root) NOPASSWD: /opt/farshift/server-deploy.sh ""' \
    > /opt/farshift/deploy.sudoers
  chmod 440 /opt/farshift/deploy.sudoers
  /usr/sbin/visudo -cf /opt/farshift/deploy.sudoers
  /usr/sbin/usermod --home /opt/farshift farshift-deploy
  ln -sfn /opt/farshift/deploy.sudoers /etc/sudoers.d/farshift-deploy
  echo 'Deployment access installed; application files will arrive with the release image'
  exit 0
fi
[[ $# == 0 ]] || { echo 'No deployment arguments allowed' >&2; exit 1; }

cd /opt/farshift
exec 9>/opt/farshift/deploy.lock
flock -w 60 9
work=$(mktemp -d /opt/farshift/.deploy.XXXXXXXX)
container=''
next=''
keep_next=0
docker_command() {
  env -i PATH="$PATH" HOME=/root DOCKER_CONFIG="$work/docker" \
    /usr/bin/timeout --kill-after=30s 900 /usr/bin/docker "$@"
}
cleanup() {
  if [[ -n $container ]]; then docker_command rm "$container" >/dev/null || true; fi
  if [[ -n $next && $keep_next == 0 ]]; then rm -rf -- "$next"; fi
  rm -rf -- "$work"
}
trap cleanup EXIT

fields=(FARSHIFT_IMAGE FARSHIFT_NGINX_IMAGE FARSHIFT_ACME_IMAGE FARSHIFT_DOMAIN \
  FARSHIFT_ACME_EMAIL FARSHIFT_STUN_URLS FARSHIFT_TURN_URLS FARSHIFT_TURN_SECRET \
  FARSHIFT_RELAY_ONLY FARSHIFT_MAX_ROOMS FARSHIFT_MAX_CONNECTIONS FARSHIFT_REVISION \
  REGISTRY_USER REGISTRY_TOKEN)
for name in "${fields[@]}"; do
  IFS= read -r -t 15 -n 8193 encoded || { echo 'Incomplete deployment request' >&2; exit 1; }
  [[ ${#encoded} -le 8192 && $encoded =~ ^[a-zA-Z0-9+/=-]+$ ]]
  value=''
  if [[ $encoded != '-' ]]; then
    value=$(printf '%s' "$encoded" | base64 --decode)
    [[ $(printf '%s' "$value" | base64 -w 0) == "$encoded" ]]
  fi
  [[ $value != *$'\n'* && $value != *$'\r'* && $value != *"'"* ]]
  printf -v "$name" '%s' "$value"
done
if IFS= read -r -t 15 -n 1 extra; then
  echo 'Extra deployment data' >&2
  exit 1
else
  status=$?
  [[ $status == 1 && -z $extra ]] || { echo 'Deployment input did not close' >&2; exit 1; }
fi
[[ $FARSHIFT_IMAGE =~ ^ghcr.io/dmitriy-kha/farshift@sha256:[a-f0-9]{64}$ ]]
[[ $FARSHIFT_NGINX_IMAGE =~ ^ghcr.io/dmitriy-kha/farshift-nginx@sha256:[a-f0-9]{64}$ ]]
[[ $FARSHIFT_ACME_IMAGE =~ ^ghcr.io/dmitriy-kha/farshift-acme@sha256:[a-f0-9]{64}$ ]]
[[ $FARSHIFT_DOMAIN == farshift.space ]]
[[ $FARSHIFT_ACME_EMAIL =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]
[[ $FARSHIFT_RELAY_ONLY =~ ^[01]$ && $FARSHIFT_REVISION =~ ^[a-f0-9]{40}$ ]]
for name in FARSHIFT_MAX_ROOMS FARSHIFT_MAX_CONNECTIONS; do
  [[ ${!name} =~ ^[1-9][0-9]{0,4}$ && ${!name} -le 32768 ]]
done
[[ $REGISTRY_USER =~ ^[a-zA-Z0-9-]+$ && -n $REGISTRY_TOKEN ]]
mkdir "$work/docker"
printf '%s' "$REGISTRY_TOKEN" | docker_command login ghcr.io --username "$REGISTRY_USER" --password-stdin
unset REGISTRY_TOKEN
docker_command pull "$FARSHIFT_IMAGE"
[[ $(docker_command image inspect "$FARSHIFT_IMAGE" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$FARSHIFT_REVISION" ]]

# Copy only the release's fixed deployment files from a container that is never started.
next=$(mktemp -d "/opt/farshift/releases/$FARSHIFT_REVISION.XXXXXXXX")
container=$(docker_command create --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true "$FARSHIFT_IMAGE")
for file in compose.yaml nginx.conf nginx-http.conf server-deploy.sh; do
  docker_command cp "$container:/app/deploy/$file" "$next/$file"
  [[ -f $next/$file && ! -L $next/$file && $(stat -c %s "$next/$file") -le 65536 ]]
  chown root:root "$next/$file"
  chmod 600 "$next/$file"
done
docker_command rm "$container" >/dev/null
container=''
bash -n "$next/server-deploy.sh"
for name in "${fields[@]:0:12}"; do
  printf "%s='%s'\n" "$name" "${!name}" >> "$next/.env"
done
compose() {
  docker_command compose --project-name farshift --project-directory "$1" \
    --env-file "$1/.env" -f "$1/compose.yaml" "${@:2}"
}
compose "$next" config --quiet
compose "$next" pull
previous=$(readlink -e current || true)
older=$(readlink -e previous || true)
for release in "$previous" "$older"; do
  [[ -z $release || ( $release == /opt/farshift/releases/* && -d $release ) ]]
done
verify() {
  [[ $(curl --fail --silent --show-error --max-time 20 \
    --resolve farshift.space:443:127.0.0.1 https://farshift.space/health) == ok ]]
}
keep_next=1
if compose "$next" up -d --no-build --wait --wait-timeout 600 && verify; then
  if [[ -n $previous ]]; then
    ln -s "$previous" "$work/previous"
    mv -Tf "$work/previous" /opt/farshift/previous
  fi
  ln -s "$next" "$work/current"
  mv -Tf "$work/current" /opt/farshift/current
  install -o root -g root -m 755 "$next/server-deploy.sh" "$work/server-deploy.sh"
  mv -Tf "$work/server-deploy.sh" /opt/farshift/server-deploy.sh
  if [[ -n $older && $older != "$previous" && $older != "$next" ]]; then rm -rf -- "$older"; fi
  printf 'Deployment healthy: %s\n' "$FARSHIFT_REVISION"
else
  echo 'Deployment failed' >&2
  if [[ -n $previous ]]; then
    echo 'Restoring previous images and configuration' >&2
    if compose "$previous" up -d --no-build --wait --wait-timeout 180 && verify; then
      keep_next=0
    else
      echo 'Rollback failed; administrator intervention required' >&2
    fi
  else
    echo 'First deployment has no previous version to restore' >&2
  fi
  exit 1
fi
