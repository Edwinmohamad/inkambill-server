#!/usr/bin/env bash
set -Eeuo pipefail

api_level="${1:?API level wajib diisi}"
artifact_dir="${2:?Direktori artifact wajib diisi}"
apk_file="${artifact_dir}/INKAMNET-GO-v1.3.0.apk"
package_file="${artifact_dir}/package-name.txt"
launch_log="emulator-launch-${api_level}.txt"
screen_file="emulator-smoke-${api_level}.png"
logcat_file="emulator-logcat-${api_level}.txt"

test -s "${apk_file}"
test -s "${package_file}"
package_name="$(tr -d '\r\n' < "${package_file}")"
test -n "${package_name}"

adb wait-for-device
for _ in $(seq 1 90); do
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    break
  fi
  sleep 2
done
test "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1"

adb logcat -c
adb install -r -g "${apk_file}"
adb shell am force-stop "${package_name}"
adb shell am start -W -n "${package_name}/id.my.edwinpxmx.inkamnetgo.MainActivity" | tee "${launch_log}"

# Android dapat melaporkan Status: ok atau Status: warning ketika Activity sudah
# aktif. Keberhasilan ditentukan dari Activity yang benar-benar tampil/proses hidup.
sleep 5
adb logcat -d > "${logcat_file}"

# `adb exec-out screencap` kadang mengembalikan exit 224 pada image Android 35.
# Ambil melalui penyimpanan emulator dan jangan menggagalkan tes fungsional hanya
# karena bukti gambar tidak tersedia.
if adb shell screencap -p "/sdcard/inkamnet-go-${api_level}.png" \
  && adb pull "/sdcard/inkamnet-go-${api_level}.png" "${screen_file}" >/dev/null; then
  adb shell rm -f "/sdcard/inkamnet-go-${api_level}.png" || true
else
  echo "Screenshot emulator tidak tersedia; validasi proses dan Activity tetap dilanjutkan." >&2
  rm -f "${screen_file}"
fi

if ! adb shell pidof "${package_name}" >/dev/null 2>&1; then
  echo "INKAMNET GO berhenti setelah diluncurkan (Android ${api_level})." >&2
  grep -E "FATAL EXCEPTION|AndroidRuntime|${package_name}" "${logcat_file}" | tail -n 120 >&2 || true
  exit 1
fi

activity_state="$(adb shell dumpsys activity activities)"
if ! grep -F "${package_name}/id.my.edwinpxmx.inkamnetgo.MainActivity" <<< "${activity_state}" >/dev/null; then
  echo "MainActivity INKAMNET GO tidak aktif (Android ${api_level})." >&2
  exit 1
fi

echo "Emulator smoke test Android ${api_level} berhasil untuk ${package_name}."
