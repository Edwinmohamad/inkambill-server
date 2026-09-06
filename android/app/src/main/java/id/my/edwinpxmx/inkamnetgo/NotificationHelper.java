package id.my.edwinpxmx.inkamnetgo;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

final class NotificationHelper {
    private static final String CHANNEL_ID = "inkamnet_operations";
    private static final String APP_ORIGIN = "https://inkambill.edwinpxmx.my.id";

    private NotificationHelper() {}

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Operasional INKAMNET", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Tiket, billing, stok, jaringan, dan approval penting.");
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    static void show(Context context, String title, String detail, String href) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;

        Uri destination = trustedDestination(href);
        Intent intent = new Intent(context, MainActivity.class);
        intent.setData(destination);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, 6201, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(0xFF6C4BFF)
                .setContentTitle(safe(title, 120, "INKAMNET GO"))
                .setContentText(safe(detail, 220, "Ada pembaruan operasional."))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(safe(detail, 500, "Ada pembaruan operasional.")))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(6201, builder.build());
    }

    private static Uri trustedDestination(String href) {
        try {
            Uri candidate = Uri.parse(href == null ? "" : href);
            if (candidate.isRelative() && href != null && href.startsWith("/")) {
                return Uri.parse(APP_ORIGIN + href);
            }
            if ("https".equalsIgnoreCase(candidate.getScheme())
                    && "inkambill.edwinpxmx.my.id".equalsIgnoreCase(candidate.getHost())) return candidate;
        } catch (Exception ignored) {}
        return Uri.parse(APP_ORIGIN + "/");
    }

    private static String safe(String value, int max, String fallback) {
        String normalized = value == null ? "" : value.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", "").trim();
        if (normalized.isEmpty()) return fallback;
        return normalized.length() <= max ? normalized : normalized.substring(0, max);
    }
}
