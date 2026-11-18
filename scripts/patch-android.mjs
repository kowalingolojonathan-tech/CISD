// Run in CI right after `npx cap add android`.
// Adds what Capacitor doesn't generate: notification permission, default FCM channel,
// and a monotonically increasing versionCode so new APKs install over old ones.
import fs from 'node:fs';

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let manifest = fs.readFileSync(manifestPath, 'utf8');

if (!manifest.includes('android.permission.POST_NOTIFICATIONS')) {
  manifest = manifest.replace(
    '</manifest>',
    '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>'
  );
}
if (!manifest.includes('default_notification_channel_id')) {
  manifest = manifest.replace(
    '</application>',
    '    <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="signals" />\n    </application>'
  );
}
fs.writeFileSync(manifestPath, manifest);

const gradlePath = 'android/app/build.gradle';
let gradle = fs.readFileSync(gradlePath, 'utf8');
const run = Number(process.env.GITHUB_RUN_NUMBER || '1');
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${run}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "1.0.${run}"`);
fs.writeFileSync(gradlePath, gradle);

console.log(`Android project patched (versionCode ${run}).`);
