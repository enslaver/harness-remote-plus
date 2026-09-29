#!/bin/sh
# Creates .env with freshly generated secrets, then tells you what to run next.
#
#   sh deploy/init-env.sh                          # plain HTTP on this computer (http://localhost:8080)
#   sh deploy/init-env.sh --domain hub.example.com # also turn on HTTPS with Caddy for that DNS name
#
# With --domain it sets HUB_DOMAIN, HUB_PUBLIC_URL, HUB_TRUST_PROXY=1 and COMPOSE_PROFILES=tls together, because
# they only make sense together. The name must already point at this computer, with ports 80 and 443 reachable.
#
# It never overwrites an existing .env: secrets you are already using must not change under you.
set -eu

cd "$(dirname "$0")/.."

domain=""
want_domain=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      [ "$#" -ge 2 ] || { echo "--domain needs a DNS name, e.g. --domain hub.example.com" >&2; exit 2; }
      domain=$2
      want_domain=1
      shift 2
      ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 2
      ;;
  esac
done
if [ "$want_domain" = 1 ]; then
  case "$domain" in
    *[!A-Za-z0-9.-]*|.*|*.|-*|"") echo "--domain must be a DNS name such as hub.example.com, without scheme or path." >&2; exit 2 ;;
  esac
fi

if [ -e .env ]; then
  echo ".env already exists; leaving it alone. Delete it first if you really want new secrets." >&2
  exit 1
fi
if [ ! -r .env.example ]; then
  echo "Run this from a checkout of the repository (.env.example not found)." >&2
  exit 1
fi

# N random letters/digits. `LC_ALL=C` because some tr implementations refuse raw bytes otherwise.
random() {
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"
}

postgres_password=$(random 32)
admin_password=$(random 20)
secret_key=$(random 48)
enrollment_token="hre_$(random 40)"

# Owner-only from the first byte, not chmod'd afterwards.
umask 077
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${postgres_password}|" \
  -e "s|^HUB_ADMIN_PASSWORD=.*|HUB_ADMIN_PASSWORD=${admin_password}|" \
  -e "s|^HUB_SECRET_KEY=.*|HUB_SECRET_KEY=${secret_key}|" \
  -e "s|^HUB_ENROLLMENT_TOKEN=.*|HUB_ENROLLMENT_TOKEN=${enrollment_token}|" \
  .env.example > .env

if [ -n "$domain" ]; then
  cat >> .env <<TLS

# ---- HTTPS (written by init-env.sh --domain) -------------------------------------------------------------------
HUB_DOMAIN=${domain}
COMPOSE_PROFILES=tls
TLS
  # Same keys already exist above as empty/default values; rewrite them in place instead of duplicating.
  sed -i.bak \
    -e "s|^HUB_PUBLIC_URL=.*|HUB_PUBLIC_URL=https://${domain}|" \
    -e "s|^HUB_TRUST_PROXY=.*|HUB_TRUST_PROXY=1|" \
    .env
  rm -f .env.bak
  address="https://${domain}"
else
  address="http://localhost:8080"
fi

cat <<MESSAGE
Created .env (owner-readable only) with generated secrets.

  Console password:  ${admin_password}
  Enrollment token:  ${enrollment_token}

Next:
  docker compose up -d --build
  open ${address}          # sign in with the console password

Add a machine (on that computer, with Node.js 20+ and an agent CLI installed):
  HARNESS_REMOTE_HUB_TOKEN=${enrollment_token} npx --yes github:enslaver/harness-remote-plus --hub ${address}
MESSAGE
if [ -z "$domain" ]; then
  cat <<MESSAGE

To use it from an iPhone you need HTTPS: rerun with --domain <name> (after deleting .env), or see docs/HUB.md.
MESSAGE
fi
