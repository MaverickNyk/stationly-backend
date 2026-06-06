'use client';

import Link from 'next/link';
import { useState } from 'react';
import SignOutButton from './SignOutButton';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/audiences', label: 'Audiences' },
  { href: '/history', label: 'History' },
  { href: '/users', label: 'Users' },
  { href: '/waitlist', label: 'Waitlist' },
  { href: '/stations', label: 'Stations' },
];

export default function Nav({ active }: { active: string }) {
  const [open, setOpen] = useState(false);
  return (
    <nav className="nav">
      <div className="brand">
        <span className="logo">STATIONLY</span>
        <span className="tag">Admin</span>
      </div>

      <button className="nav-toggle" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
        ☰
      </button>

      <div className={`right${open ? ' open' : ''}`}>
        <div className="nav-links">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={l.href === active ? 'active' : ''}
              onClick={() => setOpen(false)}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <SignOutButton />
      </div>
    </nav>
  );
}
