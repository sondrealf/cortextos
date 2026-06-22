"use server";

import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { users, notes } from "@/db/schema";
import { auth, signIn, signOut } from "@/auth";

export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");
  if (!email || password.length < 6) {
    redirect("/login?error=" + encodeURIComponent("Email + 6-char password required"));
  }
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    redirect("/login?error=" + encodeURIComponent("Account already exists — sign in"));
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  await signIn("credentials", { email, password, redirectTo: "/" });
}

export async function signInAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");
  try {
    await signIn("credentials", { email, password, redirectTo: "/" });
  } catch (err) {
    // next-auth throws a redirect on success; only real auth errors fall here
    if ((err as Error)?.message?.includes("NEXT_REDIRECT")) throw err;
    redirect("/login?error=" + encodeURIComponent("Invalid email or password"));
  }
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}

export async function addNote(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const body = String(formData.get("body") ?? "").trim();
  if (body) {
    await db.insert(notes).values({ userId: session!.user.id, body });
    revalidatePath("/");
  }
}

export async function deleteNote(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const id = String(formData.get("id") ?? "");
  if (id) {
    // scoped to the owner — authorization, not just authentication
    await db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, session!.user.id)));
    revalidatePath("/");
  }
}
