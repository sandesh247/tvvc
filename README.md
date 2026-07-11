# TV Video Calling (TVVC)

A simple video calling app designed for family use on Android TVs. One family member can call another's TV, and the TV wakes up and rings with an incoming call screen.

## Architecture

- **Web App** (`web/`) — React + Vite + TypeScript. The actual UI: PIN authentication, contact list, and WebRTC video calls.
- **Android Wrapper** (`android/`) — A lightweight WebView-based Android/Android TV app. Loads the web app, handles FCM push notifications to wake the TV on incoming calls.
- **Cloud Functions** (`functions/`) — Firebase Cloud Functions:
  - `onCallCreated` — Sends FCM push to the callee when a call document is created
  - `verifyPin` — Verifies the family PIN and returns a Firebase Auth custom token
  - `getTurnCredentials` — Returns TURN server credentials to authenticated clients
- **Firestore** — Stores users, call signaling (WebRTC offer/answer/ICE candidates), and admin config (PIN + TURN credentials).

---

## Complete Step-by-Step Setup Guide

Follow these steps to deploy the application from scratch.

### Prerequisites
- Node.js 22+ installed
- Firebase CLI installed (`npm install -g firebase-tools`)
- A [metered.ca](https://www.metered.ca/tools/openrelay/) account for free TURN server capabilities (provides 20 GB/month free)

---

### Step 1: Firebase Project Creation & Settings

1. Go to the [Firebase Console](https://console.firebase.google.com/) and click **Add project**. Name it (e.g., `tvvc-family`).
2. Once the project is created, click on the **Web icon (`</>`)** on the Project Overview page to register a Web App.
   - Name the app (e.g., `tvvc-web`).
   - Check the box for **Also set up Firebase Hosting for this app**.
   - Complete the registration and copy the `firebaseConfig` object details (you'll need these for the `.env` file).
3. Click the **Android icon** on the Project Overview page to add an Android App.
   - Set the **Android package name** to `com.sandesh247.tvvc`.
   - Complete the wizard and download the `google-services.json` file.
   - Place this `google-services.json` file into the `android/app/` directory of this repository.

---

### Step 2: Enable Firebase Services in the Console

In the left sidebar of your Firebase console, enable these services:

#### 1. Authentication
- Go to **Build** → **Authentication** → **Get Started**.
- Click the **Sign-in method** tab.
- Click **Add new provider**, select **Anonymous**, enable it, and click **Save**. *(This is required for Custom Auth tokens to sign in your TV devices).*

#### 2. Firestore Database
- Go to **Build** → **Firestore Database** → **Create database**.
- Choose your database location and select **Start in production mode**.
- **Important Note on Database ID:** 
  - The codebase is pre-configured to use a Firestore database named `"default"`. If your project is on the **Blaze (pay-as-you-go) plan**, you can create a second database and set its ID to `"default"`.
  - If you are on the **Spark (free) plan**, you are limited to a single database which must be named `(default)`. To run on the free plan, simply change `"default"` to `"(default)"` in these files:
    - [web/src/firebase.ts](file:///Users/sandesh247/github/tvvc/tvvc/web/src/firebase.ts#L16): `export const db = getFirestore(app);` (omit the second parameter)
    - [functions/src/index.ts](file:///Users/sandesh247/github/tvvc/tvvc/functions/src/index.ts#L7): `const db = getFirestore(app);`
    - [functions/src/index.ts](file:///Users/sandesh247/github/tvvc/tvvc/functions/src/index.ts#L14-L17): remove the `database: "default"` line inside `onCallCreated`.
- Once the database is provisioned, you need to create the admin configuration document.

#### 3. Cloud Messaging (FCM)
- Go to **Project Settings** (gear icon next to Project Overview) → **Cloud Messaging** tab.
- Ensure the **Firebase Cloud Messaging API (V1)** is enabled (this handles the TV wakeup push notifications).

---

### Step 3: Populate the Firestore Admin Config Document

You must store your PIN and metered.ca credentials in Firestore. This collection is protected by security rules and can only be read by your backend Cloud Functions:

1. In the **Firestore Database** section, click **Start collection**.
2. Name the collection `admin` and click **Next**.
3. Set the **Document ID** to `config`.
4. Add the following fields:

| Field Name | Type | Value (Example) | Description |
|------------|------|-----------------|-------------|
| `pin` | string | `"123456"` | The 6-digit passcode family members will enter on their TV |
| `meteredAppName` | string | `"tvvc"` | Your metered.ca App Name / Subdomain |
| `meteredApiKey` | string | `"1e632b6ed7839ce717da1d0e3a579a309dd9"` | Your metered.ca REST API Key |
| `turnUsername` | string | `"79ce053002e81a5c2a6fcc04"` | Your metered.ca static username (fallback) |
| `turnCredential` | string | `"Tf9CbysnRFBybz3i"` | Your metered.ca static password (fallback) |

5. Click **Save**. 

> 💡 **Tip:** You can change the PIN or your TURN credentials at any time in the future by editing this document. The TV apps will use the new values instantly—no app updates required!

---

### Step 4: Local Web App Configuration

1. Open a terminal, log in to Firebase, and associate the project:
   ```bash
   firebase login
   firebase use <your-firebase-project-id>
   ```
2. Navigate to the `web` directory and configure the environment variables:
   ```bash
   cd web
   cp .env.example .env
   ```
3. Open the newly created `web/.env` file and fill in the values you copied from Step 1:
   ```env
   VITE_FIREBASE_API_KEY=your_api_key
   VITE_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your_project_id
   VITE_FIREBASE_STORAGE_BUCKET=your_project_id.firebasestorage.app
   VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
   VITE_FIREBASE_APP_ID=your_app_id
   VITE_FIREBASE_MEASUREMENT_ID=your_measurement_id
   ```
4. Install web dependencies:
   ```bash
   npm install
   ```

---

### Step 5: Deploy Cloud Functions, Security Rules, and Web App

Run the following commands from the root directory of the repository to deploy all backend services:

1. **Deploy Cloud Functions:**
   ```bash
   cd functions
   npm install
   npm run build
   firebase deploy --only functions
   ```
2. **Deploy Firestore Security Rules:**
   ```bash
   cd ..
   firebase deploy --only firestore:rules
   ```
3. **Deploy Web Hosting:**
   ```bash
   cd web
   npm run build
   firebase deploy --only hosting
   ```
   *Take note of the Hosting URL returned by this command (e.g. `https://your-project.web.app`).*

---

### Step 6: Build the Android Wrapper App

1. Make sure your `google-services.json` is located at `android/app/google-services.json`.
2. Open `android/local.properties` (this file is excluded from Git tracking) and append the keystore signing configurations:
   ```properties
   # Android TV signing keys
   RELEASE_STORE_PASSWORD=tvvc123
   RELEASE_KEY_ALIAS=tvvc
   RELEASE_KEY_PASSWORD=tvvc123
   ```
3. Edit `android/app/build.gradle.kts` if you wish to change the default release URL. By default, it points to `https://gh-tvvc.web.app`. Replace it with your actual hosted web app URL:
   ```kotlin
   buildConfigField("String", "WEB_APP_URL", "\"https://your-project.web.app\"")
   ```
4. Compile the APK (for direct sideloading) or the App Bundle (for Google Play Console) using Gradle:
   - **For Sideloading (APK):**
     ```bash
     cd android
     ./gradlew assembleRelease
     ```
   - **For Google Play Store (AAB):**
     ```bash
     cd android
     ./gradlew bundleRelease
     ```
5. Find your generated build outputs:
   - **APK (Sideload):** `android/app/build/outputs/apk/release/app-release.apk`
   - **AAB (Google Play):** `android/app/build/outputs/bundle/release/app-release.aab`
6. **Publishing to Google Play (Internal Testing):**
   - Go to your [Google Play Console](https://play.google.com/console/).
   - Select your app, navigate to **Release** > **Internal testing**, and upload the `app-release.aab` bundle.
   - Set up your tester email list and share the tester opt-in link with family members.
   - Go to **Advanced settings** > **Release types** and opt-in to **Android TV** (requires 16:9 TV screenshots and a 320x180 px banner).

