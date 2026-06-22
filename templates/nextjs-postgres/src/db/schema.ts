import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// Self-hosted Postgres schema (Drizzle owns it; migrations via drizzle-kit).
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("notes_user_idx").on(t.userId)],
);

export type User = typeof users.$inferSelect;
export type Note = typeof notes.$inferSelect;
