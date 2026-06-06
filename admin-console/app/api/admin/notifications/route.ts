import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isValidSessionValue, SESSION_COOKIE } from '@/lib/session';
import { sendNotification } from '@/lib/backend';
import { activeEnv } from '@/lib/env';
import type { SendRequest } from '@/lib/payload';

export const runtime = 'nodejs';

/**
 * Proxy: browser → here (session-gated) → backend (admin-key + CF token).
 * The browser names a target env; we resolve URL + secrets server-side.
 */
export async function POST(req: Request) {
  const session = cookies().get(SESSION_COOKIE)?.value;
  if (!(await isValidSessionValue(session))) {
    return NextResponse.json({ message: 'Not authenticated.' }, { status: 401 });
  }

  let body: SendRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body?.audience?.type) {
    return NextResponse.json({ message: "Missing 'audience'." }, { status: 400 });
  }
  if (!body?.payload) {
    return NextResponse.json({ message: "Missing 'payload'." }, { status: 400 });
  }

  try {
    // Target env is fixed by THIS deployment, never the client.
    const result = await sendNotification(activeEnv(), {
      audience: body.audience,
      payload: body.payload,
    });
    return NextResponse.json(result.data, { status: result.status });
  } catch (e: any) {
    return NextResponse.json(
      { message: e?.message ?? 'Proxy failed to reach backend.' },
      { status: 502 },
    );
  }
}
