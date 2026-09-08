# Network Map & ONT Monitoring

## Konfigurasi

Tambahkan ke `.env` server:

```env
GENIEACS_NBI_URL=http://192.168.100.66:7557
GENIEACS_NBI_USERNAME=
GENIEACS_NBI_PASSWORD=
ACS_ONLINE_MINUTES=10
ACS_RX_WARNING=-25
ACS_RX_CRITICAL=-28
ACS_TIMEOUT_MS=12000
ACS_RX_PATH=VirtualParameters.RXPower
ACS_PPPOE_PATH=VirtualParameters.pppoeUsername
ACS_TEMPERATURE_PATH=VirtualParameters.gettemp
ACS_CLIENTS_PATH=VirtualParameters.activedevices
```

`GENIEACS_NBI_URL` harus menunjuk ke NBI GenieACS, bukan CWMP port 7547 dan bukan UI port 3000. Untuk instalasi Anda, uji dahulu apakah `http://192.168.100.66:7557/devices?limit=1` dapat diakses dari container billing.

## Setelah deploy

1. Buka **Network Map & ONT**.
2. Klik **Test ACS**.
3. Klik **Sinkron Sekarang**.
4. Buka **Rekonsiliasi** untuk ONT yang PPPoE-nya belum cocok otomatis.
5. Buka **Network Map** untuk melihat jalur Site → ODP → ONT.

Mapping manual dikunci dan tidak akan ditimpa sinkronisasi otomatis. Sistem tetap menampilkan cache terakhir ketika GenieACS sedang tidak dapat dijangkau.

## Keamanan jaringan

Jangan membuka port 7557 langsung ke internet. Izinkan hanya IP container/server billing melalui LAN atau tunnel. Versi ini read-only terhadap konfigurasi ONT: tidak mengirim reboot, perubahan SSID, WAN, VLAN, atau factory reset.
