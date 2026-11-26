import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { db } from "./db";

function upsertUser(email: string, name?: string | null, image?: string | null): number {
  const row = db()
    .prepare(
      `INSERT INTO users (email, name, image) VALUES (?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET name = excluded.name, image = excluded.image
       RETURNING id`,
    )
    .get(email, name ?? null, image ?? null) as { id: number };
  return row.id;
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.email) token.uid = upsertUser(user.email, user.name, user.image);
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.uid === "number") session.user.id = token.uid;
      return session;
    },
  },
};

export type SessionUser = { id: number; name?: string | null; email?: string | null; image?: string | null };

export async function currentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const u = session?.user;
  return u && typeof u.id === "number" ? (u as SessionUser) : null;
}
