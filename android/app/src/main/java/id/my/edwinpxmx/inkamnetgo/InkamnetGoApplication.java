package id.my.edwinpxmx.inkamnetgo;

import android.app.Application;

public final class InkamnetGoApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        CrashReporter.install(this);
        NotificationHelper.createChannel(this);
        PushManager.initialize(this);
    }
}
