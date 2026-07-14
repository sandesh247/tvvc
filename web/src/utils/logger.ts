import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

declare const __APP_VERSION__: string;

export async function logErrorToFirebase(error: Error, context?: string): Promise<void> {
  const message = error.message || String(error);
  const stack = error.stack || '';
  const userAgent = navigator.userAgent;
  const appVersion = window.AndroidBridge?.getVersionName?.() || __APP_VERSION__;

  // 1. Call native AndroidBridge if present
  if (window.AndroidBridge?.logError) {
    try {
      window.AndroidBridge.logError(message, stack);
    } catch (e) {
      console.error('Failed to log error to AndroidBridge:', e);
    }
  }

  // 2. Log to Firestore /client_errors collection
  try {
    const errorData = {
      message,
      stack,
      timestamp: serverTimestamp(),
      userAgent,
      appVersion,
      context: context || null
    };
    await addDoc(collection(db, 'client_errors'), errorData);
  } catch (e) {
    console.error('Failed to log error to Firestore:', e);
  }
}
