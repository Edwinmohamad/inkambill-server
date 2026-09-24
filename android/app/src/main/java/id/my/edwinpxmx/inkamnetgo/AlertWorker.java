package id.my.edwinpxmx.inkamnetgo;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

public final class AlertWorker extends Worker {
    private static final String WORK_NAME = "inkamnet-go-alert-sync";
    private static final String ALERT_URL = "https://inkambill.edwinpxmx.my.id/communication/header";

    public AlertWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(AlertWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .setInitialDelay(2, TimeUnit.MINUTES)
                .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        HttpURLConnection connection = null;
        try {
            String cookie = CookieManager.getInstance().getCookie(ALERT_URL);
            if (cookie == null || cookie.isEmpty()) return Result.success();
            connection = (HttpURLConnection) new URL(ALERT_URL).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(12_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("User-Agent", "INKAMNET-GO/" + BuildConfig.VERSION_NAME + " background");
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != 200) return Result.success();

            StringBuilder response = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null && response.length() < 64_000) response.append(line);
            }
            JSONObject payload = new JSONObject(response.toString());
            JSONArray notifications = payload.optJSONArray("notifications");
            if (notifications == null || notifications.length() == 0) return Result.success();

            // Only unread persistent notifications (same source as FCM). Dynamic counters such as
            // "12 tagihan lewat tempo" change constantly and already-read items must not re-alert.
            JSONObject first = null;
            for (int i = 0; i < notifications.length(); i++) {
                JSONObject item = notifications.optJSONObject(i);
                if (item != null && item.optBoolean("persistent", false) && item.isNull("read_at")) {
                    first = item;
                    break;
                }
            }
            if (first == null) return Result.success();
            String title = first.optString("title", "INKAMNET GO");
            String detail = first.optString("detail", "Ada pembaruan operasional.");
            String href = first.optString("href", "/");
            String notificationKey = first.has("id") ? first.optString("id") : null;
            String fingerprint = notificationKey != null ? "id:" + notificationKey : title + "|" + detail + "|" + href;
            SharedPreferences prefs = getApplicationContext().getSharedPreferences("inkamnet_go", Context.MODE_PRIVATE);
            if (fingerprint.equals(prefs.getString("last_alert_fingerprint", ""))) return Result.success();
            prefs.edit().putString("last_alert_fingerprint", fingerprint).apply();
            NotificationHelper.show(getApplicationContext(), title, detail, href, notificationKey);
            return Result.success();
        } catch (Exception ignored) {
            return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
