# Session Summary - 2026-07-12

**Commit ID**: `5593b84caa79e6596bfd9f3c8081101fe857ab1c`

## Initial Goal
Implement client-side version compatibility guard to prevent outdated WebApp states from failing on schema/backend updates, and set up a resilient crash recovery boundary.

## Design Choices Considered
1. **Simple version checking in client local storage vs querying a database field**: Storing a static version vs dynamically checking and comparing against a live value in a database.
2. **Standard React Error Boundary vs. a self-healing error boundary**: A traditional error message/boundary page vs a mechanism that counts crashes, attempts auto-reloads, and resets stored state on persistent failures.

## Design Choices Chosen
1. **Checked `minClientVersion` dynamically**: The client listens to the Firestore `/admin/config` configuration document on load to compare local versioning with the minimum required version.
2. **Built crash-counter boundary**: Used `sessionStorage` with `app_crash_count`. If the crash count is less than 3, the page auto-reloads; if it is 3 or more, the error boundary renders a 'Reset & Retry' button that clears all `localStorage` and `sessionStorage` before reloading.
