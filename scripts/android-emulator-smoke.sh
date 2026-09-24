#!/usr/bin/env bash
set -Eeuo pipefail

api_level="${1:?API level wajib diisi}"
artifact_dir="${2:?Direktori artifact wajib diisi}"
apk_file="${artifact_dir}/INKAMNET-GO-v1.3.1.apk"
package_file="${artifact_dir}/package-name.txt"
launch_log="emulator-launch-${api_level}.txt"
screen_file="emulator-smoke-${api_level}.png"
logcat_file="emulator-logcat-${api_level}.txt"

# Bukti selalu ada walau tes gagal di tengah jalan, supaya langkah upload tidak ikut error.
: > "${launch_log}"
trap 'adb logcat -d > "${logcat_file}" 2>/dev/null || true' EXIT

test -s "${apk_file}"
test -s "${package_file}"
package_name="$(tr -d '\r\n' < "${package_file}")"
test -n "${package_name}"

# Perintah adb pada emulator Android 35 kadang gagal sesaat (exit 224 / device offline).
retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then return 0; fi
    echo "Percobaan ${attempt} gagal: $*" >&2
    sleep 5
    adb wait-for-device || true
  done
  return 1
}

adb wait-for-device
for _ in $(seq 1 150); do
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    break
  fi
  sleep 2
done
test "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1"
sleep 10

for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb shell settings put global "${setting}" 0 >/dev/null 2>&1 || true
done
adb shell input keyevent 82 >/dev/null 2>&1 || true

adb logcat -c || true
retry adb install -r -g "${apk_file}"
adb shell am force-stop "${package_name}" || true
retry adb shell am start -W -n "${package_name}/id.my.edwinpxmx.inkamnetgo.MainActivity" | tee "${launch_log}"

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
