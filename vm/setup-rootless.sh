#!/usr/bin/env bash
# Gives every runner beyond the first its own Docker daemon.
# Idempotent: re-run to add more.
#
#   sudo bash setup-rootless.sh --count 4
#
# awf names its containers awf-agent, awf-squid and awf-api-proxy, with only the compose project
# label varying per run. On a shared daemon a second agent job recreates the first job's
# containers and kills it, and the first job dies with exit 137 partway through its work. The
# names cannot be configured, so the only way to run agent jobs concurrently is to give each
# runner a daemon of its own. awf picks it up from DOCKER_HOST with no workflow changes.
#
# Runner 1 keeps the shared rootful daemon: a single-runner host then needs none of this.

set -euo pipefail

COUNT=4
ROOT="${ROOT:-/opt/actions-runner}"

while [ $# -gt 0 ]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

echo "== shared /tmp for the runner users =="
# gh-aw hardcodes shared /tmp paths, /tmp/gh-aw above all, inside its own bundled action
# scripts, so no rewrite of the compiled lock can reach them. With a runner per user the
# second user to run gets EACCES. An ACL on /tmp/gh-aw itself does not survive, because jobs
# delete and recreate that directory and the new one carries the creating user's ownership.
# A default ACL on /tmp is inherited by whatever is created inside it, whoever creates it.
apt-get install -y -qq acl >/dev/null 2>&1 || true
getent group ghaw >/dev/null || groupadd ghaw
setfacl -d -m g:ghaw:rwx /tmp
setfacl -m  g:ghaw:rwx /tmp
echo "  /tmp carries a default ACL for group ghaw"

echo "== prerequisites =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq uidmap slirp4netns fuse-overlayfs dbus-user-session >/dev/null
for b in newuidmap newgidmap slirp4netns fuse-overlayfs; do
  command -v "$b" >/dev/null || { echo "  missing: $b" >&2; exit 1; }
done
echo "  ok"

for i in $(seq 2 "$COUNT"); do
  u="runner$i"
  DIR="$ROOT/$i"
  [ -d "$DIR" ] || { echo "== instance $i absent, skipping =="; continue; }

  echo "== $u =="
  if ! id -u "$u" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$u"
    usermod -aG ghaw "$u"
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$u" > "/etc/sudoers.d/$u"
    chmod 0440 "/etc/sudoers.d/$u"
    echo "  created"
  fi
  uid=$(id -u "$u")

  # Without lingering the user's systemd instance stops when no session is open, taking the
  # rootless daemon with it, and the runner then fails on its next job rather than at setup.
  loginctl enable-linger "$u" >/dev/null 2>&1 || true

  as_user() {
    sudo -u "$u" \
      XDG_RUNTIME_DIR="/run/user/$uid" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
      DOCKER_HOST="unix:///run/user/$uid/docker.sock" "$@"
  }

  # awf runs in network-isolation mode and does not touch host iptables, so the rootless
  # daemon does not need them either.
  as_user dockerd-rootless-setuptool.sh install --skip-iptables >/dev/null 2>&1 || true
  as_user systemctl --user enable --now docker >/dev/null 2>&1 || true
  sleep 4

  version=$(as_user docker version --format '{{.Server.Version}}' 2>/dev/null || echo "")
  [ -n "$version" ] || { echo "  daemon did not start" >&2; continue; }
  echo "  daemon $version on /run/user/$uid/docker.sock"

  # The instance moves to its own user so it inherits that user's daemon.
  ( cd "$DIR" && ./svc.sh uninstall >/dev/null 2>&1 || true )
  chown -R "$u:$u" "$DIR"

  cat > "$DIR/.env" <<ENV
LANG=C.UTF-8
MCP_GATEWAY_PORT=808$i
OPENCODE_PORT=409$i
DOCKER_HOST=unix:///run/user/$uid/docker.sock
XDG_RUNTIME_DIR=/run/user/$uid
ENV
  chown "$u:$u" "$DIR/.env"

  ( cd "$DIR" && ./svc.sh install "$u" >/dev/null && ./svc.sh start >/dev/null )
  echo "  runner $i now runs as $u"
done

echo
echo "== services =="
systemctl list-units --type=service --plain --no-legend | awk '/actions.runner/{print "  "$1" "$4}'
echo
echo "== proof the daemons are separate =="
echo "  Create the same container name in two daemons at once. On one daemon the second"
echo "  create fails, which is the collision. Across two daemons both succeed:"
echo "    docker run -d --name awf-agent --rm alpine sleep 30"
echo "    sudo -u runner2 XDG_RUNTIME_DIR=/run/user/1002 \\"
echo "      DOCKER_HOST=unix:///run/user/1002/docker.sock \\"
echo "      docker run -d --name awf-agent --rm alpine sleep 30"
