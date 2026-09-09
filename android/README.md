# LyricLatch for Android

This is the native Android edition of LyricLatch. It does not embed or modify Spotify. Instead, it runs the **Hey Monday** ONNX model on-device and controls the installed Spotify application through Spotify App Remote and the Spotify Web API.

## Mobile feature set

- Offline `Hey Monday` wake-word inference at 16 kHz using ONNX Runtime Android
- Android microphone foreground service with an always-visible notification
- Silero VAD command and follow-up capture
- Sarvam Saaras v3 `codemix` transcription
- Spotify OAuth Authorization Code with PKCE; no client secret in the APK
- Spotify play, pause, next, previous, exact/relative seek, repeat, and volume controls
- YouTube-assisted song identification followed by Spotify catalog search
- Interactive lyric or timestamp section looping with LRCLIB synchronized lyrics
- Android Keystore encryption for client IDs, API keys, and OAuth tokens
- Optional HTTPS backend mode for an Azure-hosted companion

## Prerequisites

- Android 9 (API 28) or newer
- The official Spotify Android app, already signed in
- A Spotify developer application
- A managed HTTPS companion deployment (the personal APK can be built with this preconfigured)
- Android Studio or JDK 17+ with Android SDK 36

Playback-control endpoints may require Spotify Premium. Spotify development-mode applications must also allowlist the Spotify account used on the phone.

## Spotify developer setup

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), configure:

| Setting | Value |
| --- | --- |
| Android package | `ai.beyondmarks.lyriclatch` |
| Redirect URI | `lyriclatch-login://callback` |
| Android API | Enabled |

Get the debug signing fingerprint after the first build:

```powershell
cd android
.\gradlew.bat signingReport
```

Add the printed debug SHA-1 fingerprint to the Spotify application settings. A separately signed release APK needs its release-key SHA-1 registered as well.

## Build

Spotify distributes App Remote as an AAR rather than through Maven Central. Download the official version before building:

```powershell
cd android
.\scripts\fetch-spotify-sdk.ps1
.\gradlew.bat testDebugUnitTest assembleDebug
```

The debug APK is created at:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Install it over USB debugging:

```powershell
C:\Users\YOUR_NAME\AppData\Local\Android\Sdk\platform-tools\adb.exe install -r app\build\outputs\apk\debug\app-debug.apk
```

## First run

1. Open LyricLatch and enter the Spotify Client ID from your Spotify developer application.
2. Tap **Connect Spotify**, approve access, and return to LyricLatch.
3. Approve microphone and notification access when Android asks.
4. LyricLatch starts the foreground listener automatically. Keep its notification enabled, play Spotify, and say **“Hey Monday.”**

Sarvam, YouTube, and the companion URL are not entered on the phone. They are injected into the managed Azure service and personal APK during deployment. Spotify authorization is still required once because Spotify does not permit applications to bypass account consent.

Android requires the microphone listener to be started while the application is visible. The foreground notification remains visible for the entire listening session and includes a Stop action.

## Voice examples

- “Play Monta Re”
- “Pause”, “resume”, “next”, or “previous track”
- “Skip forward thirty seconds”
- “Go to one minute twenty seconds”
- “Repeat this song” or “loop playlist”
- “Loop song part”, followed by “from 1:20 to 1:35”
- “Loop the part starting with raghupati raghav”
- “Make the loop longer”, “next occurrence”, or “I’m satisfied”

## Privacy and credentials

The wake phrase is evaluated entirely on the phone. Only the captured command following a wake detection is sent to Sarvam or the configured backend. Song queries may be sent to YouTube, Spotify, and LRCLIB.

Provider API keys remain in Azure and are not stored in the APK. The personal APK carries a revocable companion access token; do not distribute it publicly. For wider distribution, replace this token with user authentication, rate limiting, and device attestation.

## Known platform boundary

Spotify does not expose its private synchronized-lyrics endpoint through the public Android SDK. Consequently, the Android edition uses LRCLIB or explicit timestamps for section looping. All core playback and timing behavior is native; it does not require Spicetify or the desktop companion.
