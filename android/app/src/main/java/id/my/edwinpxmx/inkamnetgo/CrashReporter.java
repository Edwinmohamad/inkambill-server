package id.my.edwinpxmx.inkamnetgo;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class CrashReporter {
    private static final String REPORT_URL = "https://inkamnetbilling.edwinpxmx.my.id/api/mobile/crash";
    private static final String PREFS = "inkamnet_go";
    private static final String PENDING = "pending_crash";
    private static boolean installed;

    private CrashReporter() {}

    static synchronized void install(Context context) {
        if (installed) return;
        installed = true;
        Context app = context.getApplicationContext();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            try { save(app, throwable); } catch (Exception ignored) {}
            if (previous != null) previous.uncaughtException(thread, throwable);
            else System.exit(2);
        });
    }

    private static void save(Context context, Throwable throwable) throws Exception {
        StringWriter writer = new StringWriter();
        throwable.printStackTrace(new PrintWriter(writer));
        JSONObject payload = new JSONObject();
        payload.put("appVersion", BuildConfig.VERSION_NAME);
        payload.put("androidVersion", Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        payload.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
        payload.put("exceptionClass", throwable.getClass().getName());
        payload.put("message", limit(throwable.getMessage(), 1000));
        payload.put("stackTrace", limit(writer.toString(), 12000));
        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        payload.put("occurredAt", iso.format(new Date()));
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(PENDING, payload.toString()).commit();
    }

    static void uploadPending(Context context) {
        Context app = context.getApplicationContext();
        SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String payload = prefs.getString(PENDING, "");
        if (payload == null || payload.isEmpty()) return;
        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                String cookie = CookieManager.getInstance().getCookie(REPORT_URL);
                if (cookie == null || cookie.isEmpty()) return;
                connection = (HttpURLConnection) new URL(REPORT_URL).openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(10_000);
                connection.setDoOutput(true);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Cookie", cookie);
                connection.setRequestProperty("X-INKAMNET-GO", "1");
                byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                int code = connection.getResponseCode();
                if (code >= 200 && code < 300 && payload.equals(prefs.getString(PENDING, ""))) {
                    prefs.edit().remove(PENDING).apply();
                }
            } catch (Exception ignored) {
                // The saved report remains queued for the next authenticated launch.
            } finally {
                if (connection != null) connection.disconnect();
                executor.shutdown();
            }
        });
    }

    private static String limit(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max);
    }
}
