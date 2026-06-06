import Nav from '@/components/Nav';
import Dashboard from '@/components/Dashboard';
import { activeEnv } from '@/lib/env';

export default function HomePage() {
  return (
    <>
      <Nav active="/" />
      <main className="page">
        <div className="page-head">
          <h1>Dashboard</h1>
          <p>At-a-glance view of Stationly — users, waitlist, watched stations and recent pushes. All served from local cache.</p>
        </div>
        <Dashboard env={activeEnv()} />
      </main>
    </>
  );
}
