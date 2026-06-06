import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isValidSessionValue, SESSION_COOKIE } from '@/lib/session';
import { getStats, getUsers, getWaitlist, getSubscribedStations } from '@/lib/backend';
import { activeEnv } from '@/lib/env';

export const runtime = 'nodejs';

/**
 * Generic proxy for the read-only data views.
 *   GET /api/admin/data?env=staging&resource=stats|users|waitlist|subscribed[&refresh=1]
 * Session-gated; resolves env + secrets server-side.
 */
export async function GET(req: Request) {
  const session = cookies().get(SESSION_COOKIE)?.value;
  if (!(await isValidSessionValue(session))) {
    return NextResponse.json({ message: 'Not authenticated.' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const resource = searchParams.get('resource');
  const refresh = searchParams.get('refresh') === '1';
  const env = activeEnv();

  try {
    let result;
    switch (resource) {
      case 'stats':
        result = await getStats(env);
        break;
      case 'users':
        result = await getUsers(env, refresh);
        break;
      case 'waitlist':
        result = await getWaitlist(env, refresh);
        break;
      case 'subscribed':
        result = await getSubscribedStations(env);
        break;
      default:
        return NextResponse.json({ message: 'Unknown resource.' }, { status: 400 });
    }
    return NextResponse.json(result.data, { status: result.status });
  } catch (e: any) {
    return NextResponse.json(
      { message: e?.message ?? 'Proxy failed to reach backend.' },
      { status: 502 },
    );
  }
}
