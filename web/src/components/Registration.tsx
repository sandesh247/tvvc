import { useState, useEffect, useRef } from 'react';
import { Tv } from 'lucide-react';

interface RegistrationProps {
  onRegister: (name: string) => void;
}

export default function Registration({ onRegister }: RegistrationProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onRegister(name.trim());
    }
  };

  return (
    <div className="app-container">
      <div className="header">
        <Tv style={{ marginRight: '16px' }} /> Welcome to TV Caller
      </div>
      <div className="content">
        <form onSubmit={handleSubmit} className="registration-container">
          <h2>Enter a Display Name</h2>
          <p style={{ color: 'var(--wa-text-light)', textAlign: 'center', marginBottom: '24px' }}>
            This is how others will see you in their contact list.
          </p>
          <input
            ref={inputRef}
            type="text"
            className="registration-input"
            placeholder="e.g. Living Room TV"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button type="submit" className="btn" disabled={!name.trim()}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
