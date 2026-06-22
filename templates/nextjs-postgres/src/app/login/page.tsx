import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { signUp, signInAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="wrap">
      <h1>__CTX_PROJECT_NAME__</h1>
      <p className="sub">cortextOS new-project · Next.js 15 + Postgres + Auth.js</p>
      <div className="card">
        <h2>Sign in / Create account</h2>
        {error && <p className="err">{error}</p>}
        <form action={signInAction} className="col">
          <input name="email" type="email" placeholder="you@example.com" required autoComplete="email" />
          <input name="password" type="password" placeholder="password (min 6)" required />
          <button type="submit">Sign in</button>
        </form>
        <div className="divider">or</div>
        <form action={signUp} className="col">
          <input name="email" type="email" placeholder="new@example.com" required autoComplete="email" />
          <input name="password" type="password" placeholder="choose a password (min 6)" required />
          <button type="submit" className="secondary">Create account</button>
        </form>
      </div>
    </main>
  );
}
