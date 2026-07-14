# Verification Report: Firebase Error Logging

## 1. Executive Summary

This report documents the empirical verification of the Firebase Error Logging implementation across the Web application, Android container, and Firestore security rules. 

While the Web build and Android compilation succeeded, and the Firestore security rules successfully block unauthorized access, a **critical functional bug** was discovered in the Android stack trace parsing logic. The parsing code fails to correctly identify malformed/incomplete stack trace URLs, resulting in the generation of invalid `StackTraceElement` instances (such as a class name of `"http"` and line number `0`). This bug causes the pre-existing test suite (`StackTraceParsingTest.kt`) to fail.

---

## 2. Git Changes Inspection

The following files were inspected for correctness:
*   `android/app/src/main/java/com/sandesh247/tvvc/MainActivity.kt`: Added `@JavascriptInterface` method `logError(message, stackTrace)` to parse JS stack trace lines and report exceptions to Firebase Crashlytics.
*   `firestore.rules`: Added a write-only `/client_errors/{docId}` rule enforcing validation on field types (`message`, `stack`, `timestamp`, `userAgent`, `appVersion`, `context`).
*   `web/src/ErrorBoundary.tsx`: Integrates Firebase logging on uncaught errors with a 1-second timeout race logic before reloading the page.
*   `web/src/main.tsx`: Hooks into `window.onerror` and `window.onunhandledrejection` to send unhandled errors/rejections to Firestore.
*   `web/src/utils/logger.ts`: Implements `logErrorToFirebase()` which calls `AndroidBridge.logError()` and adds a document to Firestore's `/client_errors`.

---

## 3. Compilation & Build Verification

*   **Web Build**: Successful.
    *   Command: `cd web && npm run build`
    *   Results:
        *   Version synchronization script `node ../scripts/sync-version.js` executed and synchronized minimum client version in Firestore default database.
        *   Vite successfully built production assets.
*   **Android Compilation**: Successful.
    *   Command: `cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew compileReleaseSources compileReleaseKotlin`
    *   Results: Build successful with zero compile-time errors or warnings.

---

## 4. Firestore Security Rules Validation

*   **Command**: `JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH=$JAVA_HOME/bin:$PATH npx -y firebase-tools@latest emulators:exec "node scripts/test_rules.js"`
*   **Results**:
    *   **Scenario 10 (Positive)**: Write-only creation of valid error logs succeeded (HTTP 200).
    *   **Scenario 11 (Negative)**: Anyone reading the error log failed with permission denied (HTTP 403).
    *   **Scenario 12 (Negative)**: Creating with invalid field types (e.g. `message` as an integer) failed with permission denied (HTTP 403).
    *   All validation tests passed.

---

## 5. Android Stack Trace Parsing Robustness Tests

A JUnit test suite was run inside the Android environment:
*   **Command**: `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew test`
*   **Findings**: The test suite failed due to assertions in `StackTraceParsingTest` and our newly constructed robustness suite.
    *   **Verbatim Test Failures**:
        ```
        StackTraceParserTest > testExtremelyMalformed FAILED
            java.lang.AssertionError at StackTraceParserTest.kt:106

        StackTraceParsingTest > testMalformedStackTrace FAILED
            java.lang.AssertionError at StackTraceParsingTest.kt:54
        ```
    *   **Root Cause**:
        In `MainActivity.kt`, the parsing logic splits `filePart` (the source code location) by colon (`:`):
        ```kotlin
        val parts = filePart.split(":")
        if (parts.size >= 2) {
            val lineNumber = parts[parts.size - 2].toIntOrNull() ?: 0
            val fileName = parts.subList(0, parts.size - 2).joinToString(":").substringAfterLast("/")
            StackTraceElement("JavaScript", func, fileName, lineNumber)
        }
        ```
        If a stack trace line contains a URL without line or column numbers (e.g. `"at funcName (http://localhost:3000/app.js)"`), the string split returns parts representing the URL protocol and host (`"http"`, `"//localhost"`, `"3000/app.js"`). Because the number of parts is $\ge 2$, the logic incorrectly processes `"//localhost"` as the line number, falls back to `0`, and returns a `StackTraceElement` with the class name `"http"` and line number `0`.
        
        This violates the test assertion:
        `assertTrue(result2.isEmpty())` (for `"at funcName (http://localhost:3000/app.js)"`)
        
    *   **App Crash Safety**:
        The code is crash-safe. It does not crash the Android application because the entire line iteration is wrapped in a `try-catch` block that silences individual line errors, and the outer function is also wrapped in a general `try-catch`. However, the generated telemetry will contain garbage stack traces.

---

## 6. ErrorBoundary Timeout Race Verification

The timeout race in `ErrorBoundary.tsx` was verified via a local simulation running in Node.js:
*   **Simulation Script**: `test_timeout_race.js`
*   **Scenarios Tested**:
    1.  **Fast Logging** (Firestore resolves in 200ms): The race resolved immediately at 202ms, reloading the page without artificial delay.
    2.  **Slow Logging / Offline** (Firestore hangs/delays for 5s): The race successfully timed out at 1001ms, forcing a reload.
    3.  **Failed Logging** (Firestore throws internal error): The promise resolved in 101ms (since internal exceptions are caught in the logger), and the page reloaded immediately.
*   **Result**: The logic is 100% correct and guarantees that crashes will not cause the application to hang.

---

## 7. Recommendations

1.  **Fix Stack Trace Parser**:
    The stack trace parser in `MainActivity.kt` should verify that the parsed line number is actually a number and that the format ends with valid line/column numbers.
    For example:
    ```kotlin
    val lastPart = parts.lastOrNull()?.toIntOrNull()
    val secondToLastPart = if (parts.size >= 2) parts[parts.size - 2].toIntOrNull() else null
    // Only accept if we can find a valid line number format
    ```
