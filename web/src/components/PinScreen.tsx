import { useState, useEffect, useCallback } from 'react';
import { Tv } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { signInWithCustomToken } from 'firebase/auth';
import { auth, functions } from '../firebase';

interface PinScreenProps {
  onAuthenticated: () => void;
}

export default function PinScreen({ onAuthenticated }: PinScreenProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submitPin = useCallback(async (pinValue: string) => {
    setLoading(true);
    setError('');
    try {
      // Generate or retrieve a stable device ID
      let deviceId = localStorage.getItem('tvvc_device_id');
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        localStorage.setItem('tvvc_device_id', deviceId);
      }

      const verifyPinFn = httpsCallable(functions, 'verifyPin');
      const result = await verifyPinFn({ pin: pinValue, deviceId });
      const { token } = result.data as { token: string };

      await signInWithCustomToken(auth, token);
      onAuthenticated();
    } catch (err) {
      console.error('Authentication error:', err);
      setError('Wrong PIN. Please try again.');
      setPin('');
      setLoading(false);
    }
  }, [onAuthenticated]);

  const handleDigit = useCallback((digit: string) => {
    if (loading || pin.length >= 6) return;
    const newPin = pin + digit;
    setPin(newPin);
    if (newPin.length === 6) {
      submitPin(newPin);
    }
  }, [loading, pin, submitPin]);

  const handleDelete = useCallback(() => {
    setPin(prev => prev.slice(0, -1));
    setError('');
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        handleDigit(e.key);
      } else if (e.key === 'Backspace') {
        handleDelete();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleDigit, handleDelete]);

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  return (
    <div className="app-container">
      <div className="header">
        <Tv style={{ marginRight: '16px' }} /> TV Video Calling
      </div>
      <div className="content">
        <div className="registration-container">
          <h2>Enter Family PIN</h2>
          <p style={{ color: 'var(--wa-text-light)', textAlign: 'center', marginBottom: '24px' }}>
            Enter the 6-digit PIN to access your family's video calling.
          </p>

          <div className="pin-dots">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
            ))}
          </div>

          {error && <div className="pin-error">{error}</div>}

          {loading && <div className="pin-loading">Verifying...</div>}

          <div className="pin-keypad">
            {digits.map((digit, i) => {
              if (digit === '') {
                return <div key={i} className="pin-key-spacer" />;
              }
              if (digit === 'del') {
                return (
                  <button
                    key={i}
                    className="pin-key"
                    onClick={handleDelete}
                    disabled={loading || pin.length === 0}
                  >
                    ⌫
                  </button>
                );
              }
              return (
                <button
                  key={i}
                  className="pin-key"
                  onClick={() => handleDigit(digit)}
                  disabled={loading}
                  autoFocus={digit === '1'}
                >
                  {digit}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
