'use client';

import { useRouter } from 'next/navigation';

export default function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    await fetch('/api/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }
  return (
    <button className="btn-ghost" onClick={signOut}>
      Sign out
    </button>
  );
}
