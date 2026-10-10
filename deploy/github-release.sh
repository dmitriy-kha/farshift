#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${VERSION:-} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release tag' >&2; exit 1; }
[[ ${GH_REPO:-} == dmitriy-kha/farshift ]] || { echo 'Unexpected repository' >&2; exit 1; }
: "${GH_TOKEN:?GitHub token is required}"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
registry=ghcr.io/dmitriy-kha
scanner=aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969

read_manifest() {
  local line name value
  declare -A seen=()
  while IFS= read -r line; do
    name=${line%%=*}
    value=${line#*=}
    case "$name" in
      FARSHIFT_IMAGE) [[ $value =~ ^ghcr.io/dmitriy-kha/farshift@sha256:[a-f0-9]{64}$ ]] ;;
      FARSHIFT_NGINX_IMAGE) [[ $value =~ ^ghcr.io/dmitriy-kha/farshift-nginx@sha256:[a-f0-9]{64}$ ]] ;;
      FARSHIFT_ACME_IMAGE) [[ $value =~ ^ghcr.io/dmitriy-kha/farshift-acme@sha256:[a-f0-9]{64}$ ]] ;;
      FARSHIFT_REVISION) [[ $value =~ ^[a-f0-9]{40}$ ]] ;;
      *) echo 'Unexpected release field' >&2; exit 1 ;;
    esac || { echo 'Invalid release field' >&2; exit 1; }
    [[ -z ${seen[$name]:-} ]] || { echo 'Duplicate release field' >&2; exit 1; }
    seen[$name]=1
    printf -v "$name" '%s' "$value"
  done < "$work/images.env"
  [[ ${#seen[@]} == 4 ]] || { echo 'Incomplete release manifest' >&2; exit 1; }
}

case "${1:-}" in
  publish)
    revision=$(git -C source rev-parse HEAD)
    git -C source merge-base --is-ancestor "$revision" origin/main
    [[ ${REBUILD:-false} =~ ^(true|false)$ ]]
    gh api --paginate "repos/$GH_REPO/releases" --jq '.[].tag_name' > "$work/tags"
    existing=0
    if grep -Fxq "$VERSION" "$work/tags"; then
      existing=1
    fi
    if [[ $existing == 1 && ${REBUILD:-false} != true ]]; then
      gh release download "$VERSION" --repo "$GH_REPO" --pattern images.env --dir "$work"
      read_manifest
      [[ $FARSHIFT_REVISION == "$revision" ]] || { echo 'Release tag moved' >&2; exit 1; }
    else
      mkdir "$work/cache"
      docker run --rm --user "$(id -u):$(id -g)" --cap-drop ALL \
        --security-opt no-new-privileges:true --read-only --tmpfs /tmp \
        -v "$work/cache:/cache" "$scanner" image --cache-dir /cache --download-db-only
      docker run --rm --network none --user "$(id -u):$(id -g)" --cap-drop ALL \
        --security-opt no-new-privileges:true --read-only --tmpfs /tmp \
        -v "$work/cache:/cache" -v "$PWD/source:/source:ro" "$scanner" fs \
        --cache-dir /cache --skip-db-update --offline-scan --scanners vuln \
        --severity HIGH,CRITICAL --exit-code 1 /source
      printf 'FARSHIFT_REVISION=%s\n' "$revision" > "$work/images.env"
      for target in runtime nginx acme; do
        case "$target" in
          runtime) name=farshift ;;
          nginx) name=farshift-nginx ;;
          acme) name=farshift-acme ;;
        esac
        image="$registry/$name:$VERSION"
        docker buildx build --platform linux/amd64 --load --target "$target" \
          --tag "$image" --label "org.opencontainers.image.source=https://github.com/$GH_REPO" \
          --label "org.opencontainers.image.revision=$revision" \
          --label "org.opencontainers.image.version=$VERSION" source
        docker save --output "$work/image.tar" "$image"
        docker run --rm --network none --user "$(id -u):$(id -g)" --cap-drop ALL \
          --security-opt no-new-privileges:true --read-only --tmpfs /tmp \
          -v "$work/cache:/cache" -v "$work/image.tar:/image.tar:ro" "$scanner" image \
          --cache-dir /cache --skip-db-update --offline-scan --scanners vuln \
          --severity HIGH,CRITICAL --exit-code 1 --input /image.tar
        rm "$work/image.tar"
      done
      printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
      for name in farshift farshift-nginx farshift-acme; do
        image="$registry/$name:$VERSION"
        docker push "$image"
        digest=$(docker image inspect "$image" --format '{{index .RepoDigests 0}}')
        case "$name" in
          farshift) field=FARSHIFT_IMAGE ;;
          farshift-nginx) field=FARSHIFT_NGINX_IMAGE ;;
          farshift-acme) field=FARSHIFT_ACME_IMAGE ;;
        esac
        printf '%s=%s\n' "$field" "$digest" >> "$work/images.env"
      done
      docker logout ghcr.io
      read_manifest
      cat > "$work/notes.md" <<EOF
Two devices. One ephemeral folder.

Encrypted WebRTC file and folder sharing, SPAKE2 pairing, and Rust signaling.
No accounts. No server-side file storage.

Source: $revision. Linux amd64 images are published to GHCR.
HIGH and CRITICAL dependency and image vulnerability checks passed at publication time.
The attached images.env pins all three container images by digest.
HTTP-01 challenge permissions allow certificate validation by the Nginx worker.
WebRTC uses authenticated trickle ICE and a bounded channel opening timeout.
EOF
      if [[ $existing == 1 ]]; then
        gh release upload "$VERSION" "$work/images.env" --repo "$GH_REPO" --clobber
        gh release edit "$VERSION" --repo "$GH_REPO" --notes-file "$work/notes.md"
      else
        gh release create "$VERSION" "$work/images.env" --repo "$GH_REPO" \
          --verify-tag --title "Farshift $VERSION" --notes-file "$work/notes.md"
      fi
    fi
    printf 'version=%s\n' "$VERSION" >> "$GITHUB_OUTPUT"
    ;;
  deploy)
    for name in DEPLOY_SSH_KEY DEPLOY_HOST DEPLOY_PORT DEPLOY_USER DEPLOY_KNOWN_HOSTS \
      FARSHIFT_DOMAIN FARSHIFT_ACME_EMAIL FARSHIFT_STUN_URLS FARSHIFT_RELAY_ONLY \
      FARSHIFT_MAX_ROOMS FARSHIFT_MAX_CONNECTIONS; do
      [[ -n ${!name:-} ]] || { printf 'Missing deployment setting: %s\n' "$name" >&2; exit 1; }
    done
    [[ $DEPLOY_HOST =~ ^[a-zA-Z0-9.-]+$ && $DEPLOY_HOST != -* ]]
    [[ $DEPLOY_PORT =~ ^[0-9]+$ && $DEPLOY_USER == farshift-deploy ]]
    gh release download "$VERSION" --repo "$GH_REPO" --pattern images.env --dir "$work"
    read_manifest
    printf '%s\n' "$DEPLOY_SSH_KEY" > "$work/key"
    printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$work/known_hosts"
    chmod 600 "$work/key" "$work/known_hosts"
    values=("$FARSHIFT_IMAGE" "$FARSHIFT_NGINX_IMAGE" "$FARSHIFT_ACME_IMAGE" \
      "$FARSHIFT_DOMAIN" "$FARSHIFT_ACME_EMAIL" "$FARSHIFT_STUN_URLS" \
      "${FARSHIFT_TURN_URLS:-}" "${FARSHIFT_TURN_SECRET:-}" "$FARSHIFT_RELAY_ONLY" \
      "$FARSHIFT_MAX_ROOMS" "$FARSHIFT_MAX_CONNECTIONS" \
      "$FARSHIFT_REVISION" "$GITHUB_ACTOR" "$GH_TOKEN")
    for value in "${values[@]}"; do
      if [[ -z $value ]]; then printf '%s\n' '-'; else printf '%s' "$value" | base64 -w 0; printf '\n'; fi
    done | ssh -T -i "$work/key" -p "$DEPLOY_PORT" \
      -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
      -o "UserKnownHostsFile=$work/known_hosts" -o ConnectTimeout=15 \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
      "$DEPLOY_USER@$DEPLOY_HOST"
    [[ $FARSHIFT_DOMAIN =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ ]]
    [[ $(curl --fail --silent --show-error --max-time 20 "https://$FARSHIFT_DOMAIN/health") == ok ]]
    printf 'Deployed %s (%s)\n' "$VERSION" "$FARSHIFT_REVISION" >> "$GITHUB_STEP_SUMMARY"
    ;;
  *) echo 'Expected publish or deploy' >&2; exit 1 ;;
esac
