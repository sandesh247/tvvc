# AI Agent instructions (gemini.md)

This file contains instructions for any AI assistant working on the **TVVC** project.

## Android Build Versioning Rule

> [!IMPORTANT]
> **Every time** the user asks to build the Android app (`.aab` or `.apk`) for publication or updates, you **MUST** increment the versioning fields in [build.gradle.kts](file:///Users/sandesh247/github/tvvc/tvvc/android/app/build.gradle.kts) before running the build:
>
> 1. Increment `versionCode` by `1` (integer).
> 2. Increment `versionName` (e.g., from `1.0.1` to `1.0.2` or `1.1.0`).

### Code Location
Modify the versioning inside `defaultConfig` in [build.gradle.kts](file:///Users/sandesh247/github/tvvc/tvvc/android/app/build.gradle.kts#L15-L22):
```kotlin
    defaultConfig {
        applicationId = "com.sandesh247.tvvc"
        minSdk = 24
        targetSdk = 36
        versionCode = 2 // <-- INCREMENT THIS
        versionName = "1.0.1" // <-- INCREMENT THIS
        ...
    }
```

---

## Build & Deployment Commands Reference

### 1. Build Android Release AAB & APK
Always compile using the local OpenJDK 17 installation:
```bash
cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew clean bundleRelease assembleRelease
```
- **AAB Output**: `android/app/build/outputs/bundle/release/app-release.aab`
- **APK Output**: `android/app/build/outputs/apk/release/app-release.apk`

### 2. Build & Deploy Web App
When changing files in the React frontend:
```bash
# Build
cd web
npm run build

# Deploy to Firebase Hosting
cd ..
npx -y firebase-tools@latest deploy --only hosting
```
