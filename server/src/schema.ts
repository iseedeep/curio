import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const CATEGORIES = ["Science","Tech","History","Space","Nature","Art","Body","Society"] as const;
export const METHODS = ["text","photo","voice","link"] as const;
export const STATUSES = ["new","reviewed"] as const;

export const curios = sqliteTable("curios", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  rawInput: text("raw_input").notNull(),
  title: text("title").notNull(),
  category: text("category", { enum: CATEGORIES }).notNull().default("Science"),
  method: text("method", { enum: METHODS }).notNull().default("text"),
  simpleAnswer: text("simple_answer").notNull().default(""),
  whyItMatters: text("why_it_matters").notNull().default(""),
  connectionsJson: text("connections_json").notNull().default("[]"),
  followUp: text("follow_up").notNull().default(""),
  status: text("status", { enum: STATUSES }).notNull().default("new"),
  isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
  needsRetry: integer("needs_retry", { mode: "boolean" }).notNull().default(false),
  imageBlobKey: text("image_blob_key"),
  sourceText: text("source_text").notNull().default(""),
  unreadableNote: text("unreadable_note").notNull().default(""),
  followupsJson: text("followups_json").notNull().default("[]"),
  posX: real("pos_x"),
  posY: real("pos_y"),
  mapLabel: text("map_label").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

export const entryLinks = sqliteTable("entry_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromId: integer("from_id").notNull(),
  toId: integer("to_id").notNull(),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  isPremium: integer("is_premium", { mode: "boolean" }).notNull().default(false),
  checklistJson: text("checklist_json").notNull().default("{}"),
});
