import { cookies } from 'next/headers';
import KybaseApp from '@/components/KybaseApp';
import LoginForm from '@/components/LoginForm';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/session';

export default async function Page() {
  const secret = process.env.KYBASE_SECRET;
  const sessionCookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const authenticated = !!secret && !!sessionCookie && await verifySessionToken(sessionCookie, secret);

  return authenticated ? <KybaseApp /> : <LoginForm />;
}
