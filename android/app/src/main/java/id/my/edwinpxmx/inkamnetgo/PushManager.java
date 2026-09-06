package id.my.edwinpxmx.inkamnetgo;

import android.content.Context;
import android.os.Build;
import android.webkit.CookieManager;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class PushManager {
    private static final String REGISTER_URL = "https://inkambill.edwinpxmx.my.id/api/mobile/push-token";

    private PushManager() {}

    static boolean initialize(Context context) {
        Context app = context.getApplicationContext();
        try {
            if (!configured()) return false;
            if (FirebaseApp.getApps(app).isEmpty()) {
                FirebaseOptions options = new FirebaseOptions.Builder()
                        .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
                        .setApiKey(BuildConfig.FIREBASE_API_KEY)
                        .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                        .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                        .build();
                FirebaseApp.initializeApp(app, options);
            }
            return true;
        } catch (Exception ignored) { return false; }
    }

    static void register(Context context) {
        Context app = context.getApplicationContext();
        try {
            if (!initialize(app)) return;
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) sendToken(app, task.getResult());
            });
        } catch (Exception ignored) {
            // Periodic local notifications remain active when Firebase is not configured.
        }
    }

    static void rememberNewToken(Context context, String token) {
        context.getSharedPreferences("inkamnet_go", Context.MODE_PRIVATE)
                .edit().putString("pending_push_token", token).apply();
        sendToken(context.getApplicationContext(), token);
    }

    private static boolean configured() {
        return !BuildConfig.FIREBASE_APPLICATION_ID.isEmpty()
                && !BuildConfig.FIREBASE_API_KEY.isEmpty()
                && !BuildConfig.FIREBASE_PROJECT_ID.isEmpty()
                && !BuildConfig.FIREBASE_SENDER_ID.isEmpty();
    }

    private static void sendToken(Context context, String token) {
        if (token == null || token.length() < 40) return;
        String cookie;
        try { cookie = CookieManager.getInstance().getCookie(REGISTER_URL); }
        catch (Exception ignored) { cookie = null; }
        if (cookie == null || cookie.isEmpty()) {
            context.getSharedPreferences("inkamnet_go", Context.MODE_PRIVATE)
                    .edit().putString("pending_push_token", token).apply();
            return;
        }
        final String sessionCookie = cookie;
        String previous = context.getSharedPreferences("inkamnet_go", Context.MODE_PRIVATE)
                .getString("registered_push_token", "");
        if (token.equals(previous)) return;
        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                JSONObject payload = new JSONObject();
                payload.put("token", token);
                payload.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
                payload.put("appVersion", BuildConfig.VERSION_NAME);
                byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection = (HttpURLConnection) new URL(REGISTER_URL).openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(10_000);
                connection.setDoOutput(true);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setRequestProperty("Cookie", sessionCookie);
                connection.setRequestProperty("X-INKAMNET-GO", "1");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                int code = connection.getResponseCode();
                if (code >= 200 && code < 300) {
                    context.getSharedPreferences("inkamnet_go", Context.MODE_PRIVATE).edit()
                            .putString("registered_push_token", token).remove("pending_push_token").apply();
                }
            } catch (Exception ignored) {
                context.getSharedPreferences("inkamnet_go", Context.MODE_PRIVATE)
                        .edit().putString("pending_push_token", token).apply();
            } finally {
                if (connection != null) connection.disconnect();
                executor.shutdown();
            }
        });
    }
}
