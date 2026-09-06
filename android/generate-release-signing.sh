#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
KEYSTORE_FILE="${SCRIPT_DIR}/inkamnet-go-release.jks"
SECRETS_FILE="${SCRIPT_DIR}/inkamnet-go-github-secrets.txt"

if [ -e "$KEYSTORE_FILE" ] || [ -e "$SECRETS_FILE" ]; then
  echo "Signing kit sudah ada. Pindahkan/backup file lama sebelum membuat yang baru." >&2
  exit 1
fi

STORE_PASSWORD="$(openssl rand -base64 32 | tr -d '\n=/+' | cut -c1-28)"
KEY_PASSWORD="$STORE_PASSWORD"
KEY_ALIAS="inkamnet-go"

keytool -genkeypair -v \
  -keystore "$KEYSTORE_FILE" \
  -storepass "$STORE_PASSWORD" \
  -keypass "$KEY_PASSWORD" \
  -alias "$KEY_ALIAS" \
  -storetype PKCS12 -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=INKAMNET GO, OU=Technology, O=PT INKAMNET NEXERA TECHNOLOGY, L=Bogor, ST=Jawa Barat, C=ID"

FINGERPRINT="$(keytool -list -v -keystore "$KEYSTORE_FILE" -storepass "$STORE_PASSWORD" -alias "$KEY_ALIAS" | awk -F': ' '/SHA256:/{print $2; exit}')"
KEYSTORE_BASE64="$(base64 -w 0 "$KEYSTORE_FILE")"

umask 077
{
  echo "Simpan file ini secara privat. Jangan commit ke Git."
  echo
  echo "GitHub Repository Secrets:"
  echo "ANDROID_KEYSTORE_BASE64=$KEYSTORE_BASE64"
  echo "ANDROID_KEYSTORE_PASSWORD=$STORE_PASSWORD"
  echo "ANDROID_KEY_ALIAS=$KEY_ALIAS"
  echo "ANDROID_KEY_PASSWORD=$KEY_PASSWORD"
  echo
  echo "Server .env:"
  echo "MOBILE_ANDROID_CERT_SHA256=$FINGERPRINT"
} > "$SECRETS_FILE"

chmod 600 "$KEYSTORE_FILE" "$SECRETS_FILE"
echo "Signing kit berhasil dibuat:"
echo "  $KEYSTORE_FILE"
echo "  $SECRETS_FILE"
echo "Backup keduanya ke penyimpanan privat. Kehilangan key berarti APK lama tidak dapat di-update."
