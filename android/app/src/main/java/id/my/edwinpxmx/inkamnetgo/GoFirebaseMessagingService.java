package id.my.edwinpxmx.inkamnetgo;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public final class GoFirebaseMessagingService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        PushManager.rememberNewToken(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String,String> data = message.getData();
        String title = data.get("title");
        String detail = data.get("detail");
        String href = data.get("href");
        if (message.getNotification() != null) {
            if (title == null) title = message.getNotification().getTitle();
            if (detail == null) detail = message.getNotification().getBody();
        }
        NotificationHelper.createChannel(this);
        NotificationHelper.show(this, title, detail, href, data.get("notificationId"));
    }
}
