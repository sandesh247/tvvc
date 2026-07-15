# AI Agent instructions (gemini.md)

This file contains instructions for any AI assistant working on the **TVVC** project.

## Android Build Versioning Rule

> [!IMPORTANT]
> **Every time** the user asks to build the Android app (`.aab` or `.apk`) for publication or updates, you **MUST** increment the versioning fields before running the build:
>
> 1. Increment `versionCode` by `1` (integer) in [build.gradle.kts](file:///Users/sandesh247/github/tvvc/tvvc/android/app/build.gradle.kts).
> 2. Increment the `version` field in [package.json](file:///Users/sandesh247/github/tvvc/tvvc/web/package.json) (which `build.gradle.kts` parses automatically for the `versionName`).

### Code Locations
1. **versionCode**: Modify `versionCode` inside `defaultConfig` in [build.gradle.kts](file:///Users/sandesh247/github/tvvc/tvvc/android/app/build.gradle.kts#L20-L31):
```kotlin
    defaultConfig {
        applicationId = "com.sandesh247.tvvc"
        minSdk = 24
        targetSdk = 36
        versionCode = 34 // <-- INCREMENT THIS
        versionName = packageVersionName // <-- Read automatically from package.json
        ...
    }
```
2. **version**: Modify `version` inside [package.json](file:///Users/sandesh247/github/tvvc/tvvc/web/package.json#L4):
```json
  "version": "1.1.23", // <-- INCREMENT THIS
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

---

## Firestore Database & Admin Tasks Reference

### 1. Database ID
The Firestore database for this project is named `default`, not the standard `(default)`. When making API requests or using the admin SDK, always specify `"default"` as the database ID.

### 2. Authentication (Access Token)
To execute administrative REST API calls without needing a service account key file, read the active Firebase CLI OAuth access token from:
`~/.config/configstore/firebase-tools.json` (specifically under `tokens.access_token`).

### 3. List Registered Devices (Users)
```bash
curl -H "Authorization: Bearer <ACCESS_TOKEN>" \
  https://firestore.googleapis.com/v1/projects/gh-tvvc/databases/default/documents/users
```

### 4. Delete a Device
```bash
curl -X DELETE -H "Authorization: Bearer <ACCESS_TOKEN>" \
  https://firestore.googleapis.com/v1/projects/gh-tvvc/databases/default/documents/users/<DEVICE_ID>
```

---

## Version Compatibility Guard & Self-Healing Crash Reset Reference

### 1. Version Guard Logic
The app version compatibility guard automatically enforces updates.
- **Web Package Version**: Handled in `web/package.json` via the `version` field.
- **Backend Enforced Version**: Stored in Firestore database `'default'` at `/admin/config` as the `minClientVersion` field.
- **Automatic Deployment/Sync**:
  When you build the React frontend using `npm run build` inside `web/`, the script `node ../scripts/sync-version.js` executes first. It reads the explicit `minClientVersion` field (falling back to `version` if not found) from `web/package.json` and calls the Firestore REST API using the local active Firebase CLI access token (from `~/.config/configstore/firebase-tools.json`) to update the minimum required version in the database.
- **Rules on Client Version Update**:
  If you increment the `minClientVersion` in `web/package.json`, the next production build will automatically set this version as the minimum required version for all clients, forcing updates for anyone running a version lower than this value. Incrementing `version` alone does not force updates.
  **Guidance**: When making changes, evaluate if they are backwards incompatible with older clients (e.g., changing Firestore schemas, requiring new API fields, or deprecating cloud functions). If there is a potential backwards incompatible change, you must recommend incrementing the `minClientVersion`. If the changes are compatible (such as purely client-side UI/UX fixes), you must explicitly state in your response that incrementing `minClientVersion` is not necessary.

### 2. Error Boundary & Crash Handling
- **Crash Counter**: `sessionStorage.getItem('app_crash_count')`.
- **Automatic Recovery**: If the application crashes before completing a 5-second successful run:
  - If crash count < 3: increment the count and reload the page automatically.
  - If crash count >= 3: stop reloading, render the error boundary page with a **"Reset & Retry"** button.
- **Manual Reset**: The **"Reset & Retry"** button clears `localStorage` and `sessionStorage` completely, then reloads the page.
- **Success Heartbeat**: After mounting and running successfully for 5 seconds, the application automatically clears the `app_crash_count` from `sessionStorage`.

