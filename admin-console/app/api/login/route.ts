import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSessionValue, SESSION_COOKIE, SESSION_MAX_AGE_S } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({ password: '' }));
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    return NextResponse.json(
      { message: 'ADMIN_PASSWORD not configured on the server.' },
      { status: 503 },
    );
  }
  if (typeof password !== 'string' || password !== expected) {
    return NextResponse.json({ message: 'Incorrect password.' }, { status: 401 });
  }

  cookies().set(SESSION_COOKIE, await createSessionValue(), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return NextResponse.json({ ok: true });
}
