// Run in CI right after `npx cap add android`.
// Adds what Capacitor doesn't generate:
//  - permissions (notifications, foreground service, wake lock, battery exemption)
//  - a foreground service + Capacitor plugin so the on-device engine keeps running in background
//  - MainActivity tweak that keeps WebView timers running when the app is not visible
//  - default FCM channel (server mode) and a growing versionCode (APK updates install over old ones)
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync('capacitor.config.json', 'utf8'));
const appId = cfg.appId;
const javaDir = path.join('android/app/src/main/java', ...appId.split('.'));
fs.mkdirSync(javaDir, { recursive: true });

/* ------------------------------- manifest -------------------------------- */
const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let manifest = fs.readFileSync(manifestPath, 'utf8');

const permissions = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
];
for (const perm of permissions) {
  if (!manifest.includes(`"${perm}"`)) {
    manifest = manifest.replace(
      '</manifest>',
      `    <uses-permission android:name="${perm}" />\n</manifest>`
    );
  }
}

if (!manifest.includes('.KeepAliveService')) {
  manifest = manifest.replace(
    '</application>',
    `        <service
            android:name=".KeepAliveService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="market_monitoring" />
        </service>
    </application>`
  );
}
if (!manifest.includes('default_notification_channel_id')) {
  manifest = manifest.replace(
    '</application>',
    '    <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="signals" />\n    </application>'
  );
}
fs.writeFileSync(manifestPath, manifest);

/* ------------------------------ Java sources ----------------------------- */
fs.writeFileSync(
  path.join(javaDir, 'KeepAliveService.java'),
  `package ${appId};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class KeepAliveService extends Service {
    private static final String CHANNEL_ID = "cisd_service";
    private static final int NOTIFICATION_ID = 4242;
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setContentTitle("Killzone CISD Desk")
                .setContentText("Surveillance XAU/USD et EUR/USD active")
                .setSmallIcon(getApplicationInfo().icon)
                .setOngoing(true)
                .setContentIntent(pendingIntent);
        Notification notification = builder.build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cisd:keepalive");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) {
                wakeLock.acquire();
            }
        }
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID, "Surveillance en cours", NotificationManager.IMPORTANCE_LOW);
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
    }
}
`
);

fs.writeFileSync(
  path.join(javaDir, 'KeepAlivePlugin.java'),
  `package ${appId};

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, KeepAliveService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Service impossible a demarrer: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, KeepAliveService.class));
        call.resolve();
    }

    @PluginMethod
    public void batteryStatus(PluginCall call) {
        boolean ignoring = true;
        if (Build.VERSION.SDK_INT >= 23) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            ignoring = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        }
        JSObject result = new JSObject();
        result.put("ignoring", ignoring);
        call.resolve(result);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Demande impossible: " + e.getMessage());
        }
    }
}
`
);

fs.writeFileSync(
  path.join(javaDir, 'MainActivity.java'),
  `package ${appId};

import android.os.Bundle;
import android.view.View;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Keep the WebView "visible" so JS timers (the on-device engine) are not throttled
    // when the screen is off or the app is in the background.
    @Override
    public void onPause() {
        super.onPause();
        keepWebViewRunning();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewRunning();
    }

    private void keepWebViewRunning() {
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().dispatchWindowVisibilityChanged(View.VISIBLE);
            }
        } catch (Exception ignored) {
            // best effort
        }
    }
}
`
);

/* --------------------------------- version -------------------------------- */
const gradlePath = 'android/app/build.gradle';
let gradle = fs.readFileSync(gradlePath, 'utf8');
const run = Number(process.env.GITHUB_RUN_NUMBER || '1');
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${run}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "1.0.${run}"`);
fs.writeFileSync(gradlePath, gradle);

console.log(`Android project patched for ${appId} (versionCode ${run}).`);
