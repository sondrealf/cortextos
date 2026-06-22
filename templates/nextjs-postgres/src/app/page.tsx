import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { notes } from "@/db/schema";
import { addNote, deleteNote, signOutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const myNotes = await db
    .select()
    .from(notes)
    .where(eq(notes.userId, session.user.id))
    .orderBy(desc(notes.createdAt));

  return (
    <main className="wrap">
      <h1>__CTX_PROJECT_NAME__</h1>
      <p className="sub">cortextOS new-project · Next.js 15 + Postgres + Auth.js</p>
      <div className="card">
        <div className="row">
          <span className="badge">✓ Authenticated</span>
          <form action={signOutAction}>
            <button className="link" type="submit">Sign out</button>
          </form>
        </div>
        <p>Signed in as <strong>{session.user.email}</strong></p>

        <form action={addNote} className="noteform">
          <input name="body" placeholder="Add a note…" required />
          <button type="submit">Add</button>
        </form>

        <ul className="notes">
          {myNotes.length === 0 && <li className="muted">No notes yet — add one (stored per-user in Postgres).</li>}
          {myNotes.map((n) => (
            <li key={n.id}>
              <span>{n.body}</span>
              <form action={deleteNote}>
                <input type="hidden" name="id" value={n.id} />
                <button className="del" type="submit">×</button>
              </form>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
