import { useState, useEffect } from 'react';
import { User as UserIcon, Phone, Tv, Edit2, Check, X } from 'lucide-react';
import type { User } from '../App';

interface ContactListProps {
  currentUser: User;
  users: User[];
  onCallUser: (userId: string) => void;
  onChangeName: (newName: string) => void;
}

export default function ContactList({ currentUser, users, onCallUser, onChangeName }: ContactListProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(currentUser.name);

  // Force re-renders periodically to refresh relative online/offline states
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const getStatus = (user: User): 'online' | 'offline' => {
    if (!user.lastSeen) return 'offline';
    const lastSeenMs = user.lastSeen.toDate ? user.lastSeen.toDate().getTime() : new Date(user.lastSeen).getTime();
    return (Date.now() - lastSeenMs) < 90000 ? 'online' : 'offline';
  };

  const handleSaveName = () => {
    if (editName.trim() && editName !== currentUser.name) {
      onChangeName(editName.trim());
    }
    setIsEditing(false);
  };

  return (
    <div className="app-container">
      <div className="header" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Tv style={{ marginRight: '16px' }} /> Contacts
        </div>
        <div style={{ fontSize: '16px', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '8px' }}>
          Signed in as: 
          {isEditing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input 
                type="text" 
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid var(--wa-border)', color: 'white', padding: '2px 6px', borderRadius: '4px', width: '120px' }}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
              />
              <button onClick={handleSaveName} style={{ background: 'none', border: 'none', color: 'var(--wa-green)', cursor: 'pointer', padding: '2px' }}>
                <Check size={16} />
              </button>
              <button onClick={() => { setIsEditing(false); setEditName(currentUser.name); }} style={{ background: 'none', border: 'none', color: 'var(--wa-red)', cursor: 'pointer', padding: '2px' }}>
                <X size={16} />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <strong>{currentUser.name}</strong>
              <button onClick={() => setIsEditing(true)} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', padding: '2px', display: 'flex' }}>
                <Edit2 size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
      
      <div className="content" style={{ padding: 0 }}>
        <div className="contact-list">
          {users.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--wa-text-light)' }}>
              No other TVs are online right now.
            </div>
          ) : (
            users.map((user) => (
              <button 
                key={user.id} 
                className="contact-item"
                onClick={() => onCallUser(user.id)}
              >
                <div className="contact-avatar">
                  <UserIcon size={32} />
                </div>
                <div className="contact-info">
                  <div className="contact-name">{user.name}</div>
                  <div className={`contact-status ${getStatus(user)}`}>
                    {getStatus(user)}
                  </div>
                </div>
                <div className="call-icon">
                  <Phone size={28} />
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
