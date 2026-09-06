package id.my.edwinpxmx.inkamnetgo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class UpdateChecker {
    private static final String VERSION_URL = "https://inkambill.edwinpxmx.my.id/api/mobile/version";
    private static boolean checked;

    private UpdateChecker() {}

    static synchronized void check(Activity activity) {
        if (checked) return;
        checked = true;
        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(VERSION_URL).openConnection();
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(10_000);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("User-Agent", "INKAMNET-GO/" + BuildConfig.VERSION_NAME);
                if (connection.getResponseCode() != 200) return;
                StringBuilder response = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                        connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null && response.length() < 16_000) response.append(line);
                }
                JSONObject payload = new JSONObject(response.toString());
                int remoteCode = payload.optInt("versionCode", BuildConfig.VERSION_CODE);
                String remoteName = payload.optString("versionName", "versi terbaru");
                String apkUrl = payload.optString("apkUrl", "");
                boolean forced = payload.optBoolean("forceUpdate", false);
                if (remoteCode <= BuildConfig.VERSION_CODE || !isHttps(apkUrl)) return;
                int dismissed = activity.getSharedPreferences("inkamnet_go", Activity.MODE_PRIVATE)
                        .getInt("dismissed_update", 0);
                if (!forced && dismissed == remoteCode) return;
                activity.runOnUiThread(() -> showDialog(activity, remoteCode, remoteName, apkUrl, forced));
            } catch (Exception ignored) {
                // Update checks must never prevent the operational app from opening.
            } finally {
                if (connection != null) connection.disconnect();
                executor.shutdown();
            }
        });
    }

    private static void showDialog(Activity activity, int code, String name, String url, boolean forced) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        AlertDialog.Builder builder = new AlertDialog.Builder(activity)
                .setTitle("Update INKAMNET GO")
                .setMessage("Versi " + name + " sudah tersedia. Perbarui untuk mendapatkan perbaikan terbaru.")
                .setPositiveButton("Update sekarang", (dialog, which) -> {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    activity.startActivity(intent);
                });
        if (!forced) builder.setNegativeButton("Nanti", (dialog, which) ->
                activity.getSharedPreferences("inkamnet_go", Activity.MODE_PRIVATE)
                        .edit().putInt("dismissed_update", code).apply());
        AlertDialog dialog = builder.create();
        dialog.setCancelable(!forced);
        dialog.setCanceledOnTouchOutside(!forced);
        dialog.show();
    }

    private static boolean isHttps(String value) {
        try { return "https".equalsIgnoreCase(Uri.parse(value).getScheme()); }
        catch (Exception ignored) { return false; }
    }
}
