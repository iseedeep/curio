import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const CategoryEnum = z.enum(["Science","Tech","History","Space","Nature","Art","Body","Society"]);
const MethodEnum = z.enum(["text","photo","voice","link"]);

const followUpPair = z.object({ q: z.string(), a: z.string() });

const curioOut = z.object({
  id: z.number(),
  rawInput: z.string(),
  title: z.string(),
  category: CategoryEnum,
  method: MethodEnum,
  simpleAnswer: z.string(),
  whyItMatters: z.string(),
  connections: z.array(z.string()),
  followUp: z.string(),
  sourceText: z.string(),
  unreadableNote: z.string(),
  followups: z.array(followUpPair),
  hasPhoto: z.boolean(),
  photoUrl: z.string(),
  posX: z.number().nullable(),
  posY: z.number().nullable(),
  mapLabel: z.string(),
  status: z.enum(["new","reviewed"]),
  isFavorite: z.boolean(),
  needsRetry: z.boolean(),
  createdAt: z.string(),
});

type CurioRow = typeof schema.curios.$inferSelect;

function parseStrings(json: string): string[] {
  try { const p = JSON.parse(json); if (Array.isArray(p)) return p.filter((x: unknown) => typeof x === "string"); } catch {}
  return [];
}
function parseFollowups(json: string): { q: string; a: string }[] {
  try {
    const p = JSON.parse(json);
    if (Array.isArray(p)) return p.filter((x: unknown): x is { q: string; a: string } =>
      !!x && typeof x === "object" && typeof (x as { q: unknown }).q === "string" && typeof (x as { a: unknown }).a === "string");
  } catch {}
  return [];
}

async function toOut(ctx: Ctx, r: CurioRow): Promise<z.infer<typeof curioOut>> {
  let photoUrl = "";
  if (r.imageBlobKey) {
    try { photoUrl = await ctx.blobs.getUrl(r.imageBlobKey); } catch { photoUrl = ""; }
  }
  return {
    id: r.id, rawInput: r.rawInput, title: r.title, category: r.category, method: r.method,
    simpleAnswer: r.simpleAnswer, whyItMatters: r.whyItMatters, connections: parseStrings(r.connectionsJson),
    followUp: r.followUp, sourceText: r.sourceText, unreadableNote: r.unreadableNote,
    followups: parseFollowups(r.followupsJson),
    hasPhoto: !!r.imageBlobKey, photoUrl,
    posX: r.posX, posY: r.posY, mapLabel: r.mapLabel,
    status: r.status, isFavorite: r.isFavorite, needsRetry: r.needsRetry,
    createdAt: r.createdAt.toISOString(),
  };
}

async function ensureSettings(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.settings);
  if (rows.length === 0) {
    await db.insert(schema.settings).values({ id: 1, isPremium: false, checklistJson: "{}" });
    return { isPremium: false, checklist: {} as Record<string, boolean> };
  }
  const row = rows[0]!;
  let checklist: Record<string, boolean> = {};
  try { const p = JSON.parse(row.checklistJson); if (p && typeof p === "object") checklist = p; } catch {}
  return { isPremium: row.isPremium, checklist };
}

const explainSchema = z.object({
  title: z.string().describe("Short, recognizable title for this entry, 3-7 words, using the words the user is most likely to remember and search for later"),
  category: CategoryEnum.describe("Best fitting category"),
  simpleAnswer: z.string().describe("The clear explanation, leading with the direct answer to the exact question asked. 2-5 short sentences, plain language, no unexplained jargon. Written to be re-read weeks later and still make sense on its own."),
  whyItMatters: z.string().describe("One sentence: why this is interesting or useful"),
  connections: z.array(z.string()).describe("0-3 short connections to the user's existing entries listed, or to everyday things if none exist. Each under 12 words."),
  followUp: z.string().describe("One intriguing follow-up question that would deepen understanding of this same idea"),
  sourceText: z.string().describe("ONLY when a photo of text was provided: the exact words legible in the photo, transcribed verbatim, limited to the passage relevant to the question. Never invent or complete wording that is not clearly legible. Empty string when there is no photo of text."),
  unreadableNote: z.string().describe("ONLY when part of a photographed passage is blurry, cut off, or illegible: name exactly which part needs a clearer photo, e.g. 'The last two lines are cut off at the bottom'. Empty string when everything relevant is legible or there is no photo."),
});

type Explained = z.infer<typeof explainSchema>;

async function runExplain(ctx: Ctx, args: { rawInput: string; method: string; preferredCategory: string; image?: { dataBase64: string; mimeType: string } }): Promise<Explained | null> {
  const db = ctx.db<typeof schema>();
  const existing = await db.select().from(schema.curios).orderBy(desc(schema.curios.id)).limit(50);
  const existingTitles = existing.slice(0, 20).map(r => `${r.title} (${r.category})`).join("; ") || "none yet";
  const prompt = `A user captured something they're curious about and asked a question in their own words.\n\nCapture method: ${args.method}\nTheir question, exactly as asked: "${args.rawInput}"\n${args.preferredCategory !== "auto" ? `They suggested category: ${args.preferredCategory} — use it unless it clearly doesn't fit.` : ""}\nTheir existing collection: ${existingTitles}\n\nAnswer the question they actually asked — not a nearby question. Lead with the direct answer. If a photo is attached, look at it with them: if it shows text, transcribe the relevant passage exactly as written into sourceText (only what is clearly legible — never invent quotations), and keep your explanation clearly separate from the author's words. If part of the passage is unreadable, say exactly which part in unreadableNote. Never invent sources, citations, or quotations. Be accurate — if unsure, say what is known plainly.`;
  const images = args.image && (args.image.mimeType === "image/jpeg" || args.image.mimeType === "image/png")
    ? [{ dataBase64: args.image.dataBase64, mimeType: args.image.mimeType as "image/jpeg" | "image/png", caption: "Photo the user captured" }]
    : undefined;
  return await ctx.inference.complete(prompt, {
    system: "You are Curio, a warm, clear explainer building a person's own encyclopedia. You turn a moment of curiosity into one simple, accurate, jargon-free explanation they will want to re-read weeks later. You never invent quotations or sources.",
    schema: explainSchema,
    ...(images ? { images } : {}),
  });
}

const draftOut = z.object({
  title: z.string(), category: CategoryEnum, simpleAnswer: z.string(), whyItMatters: z.string(),
  connections: z.array(z.string()), followUp: z.string(), sourceText: z.string(), unreadableNote: z.string(),
});

const linkOut = z.object({
  id: z.number(), fromId: z.number(), toId: z.number(), note: z.string(), createdAt: z.string(),
});

const getStateResponse = z.object({
  curios: z.array(curioOut),
  links: z.array(linkOut),
  isPremium: z.boolean(),
  checklist: z.record(z.string(), z.boolean()),
  todayCount: z.number(),
  totalCount: z.number(),
  reviewedCount: z.number(),
});

const imageArg = z.object({ dataBase64: z.string(), mimeType: z.string() }).optional();

export const Actions = {
  getState: defineAction({
    description: "Returns all saved encyclopedia entries, premium status, launch checklist, and usage counts.",
    request: z.object({}),
    response: getStateResponse,
    handler: async (ctx): Promise<z.infer<typeof getStateResponse>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.curios).orderBy(desc(schema.curios.id)).limit(300);
      const s = await ensureSettings(ctx);
      const now = new Date();
      const todayCount = rows.filter(r => {
        const d = r.createdAt;
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      }).length;
      const curios = await Promise.all(rows.map(r => toOut(ctx, r)));
      const linkRows = await db.select().from(schema.entryLinks).orderBy(schema.entryLinks.id);
      return {
        curios,
        links: linkRows.map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, note: l.note, createdAt: l.createdAt.toISOString() })),
        isPremium: s.isPremium,
        checklist: s.checklist,
        todayCount,
        totalCount: rows.length,
        reviewedCount: rows.filter(r => r.status === "reviewed").length,
      };
    },
  }),

  explainCapture: defineAction({
    description: "Explains a capture (question plus optional photo) and returns a draft entry. Nothing is saved until saveEntry is called.",
    request: z.object({
      rawInput: z.string().trim().min(1).max(2000),
      method: MethodEnum.default("text"),
      preferredCategory: z.union([CategoryEnum, z.literal("auto")]).default("auto"),
      image: imageArg,
    }),
    response: z.object({ draft: draftOut }),
    handler: async (ctx, args): Promise<{ draft: z.infer<typeof draftOut> }> => {
      /* A bare link can't be opened or read here — never let the model guess
         at its contents. Ask for the words themselves instead. */
      if (/^https?:\/\/\S+$/i.test(args.rawInput.trim())) {
        throw new Error("Curio can't open links yet — paste the passage that caught your eye, or photograph it, and ask your question about it.");
      }
      const explained = await runExplain(ctx, args);
      if (!explained) throw new Error("The explanation didn't come through. Your draft is kept — try again in a moment.");
      return { draft: explained };
    },
  }),

  saveEntry: defineAction({
    description: "Saves a reviewed draft as an encyclopedia entry, storing the source photo with it. One deliberate save per idea.",
    request: z.object({
      rawInput: z.string().trim().min(1).max(2000),
      title: z.string().trim().min(1).max(120),
      category: CategoryEnum,
      method: MethodEnum.default("text"),
      simpleAnswer: z.string().min(1).max(8000),
      whyItMatters: z.string().max(1000).default(""),
      connections: z.array(z.string().max(200)).max(6).default([]),
      followUp: z.string().max(500).default(""),
      sourceText: z.string().max(8000).default(""),
      unreadableNote: z.string().max(500).default(""),
      followups: z.array(followUpPair).max(20).default([]),
      image: imageArg,
    }),
    response: z.object({ curio: curioOut }),
    handler: async (ctx, args): Promise<{ curio: z.infer<typeof curioOut> }> => {
      const db = ctx.db<typeof schema>();
      let imageBlobKey: string | null = null;
      if (args.image && (args.image.mimeType === "image/jpeg" || args.image.mimeType === "image/png")) {
        const key = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${args.image.mimeType === "image/png" ? "png" : "jpg"}`;
        const bytes = Uint8Array.from(Buffer.from(args.image.dataBase64, "base64"));
        await ctx.blobs.put(key, bytes, { contentType: args.image.mimeType });
        imageBlobKey = key;
      }
      const inserted = await db.insert(schema.curios).values({
        rawInput: args.rawInput,
        title: args.title,
        category: args.category,
        method: args.method,
        simpleAnswer: args.simpleAnswer,
        whyItMatters: args.whyItMatters,
        connectionsJson: JSON.stringify(args.connections),
        followUp: args.followUp,
        sourceText: args.sourceText,
        unreadableNote: args.unreadableNote,
        followupsJson: JSON.stringify(args.followups),
        imageBlobKey,
        status: "reviewed" as const,
        isFavorite: false,
        needsRetry: false,
      }).returning();
      const row = inserted[0];
      if (!row) throw new Error("Failed to save entry");
      ctx.invalidateQueries();
      return { curio: await toOut(ctx, row) };
    },
  }),

  askFollowUp: defineAction({
    description: "Answers a follow-up question in the context of one entry. When entryId is given, the Q&A is appended to that saved entry instead of creating a new one.",
    request: z.object({
      entryId: z.number().int().positive().optional(),
      question: z.string().trim().min(1).max(1000),
      title: z.string().max(120).default(""),
      originalQuestion: z.string().max(2000).default(""),
      simpleAnswer: z.string().max(8000).default(""),
      sourceText: z.string().max(8000).default(""),
    }),
    response: z.object({ answer: z.string(), followups: z.array(followUpPair) }),
    handler: async (ctx, args): Promise<{ answer: string; followups: { q: string; a: string }[] }> => {
      const db = ctx.db<typeof schema>();
      let entry: CurioRow | undefined;
      if (args.entryId) {
        const rows = await db.select().from(schema.curios).where(eq(schema.curios.id, args.entryId));
        entry = rows[0];
        if (!entry) throw new Error("That entry no longer exists.");
      }
      const title = entry?.title ?? args.title;
      const originalQuestion = entry?.rawInput ?? args.originalQuestion;
      const simpleAnswer = entry?.simpleAnswer ?? args.simpleAnswer;
      const sourceText = entry?.sourceText ?? args.sourceText;
      const prior = entry ? parseFollowups(entry.followupsJson) : [];
      const priorText = prior.length ? `\nEarlier follow-ups on this entry:\n${prior.map(p => `Q: ${p.q}\nA: ${p.a}`).join("\n")}` : "";
      const answer = await ctx.inference.complete(
        `An entry in the user's personal encyclopedia.\n\nTitle: ${title}\nTheir original question: "${originalQuestion}"\nThe explanation they saved: ${simpleAnswer}${sourceText ? `\nThe original passage, in the author's words: "${sourceText}"` : ""}${priorText}\n\nNow they ask a follow-up about this same idea: "${args.question}"\n\nAnswer just this follow-up, plainly and accurately, in 1-4 short sentences. Build on the saved explanation; don't repeat it wholesale. Never invent quotations or sources.`,
        {
          system: "You are Curio, a warm, clear explainer. Follow-ups deepen the same entry — one idea, one entry.",
          schema: z.string(),
        },
      );
      const next = [...prior, { q: args.question, a: answer }];
      if (entry) {
        await db.update(schema.curios).set({ followupsJson: JSON.stringify(next), updatedAt: new Date() }).where(eq(schema.curios.id, entry.id));
        ctx.invalidateQueries();
        return { answer, followups: next };
      }
      return { answer, followups: next };
    },
  }),

  createCurio: defineAction({
    description: "Legacy one-step capture: explains and saves immediately. New clients use explainCapture + saveEntry.",
    request: z.object({
      rawInput: z.string().trim().min(1).max(2000),
      method: MethodEnum.default("text"),
      preferredCategory: z.union([CategoryEnum, z.literal("auto")]).default("auto"),
      image: imageArg,
    }),
    response: z.object({ curio: curioOut, limitReached: z.boolean() }),
    handler: async (ctx, args): Promise<{ curio: z.infer<typeof curioOut>; limitReached: boolean }> => {
      const db = ctx.db<typeof schema>();
      let explained: Explained | null = null;
      let needsRetry = false;
      try { explained = await runExplain(ctx, args); } catch { needsRetry = true; }
      const fallbackTitle = args.rawInput.length > 60 ? args.rawInput.slice(0, 57) + "…" : args.rawInput;
      const inserted = await db.insert(schema.curios).values({
        rawInput: args.rawInput,
        title: explained?.title || fallbackTitle,
        category: (explained?.category || (args.preferredCategory !== "auto" ? args.preferredCategory : "Science")) as typeof schema.CATEGORIES[number],
        method: args.method,
        simpleAnswer: explained?.simpleAnswer || "We couldn't explain this one just yet — it's saved safely. Delete it and capture it again to retry.",
        whyItMatters: explained?.whyItMatters || "",
        connectionsJson: JSON.stringify(explained?.connections || []),
        followUp: explained?.followUp || "",
        sourceText: explained?.sourceText || "",
        unreadableNote: explained?.unreadableNote || "",
        followupsJson: "[]",
        status: "new" as const,
        isFavorite: false,
        needsRetry,
      }).returning();
      const row = inserted[0];
      if (!row) throw new Error("Failed to save curiosity");
      ctx.invalidateQueries();
      return { curio: await toOut(ctx, row), limitReached: false };
    },
  }),

  updateCurio: defineAction({
    description: "Updates an entry's status or favorite flag.",
    request: z.object({
      id: z.number().int().positive(),
      status: z.enum(["new","reviewed"]).optional(),
      isFavorite: z.boolean().optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      const patch: Partial<{ status: "new" | "reviewed"; isFavorite: boolean }> = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.isFavorite !== undefined) patch.isFavorite = args.isFavorite;
      if (Object.keys(patch).length > 0) {
        await db.update(schema.curios).set(patch).where(eq(schema.curios.id, args.id));
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  updateEntry: defineAction({
    description: "Edits a saved entry's title, category, or the short words shown on its map note.",
    request: z.object({
      id: z.number().int().positive(),
      title: z.string().trim().min(1).max(120).optional(),
      category: CategoryEnum.optional(),
      mapLabel: z.string().trim().max(80).optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      const patch: Partial<{ title: string; category: typeof schema.CATEGORIES[number]; mapLabel: string; updatedAt: Date }> = { updatedAt: new Date() };
      if (args.title !== undefined) patch.title = args.title;
      if (args.category !== undefined) patch.category = args.category;
      if (args.mapLabel !== undefined) patch.mapLabel = args.mapLabel;
      await db.update(schema.curios).set(patch).where(eq(schema.curios.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setMapPosition: defineAction({
    description: "Saves an entry's position on the Library map so the layout stays stable across launches.",
    request: z.object({
      id: z.number().int().positive(),
      x: z.number().min(-100000).max(100000),
      y: z.number().min(-100000).max(100000),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.update(schema.curios).set({ posX: args.x, posY: args.y }).where(eq(schema.curios.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  createLink: defineAction({
    description: "Creates a user-chosen connection between two entries on the Library map, with an optional note in the user's own words.",
    request: z.object({
      fromId: z.number().int().positive(),
      toId: z.number().int().positive(),
      note: z.string().trim().max(500).default(""),
    }),
    response: z.object({ link: linkOut }),
    handler: async (ctx, args): Promise<{ link: z.infer<typeof linkOut> }> => {
      if (args.fromId === args.toId) throw new Error("An entry can't be linked to itself.");
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.entryLinks);
      const dup = existing.find((l) => (l.fromId === args.fromId && l.toId === args.toId) || (l.fromId === args.toId && l.toId === args.fromId));
      if (dup) return { link: { id: dup.id, fromId: dup.fromId, toId: dup.toId, note: dup.note, createdAt: dup.createdAt.toISOString() } };
      const inserted = await db.insert(schema.entryLinks).values({ fromId: args.fromId, toId: args.toId, note: args.note }).returning();
      const row = inserted[0];
      if (!row) throw new Error("Failed to create the link");
      ctx.invalidateQueries();
      return { link: { id: row.id, fromId: row.fromId, toId: row.toId, note: row.note, createdAt: row.createdAt.toISOString() } };
    },
  }),

  updateLink: defineAction({
    description: "Edits the note on a connection between two entries.",
    request: z.object({
      id: z.number().int().positive(),
      note: z.string().trim().max(500),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.update(schema.entryLinks).set({ note: args.note }).where(eq(schema.entryLinks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  deleteLink: defineAction({
    description: "Removes a connection between two entries. The entries themselves are kept.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.entryLinks).where(eq(schema.entryLinks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  deleteCurio: defineAction({
    description: "Deletes an entry from the encyclopedia.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      const links = await db.select().from(schema.entryLinks);
      const doomed = links.filter((l) => l.fromId === args.id || l.toId === args.id);
      await db.delete(schema.curios).where(eq(schema.curios.id, args.id));
      for (const l of doomed) await db.delete(schema.entryLinks).where(eq(schema.entryLinks.id, l.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setPremium: defineAction({
    description: "Toggles Premium preview mode (simulates the $4.99/mo subscription for the prototype).",
    request: z.object({ isPremium: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await ensureSettings(ctx);
      await db.update(schema.settings).set({ isPremium: args.isPremium }).where(eq(schema.settings.id, 1));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  toggleChecklist: defineAction({
    description: "Toggles one item on the release launch checklist.",
    request: z.object({ key: z.string().min(1).max(80), checked: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      const s = await ensureSettings(ctx);
      const next = { ...s.checklist, [args.key]: args.checked };
      await db.update(schema.settings).set({ checklistJson: JSON.stringify(next) }).where(eq(schema.settings.id, 1));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
} satisfies ActionsModule;
