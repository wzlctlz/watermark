package com.watermark.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 水印相机（安卓壳）
 *
 * 设计要点：
 * 1. 网页水印引擎（HTML/JS）打包进 APK 的 assets，通过 WebViewAssetLoader 以
 *    https://appassets.androidplatform.net/assets/index.html 提供，
 *    既避免 file:// 的限制，又不依赖线上站点是否可访问。
 * 2. 「调用系统相机」——不使用的浏览器拍照（&lt;input capture&gt;），而是在原生层拦截
 *    网页的文件选择请求（onShowFileChooser），弹出原生选择框：
 *      · 拍照 → ACTION_IMAGE_CAPTURE 调起系统相机，照片写到 FileProvider 目录，
 *        返回带完整 EXIF（含 GPS）的原图给网页引擎解析；
 *      · 相册 → ACTION_OPEN_DOCUMENT 调起系统相册（支持多选）。
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "WaterMark";
    private static final String AUTHORITY = "com.watermark.app.fileprovider";
    private static final String ASSET_HOST = "appassets.androidplatform.net";

    private static final int REQ_CAMERA_PERM = 1001;
    private static final int REQ_CAMERA_CAPTURE = 1002;
    private static final int REQ_GALLERY = 1003;

    private WebView webView;
    private WebViewAssetLoader assetLoader;

    // 网页文件选择回调（必须保存，待相机/相册返回后再回调）
    private ValueCallback<Uri[]> filePathCallback;
    private Uri currentPhotoUri;
    private boolean pendingMultiple = false;
    private Runnable pendingAction;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = findViewById(R.id.webview);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setGeolocationEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(false);
        ws.setUseWideViewPort(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 页面与外部依赖均为 https，禁止 http 混合内容
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // 本地打包资源由 assetLoader 提供；外部 CDN / 高德请求走正常网络
                if (ASSET_HOST.equals(uri.getHost())) {
                    return assetLoader.shouldInterceptRequest(uri);
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            // 照片无 EXIF GPS 时，网页会请求定位，这里直接放行
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }

            // 拦截网页的 <input type="file">，改为原生「系统相机 / 系统相册」
            @Override
            public boolean onShowFileChooser(WebView webView,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                MainActivity.this.filePathCallback = filePathCallback;
                // FileChooserParams 没有 isMultipleSelection()，用 getMode() 判断
                MainActivity.this.pendingMultiple =
                        fileChooserParams.getMode() == WebChromeClient.FileChooserParams.MODE_MULTIPLE;
                showPickerDialog();
                return true;
            }
        });

        webView.loadUrl("https://" + ASSET_HOST + "/assets/index.html");
    }

    /** 原生选择框：拍照（系统相机）/ 从相册选择 */
    private void showPickerDialog() {
        String[] items = pendingMultiple
                ? new String[]{"拍照（系统相机）", "从相册选择（可多选）"}
                : new String[]{"拍照（系统相机）", "从相册选择"};

        new AlertDialog.Builder(this)
                .setTitle("添加照片")
                .setItems(items, (dialog, which) -> {
                    if (which == 0) {
                        ensureCameraPermissionThen(this::openCamera);
                    } else {
                        openGallery();
                    }
                })
                .setNegativeButton("取消", (dialog, which) -> completeWithNull())
                .setOnCancelListener(dialog -> completeWithNull())
                .show();
    }

    private void ensureCameraPermissionThen(Runnable action) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) {
            action.run();
        } else {
            pendingAction = action;
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERM);
        }
    }

    /** 调用系统相机拍照，输出到 FileProvider 目录（保留完整 EXIF） */
    private void openCamera() {
        Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (capture.resolveActivity(getPackageManager()) == null) {
            Toast.makeText(this, "未找到系统相机应用", Toast.LENGTH_SHORT).show();
            completeWithNull();
            return;
        }
        File photoFile;
        try {
            photoFile = createImageFile();
        } catch (IOException e) {
            Log.e(TAG, "创建照片文件失败", e);
            Toast.makeText(this, "创建照片文件失败", Toast.LENGTH_SHORT).show();
            completeWithNull();
            return;
        }
        currentPhotoUri = FileProvider.getUriForFile(this, AUTHORITY, photoFile);
        capture.putExtra(MediaStore.EXTRA_OUTPUT, currentPhotoUri);
        capture.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(capture, REQ_CAMERA_CAPTURE);
    }

    private File createImageFile() throws IOException {
        String ts = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
        File dir = new File(getCacheDir(), "captured");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建缓存目录: " + dir.getAbsolutePath());
        }
        return new File(dir, "WM_" + ts + ".jpg");
    }

    /** 调用系统相册（支持多选） */
    private void openGallery() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        if (pendingMultiple) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(intent, REQ_GALLERY);
    }

    private void completeWithNull() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (filePathCallback == null) return;

        if (requestCode == REQ_CAMERA_CAPTURE) {
            if (resultCode == RESULT_OK && currentPhotoUri != null) {
                filePathCallback.onReceiveValue(new Uri[]{currentPhotoUri});
            } else {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = null;
            currentPhotoUri = null;
        } else if (requestCode == REQ_GALLERY) {
            if (resultCode == RESULT_OK && data != null) {
                Uri[] uris;
                if (pendingMultiple && data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        uris[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                } else {
                    uris = null;
                }
                filePathCallback.onReceiveValue(uris);
            } else {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode,
                                           @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA_PERM) {
            if (grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (pendingAction != null) {
                    pendingAction.run();
                    pendingAction = null;
                }
            } else {
                Toast.makeText(this, "需要相机权限才能拍照", Toast.LENGTH_SHORT).show();
                completeWithNull();
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
