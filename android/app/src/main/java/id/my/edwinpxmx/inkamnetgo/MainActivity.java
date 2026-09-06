package id.my.edwinpxmx.inkamnetgo;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import android.net.http.SslError;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

public final class MainActivity extends FragmentActivity {
    private static final String HOME_URL = "https://inkamnetbilling.edwinpxmx.my.id/";
    private static final String APP_HOST = "inkamnetbilling.edwinpxmx.my.id";
    private static final int FILE_CHOOSER_REQUEST = 4101;
    private static final int STORAGE_PERMISSION_REQUEST = 4102;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4103;
    private static final long LOCK_AFTER_MS = 120_000L;

    private WebView webView;
    private ProgressBar progressBar;
    private View splashView;
    private View offlineView;
    private View lockView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraOutputUri;
    private PendingDownload pendingDownload;
    private long backgroundAt;
    private boolean unlockPromptVisible;
    private boolean initialStartHandled;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CrashReporter.install(this);
        NotificationHelper.createChannel(this);
        AlertWorker.schedule(this);
        getWindow().setStatusBarColor(Color.rgb(9, 13, 24));
        getWindow().setNavigationBarColor(Color.rgb(9, 13, 24));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(9, 13, 24));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(9, 13, 24));
        root.addView(webView, matchParent());

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(108, 75, 255)));
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP);
        root.addView(progressBar, progressParams);

        offlineView = createOfflineView();
        offlineView.setVisibility(View.GONE);
        root.addView(offlineView, matchParent());

        lockView = createLockView();
        lockView.setVisibility(hasKnownSession() ? View.VISIBLE : View.GONE);
        root.addView(lockView, matchParent());

        splashView = createSplashView();
        root.addView(splashView, matchParent());

        setContentView(root);
        configureWebView();
        UpdateChecker.check(this);

        if (savedInstanceState != null && webView.restoreState(savedInstanceState) != null) {
            hideSplash();
        } else {
            String launchUrl = trustedLaunchUrl(getIntent());
            loadUrl(launchUrl);
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setUserAgentString(settings.getUserAgentString() + " INKAMNET-GO/" + BuildConfig.VERSION_NAME);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                offlineView.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
                hideSplash();
                if (isAuthenticatedPage(url)) {
                    getSharedPreferences("inkamnet_go", MODE_PRIVATE).edit().putBoolean("known_session", true).apply();
                    requestNotificationPermissionOnce();
                    CrashReporter.uploadPending(MainActivity.this);
                    PushManager.register(MainActivity.this);
                } else if (isLoginPage(url)) {
                    getSharedPreferences("inkamnet_go", MODE_PRIVATE).edit()
                            .putBoolean("known_session", false)
                            .remove("registered_push_token")
                            .apply();
                    lockView.setVisibility(View.GONE);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 500) showOffline();
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (view.getUrl() == null || isTrustedWebUrl(Uri.parse(view.getUrl()))) showOffline();
                Toast.makeText(MainActivity.this, "Koneksi aman gagal diverifikasi.", Toast.LENGTH_LONG).show();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                cancelFileCallback();
                fileCallback = callback;
                openFileChooser(params);
                return true;
            }
        });

        webView.setDownloadListener(createDownloadListener());
    }

    private boolean handleNavigation(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (isTrustedWebUrl(uri) || "about".equals(scheme)) return false;

        if ("https".equals(scheme) || "http".equals(scheme) || "tel".equals(scheme)
                || "mailto".equals(scheme) || "sms".equals(scheme) || "geo".equals(scheme)
                || "whatsapp".equals(scheme)) {
            openExternal(uri);
        }
        return true;
    }

    private boolean isTrustedWebUrl(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
                && APP_HOST.equalsIgnoreCase(uri.getHost());
    }

    private boolean isLoginPage(String url) {
        try {
            Uri uri = Uri.parse(url);
            return isTrustedWebUrl(uri) && "/login".equals(uri.getPath());
        } catch (Exception ignored) { return false; }
    }

    private boolean isAuthenticatedPage(String url) {
        try {
            Uri uri = Uri.parse(url);
            return isTrustedWebUrl(uri) && !"/login".equals(uri.getPath());
        } catch (Exception ignored) { return false; }
    }

    private boolean hasKnownSession() {
        return getSharedPreferences("inkamnet_go", MODE_PRIVATE).getBoolean("known_session", false);
    }

    private String trustedLaunchUrl(Intent intent) {
        Uri uri = intent == null ? null : intent.getData();
        return uri != null && isTrustedWebUrl(uri) ? uri.toString() : HOME_URL;
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Aplikasi untuk membuka tautan belum tersedia.", Toast.LENGTH_SHORT).show();
        }
    }

    private void loadUrl(String url) {
        if (!hasNetwork()) {
            showOffline();
            return;
        }
        offlineView.setVisibility(View.GONE);
        webView.loadUrl(url);
    }

    private boolean hasNetwork() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null || manager.getActiveNetwork() == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void showOffline() {
        progressBar.setVisibility(View.GONE);
        hideSplash();
        offlineView.setVisibility(View.VISIBLE);
    }

    private void hideSplash() {
        if (splashView != null && splashView.getVisibility() == View.VISIBLE) {
            splashView.animate().alpha(0f).setDuration(220).withEndAction(() -> splashView.setVisibility(View.GONE)).start();
        }
    }

    private View createSplashView() {
        LinearLayout splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(Gravity.CENTER);
        splash.setPadding(dp(28), dp(28), dp(28), dp(28));
        splash.setBackgroundColor(Color.rgb(9, 13, 24));

        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.inkamnet_mark);
        LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(82), dp(82));
        markParams.bottomMargin = dp(20);
        splash.addView(mark, markParams);

        TextView name = text("INKAMNET GO", 25, Color.WHITE, true);
        name.setLetterSpacing(.12f);
        splash.addView(name);

        TextView tagline = text("CONNECT  ·  CONTROL  ·  GROW", 10, Color.rgb(174, 184, 208), true);
        tagline.setLetterSpacing(.16f);
        LinearLayout.LayoutParams taglineParams = wrapContent();
        taglineParams.topMargin = dp(10);
        splash.addView(tagline, taglineParams);

        ProgressBar spinner = new ProgressBar(this);
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Color.rgb(108, 75, 255)));
        LinearLayout.LayoutParams spinnerParams = new LinearLayout.LayoutParams(dp(26), dp(26));
        spinnerParams.topMargin = dp(32);
        splash.addView(spinner, spinnerParams);
        return splash;
    }

    private View createOfflineView() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(30), dp(30), dp(30), dp(30));
        panel.setBackgroundColor(Color.rgb(9, 13, 24));

        TextView symbol = text("↯", 42, Color.rgb(108, 75, 255), true);
        panel.addView(symbol);

        TextView title = text(getString(R.string.offline_title), 22, Color.WHITE, true);
        LinearLayout.LayoutParams titleParams = wrapContent();
        titleParams.topMargin = dp(14);
        panel.addView(title, titleParams);

        TextView body = text(getString(R.string.offline_body), 14, Color.rgb(174, 184, 208), false);
        LinearLayout.LayoutParams bodyParams = wrapContent();
        bodyParams.topMargin = dp(8);
        bodyParams.bottomMargin = dp(22);
        panel.addView(body, bodyParams);

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setTextColor(Color.WHITE);
        retry.setTextSize(13);
        retry.setAllCaps(false);
        retry.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(108, 75, 255)));
        retry.setPadding(dp(22), dp(5), dp(22), dp(5));
        retry.setOnClickListener(v -> loadUrl(webView.getUrl() == null ? HOME_URL : webView.getUrl()));
        panel.addView(retry, new LinearLayout.LayoutParams(dp(150), dp(48)));
        return panel;
    }

    private View createLockView() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(30), dp(30), dp(30), dp(30));
        panel.setBackgroundColor(Color.rgb(9, 13, 24));

        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.inkamnet_mark);
        LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(68), dp(68));
        markParams.bottomMargin = dp(18);
        panel.addView(mark, markParams);
        panel.addView(text("Buka INKAMNET GO", 22, Color.WHITE, true));

        TextView detail = text("Verifikasi identitas untuk melanjutkan.", 13, Color.rgb(174, 184, 208), false);
        LinearLayout.LayoutParams detailParams = wrapContent();
        detailParams.topMargin = dp(8);
        detailParams.bottomMargin = dp(22);
        panel.addView(detail, detailParams);

        Button unlock = new Button(this);
        unlock.setText("Buka dengan biometrik");
        unlock.setTextColor(Color.WHITE);
        unlock.setTextSize(13);
        unlock.setAllCaps(false);
        unlock.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(108, 75, 255)));
        unlock.setOnClickListener(v -> showBiometricUnlock());
        panel.addView(unlock, new LinearLayout.LayoutParams(dp(220), dp(48)));
        return panel;
    }

    private void requestNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        android.content.SharedPreferences prefs = getSharedPreferences("inkamnet_go", MODE_PRIVATE);
        if (prefs.getBoolean("notification_permission_asked", false)) return;
        prefs.edit().putBoolean("notification_permission_asked", true).apply();
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
    }

    private void showBiometricUnlock() {
        if (unlockPromptVisible || !hasKnownSession()) {
            if (!hasKnownSession()) lockView.setVisibility(View.GONE);
            return;
        }
        final int authenticators = Build.VERSION.SDK_INT >= 30
                ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
                : BiometricManager.Authenticators.BIOMETRIC_WEAK;
        if (BiometricManager.from(this).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            lockView.setVisibility(View.GONE);
            return;
        }
        unlockPromptVisible = true;
        BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        super.onAuthenticationSucceeded(result);
                        unlockPromptVisible = false;
                        lockView.animate().alpha(0f).setDuration(160).withEndAction(() -> {
                            lockView.setVisibility(View.GONE);
                            lockView.setAlpha(1f);
                        }).start();
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence errString) {
                        super.onAuthenticationError(errorCode, errString);
                        unlockPromptVisible = false;
                        lockView.setVisibility(View.VISIBLE);
                    }
                });
        BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("INKAMNET GO")
                .setSubtitle("Konfirmasi identitas Anda")
                .setAllowedAuthenticators(authenticators);
        if (Build.VERSION.SDK_INT < 30) info.setNegativeButtonText("Batal");
        prompt.authenticate(info.build());
    }

    private TextView text(String value, int sizeSp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        if (bold) view.setTypeface(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD);
        return view;
    }

    private void openFileChooser(WebChromeClient.FileChooserParams params) {
        Intent contentIntent;
        try {
            contentIntent = params.createIntent();
        } catch (ActivityNotFoundException e) {
            contentIntent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            contentIntent.addCategory(Intent.CATEGORY_OPENABLE);
            contentIntent.setType("*/*");
        }

        Intent cameraIntent = createCameraIntent();
        Intent chooser = Intent.createChooser(contentIntent, "Pilih file atau ambil foto");
        if (cameraIntent != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});

        try {
            startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
        } catch (ActivityNotFoundException e) {
            cancelFileCallback();
            Toast.makeText(this, "Pemilih file tidak tersedia.", Toast.LENGTH_SHORT).show();
        }
    }

    private Intent createCameraIntent() {
        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (cameraIntent.resolveActivity(getPackageManager()) == null) return null;

        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "inkamnet-go-" + System.currentTimeMillis() + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        cameraOutputUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (cameraOutputUri == null) return null;

        cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutputUri);
        cameraIntent.setClipData(ClipData.newRawUri("INKAMNET GO photo", cameraOutputUri));
        cameraIntent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return cameraIntent;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;

        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
                deleteUnusedCameraOutput();
            } else if (data != null && data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                deleteUnusedCameraOutput();
            } else if (cameraOutputUri != null) {
                result = new Uri[]{cameraOutputUri};
            }
        } else if (cameraOutputUri != null) {
            deleteUnusedCameraOutput();
        }

        fileCallback.onReceiveValue(result);
        fileCallback = null;
        cameraOutputUri = null;
    }

    private void deleteUnusedCameraOutput() {
        if (cameraOutputUri == null) return;
        try {
            getContentResolver().delete(cameraOutputUri, null, null);
        } catch (Exception ignored) {
            // A failed cleanup must not break the selected gallery/document upload.
        }
    }

    private void cancelFileCallback() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = null;
    }

    private DownloadListener createDownloadListener() {
        return (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            Uri uri = Uri.parse(url);
            if (!"https".equalsIgnoreCase(uri.getScheme())) {
                Toast.makeText(this, "Unduhan non-HTTPS diblokir.", Toast.LENGTH_LONG).show();
                return;
            }
            PendingDownload download = new PendingDownload(url, userAgent, contentDisposition, mimeType);
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                    && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                pendingDownload = download;
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_PERMISSION_REQUEST);
                return;
            }
            enqueueDownload(download);
        };
    }

    private void enqueueDownload(PendingDownload download) {
        try {
            String fileName = URLUtil.guessFileName(download.url, download.contentDisposition, download.mimeType);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(download.url));
            request.setTitle(fileName);
            request.setDescription("Diunduh dari INKAMNET GO");
            request.setMimeType(download.mimeType);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            request.addRequestHeader("User-Agent", download.userAgent);
            String cookie = CookieManager.getInstance().getCookie(download.url);
            if (cookie != null && !cookie.isEmpty()) request.addRequestHeader("Cookie", cookie);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("DownloadManager unavailable");
            manager.enqueue(request);
            Toast.makeText(this, "Mengunduh " + fileName, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Unduhan gagal dimulai.", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == STORAGE_PERMISSION_REQUEST && pendingDownload != null) {
            PendingDownload download = pendingDownload;
            pendingDownload = null;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                enqueueDownload(download);
            } else {
                Toast.makeText(this, "Izin penyimpanan diperlukan untuk mengunduh file.", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (lockView == null) return;
        if (!hasKnownSession()) {
            lockView.setVisibility(View.GONE);
            initialStartHandled = true;
            return;
        }
        long awayFor = backgroundAt == 0 ? Long.MAX_VALUE : SystemClock.elapsedRealtime() - backgroundAt;
        boolean shouldLock = !initialStartHandled || awayFor >= LOCK_AFTER_MS;
        initialStartHandled = true;
        backgroundAt = 0;
        if (shouldLock) {
            lockView.setVisibility(View.VISIBLE);
            lockView.post(this::showBiometricUnlock);
        } else {
            lockView.setVisibility(View.GONE);
        }
    }

    @Override
    protected void onStop() {
        if (!isChangingConfigurations() && hasKnownSession() && fileCallback == null) {
            backgroundAt = SystemClock.elapsedRealtime();
            if (lockView != null) lockView.setVisibility(View.VISIBLE);
        }
        super.onStop();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = trustedLaunchUrl(intent);
        if (!url.equals(webView.getUrl())) loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (lockView != null && lockView.getVisibility() == View.VISIBLE) {
            moveTaskToBack(true);
        } else if (fileCallback != null) {
            cancelFileCallback();
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        cancelFileCallback();
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }

    private FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private LinearLayout.LayoutParams wrapContent() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static final class PendingDownload {
        final String url;
        final String userAgent;
        final String contentDisposition;
        final String mimeType;

        PendingDownload(String url, String userAgent, String contentDisposition, String mimeType) {
            this.url = url;
            this.userAgent = userAgent == null ? "INKAMNET-GO/1.0" : userAgent;
            this.contentDisposition = contentDisposition;
            this.mimeType = mimeType == null ? "application/octet-stream" : mimeType;
        }
    }
}
