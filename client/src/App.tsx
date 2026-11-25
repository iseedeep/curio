import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim, bytesToBase64 } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";

const FIELDS = actionFields<typeof Actions>();
type State = ApiResponse<typeof api, "getState">;
type Curio = State["curios"][number];
type Category = Curio["category"];
type Draft = ApiResponse<typeof api, "explainCapture">["draft"];
type Pair = { q: string; a: string };

const CATEGORIES: { name: Category; color: string }[] = [
  { name: "Science", color: "#0284C7" },
  { name: "Tech", color: "#2563EB" },
  { name: "History", color: "#92400E" },
  { name: "Space", color: "#6D28D9" },
  { name: "Nature", color: "#15803D" },
  { name: "Art", color: "#BE123C" },
  { name: "Body", color: "#C2410C" },
  { name: "Society", color: "#7E22CE" },
];
const catColor = (c: Category) => CATEGORIES.find((x) => x.name === c)?.color ?? "#8E8E93";

/* ---------- Forgiving search: half-remembered phrases should still land ----------
   Token overlap across title / your question / explanation, light stemming,
   and a small synonym bridge (age ↔ times ↔ era) — the simplest thing that
   recovers "spirit of the age" for an entry titled "Spirit of the Times". */
const SYNONYMS: Record<string, string[]> = {
  age: ["times", "era", "zeitgeist", "period"],
  times: ["age", "era", "zeitgeist"],
  era: ["age", "times", "period"],
  zeitgeist: ["spirit", "age", "times"],
  spirit: ["soul", "zeitgeist"],
  soul: ["spirit"],
  photo: ["picture", "image"],
  picture: ["photo", "image"],
  image: ["photo", "picture"],
  money: ["cost", "price", "pay"],
  cost: ["money", "price"],
  price: ["money", "cost"],
  big: ["large", "huge"],
  large: ["big", "huge"],
  fast: ["quick", "speed"],
  quick: ["fast"],
};
function stem(w: string): string {
  let s = w.toLowerCase().replace(/[^a-z0-9à-ÿ]/g, "");
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s")) s = s.slice(0, -1);
  return s;
}
function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).map(stem).filter((t) => t.length > 1));
}
function scoreEntry(e: Curio, query: string): number {
  const qTokens = query.toLowerCase().split(/\s+/).map(stem).filter((t) => t.length > 1);
  if (qTokens.length === 0) return 0;
  const title = tokenSet(e.title);
  const asked = tokenSet(e.rawInput);
  const body = tokenSet([e.category, e.simpleAnswer, e.sourceText, e.whyItMatters, ...e.followups.flatMap((f) => [f.q, f.a])].join(" "));
  let score = 0;
  for (const t of qTokens) {
    const variants = [t, ...(SYNONYMS[t] ?? []).map(stem)];
    if (variants.some((v) => title.has(v))) score += 3;
    else if (variants.some((v) => asked.has(v))) score += 2;
    else if (variants.some((v) => body.has(v))) score += 1;
  }
  const qNorm = query.trim().toLowerCase();
  if (qNorm.length > 3 && (e.title.toLowerCase().includes(qNorm) || e.rawInput.toLowerCase().includes(qNorm))) score += 5;
  return score;
}

/* ---------- Draft persistence: an interrupted capture survives ---------- */
const DRAFT_KEY = "curio.draft.v1";
type StoredDraft = {
  raw: string;
  pref: "auto" | Category;
  img: { dataBase64: string; mimeType: string } | null;
  draft: Draft | null;
  title: string;
  category: Category | null;
  followups: Pair[];
};
function loadDraft(): StoredDraft | null {
  try {
    const s = localStorage.getItem(DRAFT_KEY);
    if (!s) return null;
    const p = JSON.parse(s) as StoredDraft;
    if (typeof p.raw !== "string") return null;
    return p;
  } catch { return null; }
}
function storeDraft(d: StoredDraft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, img: null })); } catch {}
  }
}
function clearStoredDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }

/* Downscale photos before upload/storage: faster, and small enough to keep in the draft. */
async function fileToCompressedBase64(f: File): Promise<{ dataBase64: string; mimeType: string }> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const max = 1400;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale >= 1 && (f.type === "image/jpeg" || f.type === "image/png") && f.size < 900_000) {
      const buf = await f.arrayBuffer();
      return { dataBase64: bytesToBase64(new Uint8Array(buf)), mimeType: f.type };
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const cx = canvas.getContext("2d");
    if (!cx) throw new Error("no canvas");
    cx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    return { dataBase64: dataUrl.split(",")[1] ?? "", mimeType: "image/jpeg" };
  } finally { URL.revokeObjectURL(url); }
}

function Title({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <header className="pt-10 pb-2">
      <h1 className="font-display text-[40px] leading-[1.08] font-bold">{children}</h1>
      {sub && <p className="text-[17px] leading-[1.65] text-[var(--dim)] mt-4 max-w-[52ch]">{sub}</p>}
    </header>
  );
}

type Tab = "capture" | "library";

export function App() {
  const [tab, setTab] = useState<Tab>("capture");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const state = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });

  if (state.isPending) return <div className="min-h-screen bg-[var(--bg)] px-6 pt-32 text-center text-[17px] leading-relaxed text-[var(--dim)]">Opening your encyclopedia…</div>;
  if (state.error || !state.data) return <div className="min-h-screen bg-[var(--bg)] px-6 pt-32 text-center"><p className="text-[17px] text-[var(--text)]">Couldn’t open Curio.</p><button className="mt-6 rounded-full bg-[var(--text)] px-6 py-3 font-semibold text-[var(--bg)] min-h-[48px]" onClick={() => state.refetch()}>Try again</button></div>;

  const data = state.data;
  const openEntry = (id: number) => { setSelectedId(id); setTab("library"); };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] pb-28">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="px-6 max-w-[640px] mx-auto w-full">
        {tab === "capture" && <CaptureTab onSaved={openEntry} />}
        {tab === "library" && (
          <LibraryTab
            entries={data.curios}
            links={data.links}
            selectedId={selectedId}
            onSelect={setSelectedId}
            goCapture={() => setTab("capture")}
          />
        )}
      </main>

      <nav aria-label="Main" className="fixed bottom-0 inset-x-0 z-30 bg-[var(--bg)]/85 backdrop-blur-xl border-t border-[var(--border)] pb-safe">
        <div className="max-w-[640px] mx-auto grid grid-cols-2 px-2">
          {([
            { id: "capture" as Tab, label: "Capture" },
            { id: "library" as Tab, label: "Library" },
          ]).map((t) => (
            <button key={t.id} aria-label={`Go to ${t.label}`} aria-current={tab === t.id ? "page" : undefined} onClick={() => { setTab(t.id); if (t.id === "capture") setSelectedId(null); }} className={`pt-2 pb-1.5 flex flex-col items-center gap-1 min-h-[56px] ${tab === t.id ? "text-[var(--text)]" : "text-[var(--faint)]"}`}>
              <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {t.id === "capture" ? (<><circle cx="12" cy="12" r="8.5" /><path d="M12 8.6v6.8M8.6 12h6.8" /></>) : (<><path d="M5 4.5h11A2.5 2.5 0 0 1 18.5 7v12.5H7.5A2.5 2.5 0 0 1 5 17z" /><path d="M5 17a2.5 2.5 0 0 1 2.5-2.5h11" /></>)}
              </svg>
              <span className={`text-[11px] leading-none ${tab === t.id ? "font-semibold" : "font-medium"}`}>{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/* ---------------- Capture ---------------- */
function CaptureTab({ onSaved }: { onSaved: (id: number) => void }) {
  const queryClient = useQueryClient();
  const initial = useRef<StoredDraft | null>(null);
  if (initial.current === null) initial.current = loadDraft() ?? { raw: "", pref: "auto" as const, img: null, draft: null, title: "", category: null, followups: [] };
  const init = initial.current;

  const [raw, setRaw] = useState(init.raw);
  const [pref, setPref] = useState<"auto" | Category>(init.pref);
  const [img, setImg] = useState<{ dataBase64: string; mimeType: string } | null>(init.img);
  const [draft, setDraft] = useState<Draft | null>(init.draft);
  const [title, setTitle] = useState(init.title);
  const [category, setCategory] = useState<Category | null>(init.category);
  const [followups, setFollowups] = useState<Pair[]>(init.followups);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef<HTMLInputElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);

  /* Keep the draft — question, photo, answer, follow-ups — across app switches and restarts. */
  useEffect(() => {
    storeDraft({ raw, pref, img, draft, title, category, followups });
  }, [raw, pref, img, draft, title, category, followups]);

  useEffect(() => {
    if (!draft) questionRef.current?.focus();
  }, [draft]);

  const method = img ? "photo" as const : raw.trim().startsWith("http") ? "link" as const : "text" as const;

  const explain = useMutation({
    mutationFn: async () => await api.explainCapture({ rawInput: raw.trim(), method, preferredCategory: pref, ...(img ? { image: img } : {}) }),
    onSuccess: (res) => { setDraft(res.draft); setTitle(res.draft.title); setCategory(res.draft.category); setFollowups([]); },
    onError: (e) => setError(e instanceof Error ? e.message : "Something went wrong. Your draft is kept — try again."),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Explain it first, then save.");
      return await api.saveEntry({
        rawInput: raw.trim(), title: title.trim(), category: category ?? draft.category, method,
        simpleAnswer: draft.simpleAnswer, whyItMatters: draft.whyItMatters, connections: draft.connections,
        followUp: draft.followUp, sourceText: draft.sourceText, unreadableNote: draft.unreadableNote,
        followups, ...(img ? { image: img } : {}),
      });
    },
    onSuccess: (res) => { clearStoredDraft(); queryClient.invalidateQueries({ queryKey: ["state"] }); onSaved(res.curio.id); },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't save. Your draft is kept — try again."),
  });

  const discard = () => {
    clearStoredDraft();
    setRaw(""); setImg(null); setDraft(null); setTitle(""); setCategory(null); setFollowups([]); setError(""); setPref("auto");
  };

  const onPhoto = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    try {
      const compressed = await fileToCompressedBase64(f);
      setImg(compressed);
      if (draft) { setDraft(null); setFollowups([]); }
    } catch { setError("That photo couldn’t be read here — try a different photo, or a screenshot of it."); }
  };

  const startVoice = () => {
    setError("");
    const w = window as unknown as { webkitSpeechRecognition?: new () => { lang: string; onresult: (e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void; onend: () => void; onerror: () => void; start: () => void }; SpeechRecognition?: new () => { lang: string; onresult: (e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void; onend: () => void; onerror: () => void; start: () => void } };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) { setError("Voice dictation isn’t available here — type it instead."); return; }
    const rec = new SR();
    rec.lang = "en-US";
    setListening(true);
    rec.onresult = (e) => { const t = e.results[0]?.[0]?.transcript; if (t) setRaw(t); };
    rec.onend = () => setListening(false);
    rec.onerror = () => { setListening(false); setError("Didn’t catch that — try again, or type it."); };
    rec.start();
  };

  const imgPreview = img ? `data:${img.mimeType};base64,${img.dataBase64}` : null;

  return (
    <div>
      <Title sub="Photograph the thing, or ask in your own words.">What caught your eye?</Title>

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Take a photo" onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={photosRef} type="file" accept="image/*" className="hidden" aria-label="Choose a photo from Photos" onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ""; }} />

      <div className="grid grid-cols-2 gap-3 mt-7">
        <button aria-label="Take a photo" onClick={() => cameraRef.current?.click()} className="rounded-[20px] bg-[var(--text)] text-[var(--bg)] py-4 text-[17px] font-semibold min-h-[56px] active:opacity-80">Take photo</button>
        <button aria-label="Choose from Photos" onClick={() => photosRef.current?.click()} className="rounded-[20px] border border-[var(--border)] py-4 text-[17px] font-semibold min-h-[56px]">Photos</button>
      </div>

      {imgPreview && (
        <div className="relative mt-4">
          <img src={imgPreview} alt="Your captured photo" className="w-full max-h-64 object-cover rounded-[20px]" />
          <button aria-label="Remove photo" onClick={() => { setImg(null); if (draft) { setDraft(null); setFollowups([]); } }} className="absolute top-2.5 right-2.5 bg-black/60 text-white rounded-full w-9 h-9 text-sm">✕</button>
        </div>
      )}

      <div className="mt-4 bg-[var(--well)] rounded-[24px] p-5">
        <label htmlFor="capture-input" className="sr-only">Your question</label>
        <textarea
          id="capture-input" ref={questionRef} {...FIELDS.explainCapture.rawInput} rows={img ? 3 : 4} value={raw}
          onChange={(e) => { setRaw(e.target.value); setError(""); if (draft) { setDraft(null); setFollowups([]); } }}
          placeholder={img ? "Ask about this photo — which line, which part?" : "Why is the sky orange at sunset?"}
          className="w-full bg-transparent outline-none resize-none text-[19px] leading-[1.6] placeholder:text-[var(--faint)]"
        />
        <div className="flex items-center justify-between mt-1">
          <button aria-label={listening ? "Listening" : "Dictate your question"} onClick={startVoice} className={`text-[15px] font-medium min-h-[44px] px-1 ${listening ? "text-[var(--red)]" : "text-[var(--dim)] underline underline-offset-4 decoration-[var(--border)]"}`}>{listening ? "Listening…" : "Dictate"}</button>
          <span className="text-[13px] text-[var(--faint)]">{raw.length} / 2000</span>
        </div>
      </div>

      {!draft && (
        <>
          <details className="mt-5">
            <summary aria-label="Choose a world (optional)" className="text-[15px] font-medium text-[var(--dim)] min-h-[44px] cursor-pointer">World — optional, we’ll guess</summary>
            <div className="flex flex-wrap gap-2 mt-2">
              <button aria-label="Category: Auto-detect" aria-pressed={pref === "auto"} onClick={() => setPref("auto")} className={`rounded-full px-4 py-2 text-[15px] min-h-[44px] border ${pref === "auto" ? "bg-[var(--text)] text-[var(--bg)] border-transparent font-semibold" : "border-[var(--border)] font-medium"}`}>Auto</button>
              {CATEGORIES.map((c) => (
                <button key={c.name} aria-label={`Category: ${c.name}`} aria-pressed={pref === c.name} onClick={() => setPref(c.name)} className={`rounded-full px-4 py-2 text-[15px] min-h-[44px] border inline-flex items-center gap-2 ${pref === c.name ? "bg-[var(--text)] text-[var(--bg)] border-transparent font-semibold" : "border-[var(--border)] font-medium"}`}>
                  <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />{c.name}
                </button>
              ))}
            </div>
          </details>

          {error && <p role="alert" className="mt-6 text-[16px] leading-relaxed text-[var(--red)]">{error}</p>}
          <button aria-label="Explain it" disabled={explain.isPending} onClick={() => { if (!raw.trim()) { setError(img ? "Add your question about the photo — which line or part?" : "Add a word or two first — what did you see?"); return; } setError(""); explain.mutate(); }} className="mt-7 w-full bg-[var(--text)] text-[var(--bg)] rounded-full py-4 text-[17px] font-semibold min-h-[56px] disabled:opacity-40 active:opacity-80">
            {explain.isPending ? "Reading it with you…" : "Explain"}
          </button>

          {!raw && !img && (
            <div className="mt-9">
              <p className="text-[15px] leading-relaxed text-[var(--dim)]">Reading a book, looking at a painting, stuck on a concept — photograph it or ask, and it becomes an entry you can find again.</p>
              <div className="mt-4 flex flex-col items-start gap-2">
                {["What does he mean by the spirit of the times?", "Why do cats purr?", "How do airplanes stay up?"].map((s) => (
                  <button key={s} aria-label={`Use suggestion: ${s}`} onClick={() => setRaw(s)} className="rounded-full border border-[var(--border)] px-4 py-2.5 text-[16px] font-medium min-h-[44px] text-left">{s}</button>
                ))}
              </div>
            </div>
          )}
          {(raw || img) && <p className="text-[14px] leading-relaxed text-[var(--faint)] mt-5">Your draft is kept on this device — switch apps or close Curio and it will be here when you come back.</p>}
        </>
      )}

      {draft && (
        <AnswerView
          draft={draft}
          question={raw}
          imgPreview={imgPreview}
          title={title} setTitle={setTitle}
          category={category ?? draft.category} setCategory={setCategory}
          followups={followups} setFollowups={setFollowups}
          error={error} setError={setError}
          saving={save.isPending}
          onSave={() => { if (!title.trim()) { setError("Give it a title you’ll recognize later."); return; } setError(""); save.mutate(); }}
          onDiscard={discard}
        />
      )}
    </div>
  );
}

/* ---------- The answer: read it, deepen it, then one deliberate Save ---------- */
function AnswerView({ draft, question, imgPreview, title, setTitle, category, setCategory, followups, setFollowups, error, setError, saving, onSave, onDiscard }: {
  draft: Draft; question: string; imgPreview: string | null;
  title: string; setTitle: (v: string) => void;
  category: Category; setCategory: (c: Category) => void;
  followups: Pair[]; setFollowups: (f: Pair[] | ((p: Pair[]) => Pair[])) => void;
  error: string; setError: (v: string) => void;
  saving: boolean; onSave: () => void; onDiscard: () => void;
}) {
  return (
    <section className="mt-9" aria-label="Explanation">
      {imgPreview && <img src={imgPreview} alt="The photo you captured" className="w-full max-h-56 object-cover rounded-[20px] mb-6" />}

      {draft.sourceText && (
        <div className="mb-7">
          <p className="text-[14px] font-semibold mb-2">The author’s words</p>
          <blockquote className="border-l-2 border-[var(--border)] pl-4 text-[17px] leading-[1.7] italic text-[var(--dim)] whitespace-pre-wrap">{draft.sourceText}</blockquote>
        </div>
      )}
      {draft.unreadableNote && (
        <p className="mb-7 text-[15px] leading-[1.65] rounded-[16px] bg-[var(--fill)] px-4 py-3"><span className="font-semibold">Hard to read:</span> {draft.unreadableNote} A clearer photo of that part would sharpen the answer.</p>
      )}

      <p className="text-[14px] font-semibold mb-2">Curio’s explanation</p>
      <p className="text-[18px] leading-[1.75]">{draft.simpleAnswer}</p>
      {draft.whyItMatters && <p className="text-[16px] leading-[1.7] text-[var(--dim)] mt-4">{draft.whyItMatters}</p>}
      {draft.connections.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {draft.connections.map((c, i) => <li key={i} className="text-[16px] leading-[1.6] text-[var(--dim)] flex gap-2.5"><span aria-hidden style={{ color: catColor(category) }}>—</span><span>{c}</span></li>)}
        </ul>
      )}
      <p className="text-[14px] leading-relaxed text-[var(--faint)] mt-5">You asked: “{question}”</p>

      <FollowUpList pairs={followups} />
      <FollowUpForm
        context={{ title, originalQuestion: question, simpleAnswer: draft.simpleAnswer, sourceText: draft.sourceText }}
        suggestion={followups.length === 0 ? draft.followUp : ""}
        onAnswer={(q, a) => setFollowups((p) => [...p, { q, a }])}
        setError={setError}
      />

      <div className="mt-10 pt-7 border-t border-[var(--border)]">
        <label htmlFor="entry-title" className="text-[14px] font-semibold block mb-2">Title — so future-you finds it</label>
        <input id="entry-title" {...FIELDS.saveEntry.title} value={title} onChange={(e) => setTitle(e.target.value)} className="w-full bg-[var(--well)] rounded-[16px] px-4 py-3.5 text-[18px] font-semibold outline-none min-h-[52px]" />
        <div className="flex flex-wrap gap-2 mt-4" role="group" aria-label="World">
          {CATEGORIES.map((c) => (
            <button key={c.name} aria-label={`World: ${c.name}`} aria-pressed={category === c.name} onClick={() => setCategory(c.name)} className={`rounded-full px-3.5 py-2 text-[14px] min-h-[40px] border inline-flex items-center gap-2 ${category === c.name ? "bg-[var(--text)] text-[var(--bg)] border-transparent font-semibold" : "border-[var(--border)] font-medium"}`}>
              <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />{c.name}
            </button>
          ))}
        </div>
        {error && <p role="alert" className="mt-5 text-[16px] leading-relaxed text-[var(--red)]">{error}</p>}
        <button aria-label="Save to Library" disabled={saving} onClick={onSave} className="mt-6 w-full bg-[var(--text)] text-[var(--bg)] rounded-full py-4 text-[17px] font-semibold min-h-[56px] disabled:opacity-40 active:opacity-80">
          {saving ? "Saving…" : "Save to Library"}
        </button>
        <button aria-label="Discard this capture" onClick={onDiscard} className="mt-2 w-full py-3 text-[15px] font-medium text-[var(--dim)] min-h-[48px]">Discard</button>
        <p className="text-center text-[14px] leading-relaxed text-[var(--faint)]">Nothing is in your Library until you save it. Follow-ups stay on this one entry.</p>
      </div>
    </section>
  );
}

function FollowUpList({ pairs }: { pairs: Pair[] }) {
  if (pairs.length === 0) return null;
  return (
    <div className="mt-7 space-y-6">
      {pairs.map((p, i) => (
        <div key={i} className="pt-5 border-t border-[var(--border)]">
          <p className="text-[16px] font-semibold leading-[1.55]">{p.q}</p>
          <p className="text-[17px] leading-[1.75] mt-2">{p.a}</p>
        </div>
      ))}
    </div>
  );
}

function FollowUpForm({ entryId, context, suggestion, onAnswer, setError }: {
  entryId?: number;
  context: { title: string; originalQuestion: string; simpleAnswer: string; sourceText: string };
  suggestion?: string;
  onAnswer: (q: string, a: string, all?: Pair[]) => void;
  setError: (v: string) => void;
}) {
  const [q, setQ] = useState("");
  const ask = useMutation({
    mutationFn: async (question: string) => await api.askFollowUp({ ...(entryId ? { entryId } : {}), question, ...context }),
    onSuccess: (res, question) => { onAnswer(question, res.answer, res.followups); setQ(""); },
    onError: (e) => setError(e instanceof Error ? e.message : "That follow-up didn’t come through — try again."),
  });
  const submit = (question: string) => {
    if (!question.trim()) { setError("Write the follow-up in a few words first — what’s still unclear?"); return; }
    setError("");
    ask.mutate(question.trim());
  };
  return (
    <div className="mt-7">
      {suggestion && (
        <button aria-label={`Ask suggested follow-up: ${suggestion}`} onClick={() => submit(suggestion)} disabled={ask.isPending} className="text-left text-[15px] leading-[1.6] text-[var(--dim)] italic min-h-[44px] disabled:opacity-40">Go deeper: “{suggestion}” →</button>
      )}
      <div className="flex gap-2 mt-2">
        <label htmlFor={entryId ? `fu-${entryId}` : "fu-draft"} className="sr-only">Ask a follow-up</label>
        <input id={entryId ? `fu-${entryId}` : "fu-draft"} {...FIELDS.askFollowUp.question} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(q); }} placeholder="Ask a follow-up…" className="flex-1 min-w-0 bg-[var(--fill)] rounded-full px-5 py-3 text-[16px] outline-none placeholder:text-[var(--faint)] min-h-[48px]" />
        <button aria-label="Send follow-up" disabled={ask.isPending || !q.trim()} onClick={() => submit(q)} className="rounded-full bg-[var(--text)] text-[var(--bg)] px-5 text-[15px] font-semibold min-h-[48px] disabled:opacity-40 shrink-0">{ask.isPending ? "…" : "Ask"}</button>
      </div>
    </div>
  );
}

/* ---------------- Library: a visual map of the collection ----------------
   The map is the Library's home. Each entry is a recognizable object — the
   photo itself, a miniature page, or a small note with the user's own words.
   Positions and user-chosen connections persist server-side, so the map is
   where you left it. Search flies to an object; A–Z keeps the clean index. */
type Link = State["links"][number];

/* v2: the map redesign opens fitted to the collection once; after that the
   saved camera wins. The old list view never wrote a camera, so no one loses
   a place they chose. */
const VIEW_KEY = "curio.map.view.v2";
const DISMISS_KEY = "curio.map.dismissed.v1";
const STOPWORDS = new Set(["what", "does", "mean", "about", "this", "that", "with", "from", "your", "have", "were", "when", "why", "how", "the", "and", "for", "are", "was", "his", "her", "its", "into", "they", "them", "then", "than"]);

type ObjKind = "photo" | "page" | "note";
function objKind(e: Curio): ObjKind {
  if (e.hasPhoto) return e.sourceText ? "page" : "photo";
  if (e.sourceText) return "page";
  return "note";
}
function objSize(e: Curio): { w: number; h: number; kind: ObjKind } {
  const kind = objKind(e);
  const hash = [...e.title].reduce((a, c) => a + c.charCodeAt(0), e.id);
  if (kind === "page") return { w: 118, h: 168, kind };
  if (kind === "note") return { w: 156, h: 108, kind };
  const ratios = [0.82, 1.04, 1.28];
  const w = 148;
  return { w, h: Math.round(w * (ratios[hash % 3] ?? 1)), kind };
}
function noteWords(e: Curio): string {
  if (e.mapLabel.trim()) return e.mapLabel.trim();
  const words = e.rawInput.replace(/[“”"']/g, "").split(/\s+/).filter(Boolean);
  return words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
}
function sigTokens(e: Curio): Set<string> {
  return new Set(
    `${e.title} ${e.rawInput}`.toLowerCase().split(/[^a-zà-ÿ0-9]+/).map(stem).filter((t) => t.length > 3 && !STOPWORDS.has(t)),
  );
}
function loadDismissed(): Set<string> {
  try { const p = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]"); return new Set(Array.isArray(p) ? p.filter((x: unknown) => typeof x === "string") : []); } catch { return new Set(); }
}
const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function LibraryTab({ entries, links, selectedId, onSelect, goCapture }: { entries: Curio[]; links: Link[]; selectedId: number | null; onSelect: (id: number | null) => void; goCapture: () => void }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"map" | "index">(() => { try { return localStorage.getItem("curio.library.view") === "index" ? "index" : "map"; } catch { return "map"; } });
  const selected = selectedId != null ? entries.find((e) => e.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <EntryDetail
        entry={selected}
        links={links}
        entries={entries}
        onOpenEntry={(id) => onSelect(id)}
        onBack={() => onSelect(null)}
        invalidate={() => queryClient.invalidateQueries({ queryKey: ["state"] })}
      />
    );
  }

  return (
    <div>
      <header className="pt-8 pb-1 flex items-end justify-between gap-3">
        <h1 className="font-display text-[30px] leading-none font-bold">Library</h1>
        {entries.length > 0 && (
          <div className="flex rounded-full bg-[var(--fill)] p-1" role="group" aria-label="Library view">
            {(["map", "index"] as const).map((v) => (
              <button key={v} aria-label={v === "map" ? "Map view" : "A–Z index view"} aria-pressed={view === v} onClick={() => { setView(v); try { localStorage.setItem("curio.library.view", v); } catch {} }} className={`rounded-full px-4 py-1.5 text-[14px] min-h-[36px] ${view === v ? "bg-[var(--surface)] font-semibold shadow-sm" : "font-medium text-[var(--dim)]"}`}>
                {v === "map" ? "Map" : "A–Z"}
              </button>
            ))}
          </div>
        )}
      </header>

      {entries.length === 0 ? (
        <div className="mt-14 text-center px-2">
          <p className="text-[17px] leading-[1.7] text-[var(--dim)] max-w-[40ch] mx-auto">Capture something you’re curious about, read the explanation, and save it — it will appear here as an object on your map, findable by sight.</p>
          <button aria-label="Make your first capture" onClick={goCapture} className="mt-7 bg-[var(--text)] text-[var(--bg)] rounded-full px-7 py-3.5 text-[17px] font-semibold min-h-[52px]">Make your first capture</button>
        </div>
      ) : view === "map" ? (
        <MapView entries={entries} links={links} onOpen={(id) => onSelect(id)} />
      ) : (
        <IndexView entries={entries} onSelect={onSelect} />
      )}
    </div>
  );
}

/* ---------------- The map ---------------- */
function MapView({ entries, links, onOpen }: { entries: Curio[]; links: Link[]; onOpen: (id: number) => void }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });
  const containerRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useRef<boolean>(typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const [size, setSize] = useState({ w: 360, h: 520 });

  const [view, setView] = useState<{ x: number; y: number; k: number } | null>(() => {
    try {
      const s = localStorage.getItem(VIEW_KEY);
      if (s) {
        const p = JSON.parse(s) as { x: number; y: number; k: number };
        /* A saved camera is only trusted if it is sane: finite, near the
           collection's scale, and not lost in deep space. Anything else
           falls back to fitting the collection. */
        if (typeof p.x === "number" && typeof p.y === "number" && typeof p.k === "number"
          && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.k)
          && p.k >= 0.2 && p.k <= 3 && Math.abs(p.x) <= 100000 && Math.abs(p.y) <= 100000) return p;
      }
    } catch {}
    return null;
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => { if (view && Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.k)) { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {} } }, [view]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setSize({ w: r.width, h: r.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Stable positions: saved ones win; new entries slot in near a linked
     neighbour when there is one, otherwise on a gentle spiral — existing
     objects never move. */
  const positions = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    const placed: { x: number; y: number }[] = [];
    /* Auto-placed objects nudge clear of what's already down; a position the
       user (or an earlier save) chose is never moved. */
    const resolve = (cand: { x: number; y: number }) => {
      let p = cand;
      for (let iter = 0; iter < 16; iter++) {
        const clash = placed.find((q) => Math.abs(q.x - p.x) < 188 && Math.abs(q.y - p.y) < 168);
        if (!clash) break;
        const dx = p.x - clash.x;
        const dy = p.y - clash.y;
        const d = Math.hypot(dx, dy) || 1;
        p = { x: clash.x + (dx / d) * 205, y: clash.y + (dy / d) * 188 };
      }
      return p;
    };
    const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    sorted.forEach((e, i) => {
      /* A saved position is only trusted within a sane range of the origin;
         anything wilder is treated as unplaced and re-slotted. */
      if (e.posX != null && e.posY != null && Math.abs(e.posX) <= 20000 && Math.abs(e.posY) <= 20000) { map.set(e.id, { x: e.posX, y: e.posY }); placed.push({ x: e.posX, y: e.posY }); return; }
      if (sorted.length === 1 || i === 0) { map.set(e.id, { x: 0, y: 0 }); placed.push({ x: 0, y: 0 }); return; }
      const link = links.find((l) => (l.fromId === e.id && map.has(l.toId)) || (l.toId === e.id && map.has(l.fromId)));
      if (link) {
        const n = map.get(link.fromId === e.id ? link.toId : link.fromId)!;
        const ang = i * 2.39996;
        const p = resolve({ x: n.x + Math.cos(ang) * 252, y: n.y + Math.sin(ang) * 252 });
        map.set(e.id, p); placed.push(p);
        return;
      }
      const r = 175 * Math.sqrt(i + 0.6);
      const t = i * 2.39996;
      const p = resolve({ x: Math.cos(t) * r, y: Math.sin(t) * r * 0.84 });
      map.set(e.id, p); placed.push(p);
    });
    return map;
  }, [entries, links]);

  /* fitCamera is defined with the camera moves below; this ref lets the
     first-layout effect and the Connect action reach it. */
  const fitRef = useRef<{ fit: () => void; snap: () => void }>({ fit: () => {}, snap: () => {} });

  /* First layout ever: fit. After that, the saved camera wins — unless it
     points at empty space (a long pan, a changed collection), in which case
     fit rather than greet the user with a blank map. */
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || size.w <= 10 || entries.length === 0) return;
    fittedRef.current = true;
    if (view === null) { fitRef.current.fit(); return; }
    const anyVisible = entries.some((e) => {
      const p = positions.get(e.id) ?? { x: 0, y: 0 };
      const sx = p.x * view.k + view.x;
      const sy = p.y * view.k + view.y;
      return sx > -280 && sx < size.w + 280 && sy > -280 && sy < size.h + 280;
    });
    if (!anyVisible) fitRef.current.fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, size, entries, positions]);

  const posMut = useMutation({ mutationFn: async (a: { id: number; x: number; y: number }) => await api.setMapPosition(a), onSuccess: invalidate });
  const savedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const e of entries) {
      if (e.posX == null && !savedRef.current.has(e.id)) {
        const p = positions.get(e.id);
        if (p) { savedRef.current.add(e.id); posMut.mutate({ id: e.id, x: Math.round(p.x), y: Math.round(p.y) }); }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, positions]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<number | null>(null);
  const [pendingLink, setPendingLink] = useState<{ fromId: number; toId: number } | null>(null);
  const [linkNote, setLinkNote] = useState("");
  const [dragPos, setDragPos] = useState<{ id: number; x: number; y: number } | null>(null);
  const [linkDrag, setLinkDrag] = useState<{ fromId: number; x: number; y: number; overId: number | null } | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const [flashId, setFlashId] = useState<number | null>(null);

  const posOf = (id: number) => (dragPos && dragPos.id === id ? { x: dragPos.x, y: dragPos.y } : positions.get(id) ?? { x: 0, y: 0 });
  const selectedEntry = selectedId != null ? entries.find((e) => e.id === selectedId) ?? null : null;
  const selectedLink = selectedLinkId != null ? links.find((l) => l.id === selectedLinkId) ?? null : null;

  const neighborsOf = (id: number) => links.filter((l) => l.fromId === id || l.toId === id).map((l) => (l.fromId === id ? l.toId : l.fromId));
  const neighborSet = selectedId != null ? new Set(neighborsOf(selectedId)) : new Set<number>();

  const suggestion = useMemo(() => {
    if (!selectedEntry) return null;
    const mine = sigTokens(selectedEntry);
    let best: { entry: Curio; shared: string[] } | null = null;
    for (const e of entries) {
      if (e.id === selectedEntry.id) continue;
      if (links.some((l) => pairKey(l.fromId, l.toId) === pairKey(selectedEntry.id, e.id))) continue;
      if (dismissed.has(pairKey(selectedEntry.id, e.id))) continue;
      const shared = [...sigTokens(e)].filter((t) => mine.has(t));
      if (shared.length > 0 && (!best || shared.length > best.shared.length)) best = { entry: e, shared };
    }
    return best;
  }, [selectedEntry, entries, links, dismissed]);

  /* ----- camera moves ----- */
  const animRef = useRef(0);
  /* The camera may never leave the collection's neighbourhood: every write
     to the view goes through this clamp. */
  const clampView = (v: { x: number; y: number; k: number }) => ({
    x: Number.isFinite(v.x) ? Math.min(20000, Math.max(-20000, v.x)) : 0,
    y: Number.isFinite(v.y) ? Math.min(20000, Math.max(-20000, v.y)) : 0,
    k: Number.isFinite(v.k) ? Math.min(2.4, Math.max(0.3, v.k)) : 1,
  });

  const moveTo = (rawTarget: { x: number; y: number; k: number }) => {
    cancelAnimationFrame(animRef.current);
    const target = clampView(rawTarget);
    const from = clampView(viewRef.current ?? target);
    /* Snap instead of animating when the jump is huge or the current camera
       is unusable — a long interpolation through empty space helps no one. */
    if (reduceMotion.current || !Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(from.k)
      || Math.abs(target.k / Math.max(0.05, from.k)) > 6 || Math.hypot(target.x - from.x, target.y - from.y) > 4000) {
      setView(target);
      return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      /* Clamp both ends: a frame timestamp earlier than t0 (clock skew in
         some webviews) would otherwise make the easing explode cubically
         and fling the camera to a meaningless offset. */
      const p = Math.min(1, Math.max(0, (t - t0) / 480));
      const ease = 1 - Math.pow(1 - p, 3);
      setView(clampView({ x: from.x + (target.x - from.x) * ease, y: from.y + (target.y - from.y) * ease, k: from.k + (target.k - from.k) * ease }));
      if (p < 1) animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  };
  const centerOn = (id: number, keepZoom = true) => {
    const p = posOf(id);
    const k = keepZoom ? (viewRef.current?.k ?? 1) : 1;
    /* Aim a little above center: the preview card owns the bottom strip. */
    moveTo({ x: size.w / 2 - p.x * k, y: size.h / 2 - p.y * k + 64, k });
    setFlashId(id);
    setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1600);
  };
  /* Fit the whole collection into view — first layout, and again when
     linking starts, so the target object is actually on screen. */
  const fitCamera = (snap = false) => {
    if (size.w <= 10 || entries.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of entries) {
      const p = posOf(e.id);
      const { w, h } = objSize(e);
      minX = Math.min(minX, p.x - w / 2 - 14);
      maxX = Math.max(maxX, p.x + w / 2 + 14);
      minY = Math.min(minY, p.y - h / 2 - 14);
      maxY = Math.max(maxY, p.y + h / 2 + 44);
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const k = Math.min(1, Math.max(0.3, Math.min((size.w - 16) / bw, (size.h - 16) / bh)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const target = { x: size.w / 2 - cx * k, y: size.h / 2 - cy * k, k };
    if (snap) { cancelAnimationFrame(animRef.current); setView(clampView(target)); return; }
    moveTo(target);
  };
  fitRef.current = { fit: () => fitCamera(false), snap: () => fitCamera(true) };
  const followThread = (fromId: number, toId: number) => {
    setHistory((h) => [...h, fromId]);
    setSelectedId(toId);
    setSelectedLinkId(null);
    centerOn(toId);
  };
  const goBackThread = () => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev != null) { setSelectedId(prev); centerOn(prev); }
      return h.slice(0, -1);
    });
  };

  /* ----- gestures: pan, pinch, drag object, long-press drag-to-link ----- */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<null | {
    kind: "pan" | "obj"; entryId: number; startCx: number; startCy: number;
    startView: { x: number; y: number; k: number }; startPos: { x: number; y: number };
    moved: boolean; linkMode: boolean; pinch: boolean; startDist: number; startK: number;
    interactive: boolean;
  }>(null);
  const longTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toWorld = (cx: number, cy: number) => {
    const el = containerRef.current!;
    const r = el.getBoundingClientRect();
    const v = viewRef.current ?? { x: r.width / 2, y: r.height / 2, k: 1 };
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k, sx: cx - r.left, sy: cy - r.top };
  };
  const entryAtPoint = (cx: number, cy: number): number | null => {
    const el = document.elementFromPoint(cx, cy)?.closest?.("[data-entry-id]");
    const id = el?.getAttribute("data-entry-id");
    return id ? Number(id) : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(animRef.current);
    const objEl = (e.target as HTMLElement).closest?.("[data-entry-id]");
    const entryId = objEl ? Number(objEl.getAttribute("data-entry-id")) : null;
    const v = viewRef.current ?? { x: size.w / 2, y: size.h / 2, k: 1 };
    if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      if (gesture.current) { gesture.current.pinch = true; gesture.current.startDist = dist; gesture.current.startK = v.k; gesture.current.startView = v; gesture.current.startCx = (pts[0]!.x + pts[1]!.x) / 2; gesture.current.startCy = (pts[0]!.y + pts[1]!.y) / 2; }
      if (longTimer.current) clearTimeout(longTimer.current);
      setDragPos(null); setLinkDrag(null);
      return;
    }
    gesture.current = {
      kind: entryId != null ? "obj" : "pan", entryId: entryId ?? -1,
      startCx: e.clientX, startCy: e.clientY, startView: v,
      startPos: entryId != null ? posOf(entryId) : { x: 0, y: 0 },
      moved: false, linkMode: false, pinch: false, startDist: 0, startK: v.k,
      /* Taps that start on a real control inside the canvas (Open, Connect,
         thread chips, zoom…) belong to that control's click — the canvas
         must not clear the selection on pointer-up, or the control unmounts
         before its click ever lands. */
      interactive: !!(e.target as HTMLElement).closest?.("button, a, input, textarea, select"),
    };
    if (entryId != null) {
      const id = entryId;
      longTimer.current = setTimeout(() => {
        if (gesture.current && gesture.current.kind === "obj" && gesture.current.entryId === id && !gesture.current.moved) {
          gesture.current.linkMode = true;
          const w = toWorld(gesture.current.startCx, gesture.current.startCy);
          setLinkDrag({ fromId: id, x: w.x, y: w.y, overId: null });
          try { navigator.vibrate?.(12); } catch {}
        }
      }, 520);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.pinch && pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      const mid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 };
      const el = containerRef.current!;
      const r = el.getBoundingClientRect();
      const k = Math.min(2.4, Math.max(0.3, g.startK * (dist / Math.max(20, g.startDist))));
      const wBefore = { x: (g.startCx - r.left - g.startView.x) / g.startView.k, y: (g.startCy - r.top - g.startView.y) / g.startView.k };
      setView(clampView({ k, x: mid.x - r.left - wBefore.x * k, y: mid.y - r.top - wBefore.y * k }));
      return;
    }
    const dx = e.clientX - g.startCx;
    const dy = e.clientY - g.startCy;
    if (g.linkMode) {
      const w = toWorld(e.clientX, e.clientY);
      const over = entryAtPoint(e.clientX, e.clientY);
      setLinkDrag((ld) => (ld ? { ...ld, x: w.x, y: w.y, overId: over !== ld.fromId ? over : null } : ld));
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 7) {
      g.moved = true;
      if (longTimer.current) clearTimeout(longTimer.current);
    }
    if (!g.moved) return;
    if (g.kind === "pan") {
      setView(clampView({ ...g.startView, x: g.startView.x + dx, y: g.startView.y + dy }));
    } else {
      const k = g.startView.k;
      setDragPos({ id: g.entryId, x: Math.min(20000, Math.max(-20000, g.startPos.x + dx / k)), y: Math.min(20000, Math.max(-20000, g.startPos.y + dy / k)) });
    }
  };

  const endGesture = (e: React.PointerEvent, cancelled: boolean) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (longTimer.current) clearTimeout(longTimer.current);
    if (!g) return;
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (cancelled) { setDragPos(null); setLinkDrag(null); return; }
    if (g.linkMode) {
      const over = entryAtPoint(e.clientX, e.clientY);
      setLinkDrag(null);
      if (over != null && over !== g.entryId) { setPendingLink({ fromId: g.entryId, toId: over }); setLinkNote(""); }
      return;
    }
    if (g.kind === "obj") {
      if (g.moved) {
        setDragPos((dp) => {
          if (dp && dp.id === g.entryId) posMut.mutate({ id: dp.id, x: Math.round(dp.x), y: Math.round(dp.y) });
          return null;
        });
        return;
      }
      /* A tap on an object. */
      if (connectFrom != null && connectFrom !== g.entryId) {
        setPendingLink({ fromId: connectFrom, toId: g.entryId });
        setLinkNote("");
        setConnectFrom(null);
        return;
      }
      setConnectFrom(null);
      setSelectedLinkId(null);
      setSelectedId(g.entryId);
      return;
    }
    /* Tap on empty canvas clears selection. */
    if (!g.moved && !g.pinch && !g.interactive) { setSelectedId(null); setSelectedLinkId(null); setConnectFrom(null); }
  };

  const onWheel = (e: React.WheelEvent) => {
    const v = viewRef.current;
    if (!v) return;
    const k = Math.min(2.4, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    const el = containerRef.current!;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const wx = (mx - v.x) / v.k;
    const wy = (my - v.y) / v.k;
    setView(clampView({ k, x: mx - wx * k, y: my - wy * k }));
  };

  const createLinkMut = useMutation({
    mutationFn: async () => {
      if (!pendingLink) throw new Error("Pick two entries first.");
      return await api.createLink({ fromId: pendingLink.fromId, toId: pendingLink.toId, note: linkNote.trim() });
    },
    onSuccess: (res) => { setPendingLink(null); setLinkNote(""); setSelectedLinkId(res.link.id); setSelectedId(null); invalidate(); },
  });
  const updateLinkMut = useMutation({
    mutationFn: async (a: { id: number; note: string }) => await api.updateLink(a),
    onSuccess: invalidate,
  });
  const deleteLinkMut = useMutation({
    mutationFn: async (id: number) => await api.deleteLink({ id }),
    onSuccess: () => { setSelectedLinkId(null); invalidate(); },
  });

  const searching = query.trim().length > 0;
  const results = useMemo(() => {
    if (!searching) return [];
    return entries.map((e) => ({ e, s: scoreEntry(e, query) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title)).map((x) => x.e);
  }, [entries, query, searching]);

  const v = view ?? { x: size.w / 2, y: size.h / 2, k: 1 };
  const labelOpacity = v.k < 0.5 ? 0 : v.k < 0.75 ? 0.55 : 1;

  return (
    <div className="-mx-6">
      <div className="px-6 relative">
        <label htmlFor="map-search" className="sr-only">Search your collection</label>
        <input id="map-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search — we’ll take you to it on the map" className="w-full bg-[var(--fill)] border-none rounded-full px-5 py-3 text-[16px] outline-none placeholder:text-[var(--faint)] min-h-[48px]" />
        {searching && (
          <div className="absolute inset-x-6 top-full mt-1 z-40 rounded-[18px] bg-[var(--surface)] shadow-xl border border-[var(--border)] overflow-hidden">
            {results.length === 0 && <p className="px-5 py-4 text-[15px] text-[var(--dim)]">No matches — try the words you’d use to describe the idea.</p>}
            {results.map((e) => (
              <button key={e.id} aria-label={`Find ${e.title} on the map`} onClick={() => { setQuery(""); setSelectedId(e.id); setSelectedLinkId(null); centerOn(e.id); }} className="w-full text-left px-5 py-3.5 flex items-center gap-3 border-t border-[var(--border)] first:border-t-0 min-h-[52px]">
                {e.hasPhoto && e.photoUrl ? <img src={e.photoUrl} alt="" className="w-9 h-9 rounded-[8px] object-cover shrink-0" /> : <span aria-hidden className="w-9 h-9 rounded-[8px] shrink-0 flex items-center justify-center" style={{ background: `${catColor(e.category)}1F` }}><span className="w-2 h-2 rounded-full" style={{ background: catColor(e.category) }} /></span>}
                <span className="min-w-0"><span className="block font-semibold text-[15px] truncate">{e.title}</span><span className="block text-[13px] text-[var(--faint)] truncate">{e.category}</span></span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        role="application"
        aria-label="Map of your collection. Drag to pan, pinch to zoom. Each object is also a button you can select."
        className="relative mt-3 h-[calc(100dvh-248px)] min-h-[430px] overflow-hidden touch-none select-none"
        style={{ background: "var(--well)" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endGesture(e, false)}
        onPointerCancel={(e) => endGesture(e, true)}
        onWheel={onWheel}
      >
        {/* world layer */}
        <div className="absolute left-0 top-0 w-0 h-0" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})`, transformOrigin: "0 0" }}>
          <svg className="absolute overflow-visible" style={{ left: -3000, top: -3000, width: 6000, height: 6000 }} viewBox="-3000 -3000 6000 6000" aria-hidden>
            {links.map((l) => {
              const a = posOf(l.fromId);
              const b = posOf(l.toId);
              const active = selectedLinkId === l.id || (selectedId != null && (l.fromId === selectedId || l.toId === selectedId));
              const dim = (selectedId != null && !active) || (selectedLinkId != null && !active);
              return (
                <g key={l.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={30 / v.k} style={{ pointerEvents: "stroke", cursor: "pointer" }} onClick={() => { setSelectedLinkId(l.id); setSelectedId(null); }} />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--dim)" strokeWidth={(active ? 2 : 1.1) / v.k} strokeOpacity={dim ? 0.12 : active ? 0.75 : 0.32} style={{ pointerEvents: "none" }} />
                </g>
              );
            })}
            {suggestion && selectedEntry && (() => {
              const a = posOf(selectedEntry.id);
              const b = posOf(suggestion.entry.id);
              return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--faint)" strokeWidth={1.4 / v.k} strokeDasharray={`${5 / v.k} ${5 / v.k}`} strokeOpacity={0.65} style={{ pointerEvents: "none" }} />;
            })()}
            {linkDrag && (() => {
              const a = posOf(linkDrag.fromId);
              return <line x1={a.x} y1={a.y} x2={linkDrag.x} y2={linkDrag.y} stroke="var(--text)" strokeWidth={2 / v.k} strokeOpacity={0.7} style={{ pointerEvents: "none" }} />;
            })()}
          </svg>

          {entries.map((e) => {
            const p = posOf(e.id);
            const { w, h, kind } = objSize(e);
            const isSel = selectedId === e.id;
            const isNeighbor = neighborSet.has(e.id);
            const dim = selectedId != null && !isSel && !isNeighbor && !(suggestion && suggestion.entry.id === e.id);
            const isDrop = linkDrag?.overId === e.id;
            const radius = kind === "photo" ? (e.id % 3 === 0 ? "50%" : "16px") : kind === "page" ? "6px" : "12px";
            return (
              <div key={e.id} className="absolute" style={{ left: p.x - w / 2, top: p.y - h / 2, width: w, opacity: dim ? 0.32 : 1, transition: reduceMotion.current ? "none" : "opacity 200ms" }}>
                <div
                  role="button"
                  tabIndex={0}
                  data-entry-id={e.id}
                  aria-label={`Map object: ${e.title}. Press Enter to select.`}
                  onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSelectedId(e.id); setSelectedLinkId(null); } }}
                  className="relative w-full overflow-hidden"
                  style={{
                    height: h,
                    borderRadius: radius,
                    boxShadow: isSel || isDrop ? `0 0 0 ${3 / v.k}px var(--text), 0 10px 28px rgba(0,0,0,0.22)` : flashId === e.id ? `0 0 0 ${4 / v.k}px var(--gold), 0 10px 28px rgba(0,0,0,0.22)` : "0 6px 20px rgba(0,0,0,0.16)",
                    background: "var(--surface)",
                    cursor: "pointer",
                  }}
                >
                  {kind !== "note" && e.hasPhoto && e.photoUrl ? (
                    <img src={e.photoUrl} alt={e.title} draggable={false} className="w-full h-full object-cover pointer-events-none" />
                  ) : kind === "page" ? (
                    <div className="w-full h-full px-3 py-2.5 pointer-events-none" style={{ background: "var(--surface)" }}>
                      <p className="text-[10.5px] leading-[1.5] italic text-[var(--dim)] line-clamp-[9]">{e.sourceText || e.simpleAnswer}</p>
                    </div>
                  ) : (
                    <div className="w-full h-full px-3.5 py-3 pointer-events-none flex flex-col" style={{ background: `${catColor(e.category)}14` }}>
                      <span aria-hidden className="w-2 h-2 rounded-full mb-1.5" style={{ background: catColor(e.category) }} />
                      <p className="text-[14.5px] leading-[1.4] font-medium line-clamp-3">{noteWords(e)}</p>
                      <p className="text-[10.5px] text-[var(--faint)] mt-auto">your words</p>
                    </div>
                  )}
                  {kind === "page" && e.hasPhoto && <span aria-hidden className="absolute bottom-1.5 right-1.5 bg-black/55 text-white text-[9.5px] px-1.5 py-0.5 rounded-full">page</span>}
                </div>
                <p aria-hidden className="absolute left-1/2 -translate-x-1/2 mt-1.5 w-[168px] text-center text-[12px] leading-[1.3] font-medium pointer-events-none" style={{ opacity: labelOpacity, color: "var(--dim)", transition: reduceMotion.current ? "none" : "opacity 200ms" }}>
                  <span className="line-clamp-2">{e.title}</span>
                </p>
              </div>
            );
          })}
        </div>

        {/* chrome over the canvas */}
        {history.length > 0 && (
          <button aria-label="Back along the thread" onClick={goBackThread} className="absolute left-3 top-3 z-30 rounded-full bg-[var(--surface)] shadow-md border border-[var(--border)] px-4 py-2 text-[15px] font-medium min-h-[40px]">‹ Back</button>
        )}
        {connectFrom != null && (
          <div className="absolute left-1/2 -translate-x-1/2 top-3 z-30 flex items-center gap-2 rounded-full bg-[var(--text)] text-[var(--bg)] pl-4 pr-1.5 py-1.5 shadow-lg">
            <span className="text-[14px] font-medium whitespace-nowrap">Tap another object to link it</span>
            <button aria-label="Cancel linking" onClick={() => setConnectFrom(null)} className="rounded-full bg-[var(--bg)]/20 px-3 py-1 text-[13px] font-semibold min-h-[32px]">Cancel</button>
          </div>
        )}
        {linkDrag && (
          <p className="absolute left-1/2 -translate-x-1/2 top-3 z-30 rounded-full bg-[var(--text)] text-[var(--bg)] px-4 py-2 text-[14px] font-medium shadow-lg whitespace-nowrap">Drop on another object to link</p>
        )}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-2">
          <button aria-label="Zoom in" onClick={() => moveTo({ ...v, k: Math.min(2.4, v.k * 1.3), x: size.w / 2 - ((size.w / 2 - v.x) / v.k) * Math.min(2.4, v.k * 1.3), y: size.h / 2 - ((size.h / 2 - v.y) / v.k) * Math.min(2.4, v.k * 1.3) })} className="w-11 h-11 rounded-full bg-[var(--surface)] shadow-md border border-[var(--border)] text-[20px] font-medium">+</button>
          <button aria-label="Zoom out" onClick={() => moveTo({ ...v, k: Math.max(0.3, v.k * 0.77), x: size.w / 2 - ((size.w / 2 - v.x) / v.k) * Math.max(0.3, v.k * 0.77), y: size.h / 2 - ((size.h / 2 - v.y) / v.k) * Math.max(0.3, v.k * 0.77) })} className="w-11 h-11 rounded-full bg-[var(--surface)] shadow-md border border-[var(--border)] text-[20px] font-medium">−</button>
          <button aria-label="Show the whole collection" onClick={() => fitRef.current.fit()} className="w-11 h-11 rounded-full bg-[var(--surface)] shadow-md border border-[var(--border)] flex items-center justify-center">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /></svg>
          </button>
        </div>
        <p className="absolute left-3 bottom-3 z-20 text-[12px] text-[var(--faint)] pointer-events-none">{entries.length} {entries.length === 1 ? "object" : "objects"} · {links.length} {links.length === 1 ? "connection" : "connections"}</p>

        {/* selection preview */}
        {selectedEntry && !selectedLink && !pendingLink && connectFrom == null && (
          <div className="absolute inset-x-3 bottom-3 z-30 rounded-[22px] bg-[var(--surface)] shadow-2xl border border-[var(--border)] p-4">
            <div className="flex items-start gap-3">
              {selectedEntry.hasPhoto && selectedEntry.photoUrl ? (
                <img src={selectedEntry.photoUrl} alt="" className="w-14 h-14 rounded-[12px] object-cover shrink-0" />
              ) : (
                <span aria-hidden className="w-14 h-14 rounded-[12px] shrink-0 flex items-center justify-center" style={{ background: `${catColor(selectedEntry.category)}1F` }}><span className="w-3 h-3 rounded-full" style={{ background: catColor(selectedEntry.category) }} /></span>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-display text-[17px] font-bold leading-[1.25] line-clamp-2">{selectedEntry.title}</p>
                <p className="text-[13px] text-[var(--faint)] mt-0.5">{selectedEntry.category} · {new Date(selectedEntry.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>
              </div>
              <button aria-label="Close preview" onClick={() => setSelectedId(null)} className="text-[var(--faint)] w-9 h-9 text-lg shrink-0">✕</button>
            </div>
            {neighborSet.size > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                <span className="text-[13px] text-[var(--faint)] py-2">Connected:</span>
                {[...neighborSet].map((nid) => {
                  const n = entries.find((e) => e.id === nid);
                  if (!n) return null;
                  return <button key={nid} aria-label={`Follow the thread to ${n.title}`} onClick={() => followThread(selectedEntry.id, nid)} className="rounded-full border border-[var(--border)] px-3.5 py-2 text-[14px] font-medium min-h-[38px]">{n.title} →</button>;
                })}
              </div>
            )}
            {suggestion && (
              <div className="mt-3 rounded-[14px] bg-[var(--fill)] px-3.5 py-3">
                <p className="text-[14px] leading-[1.5]"><span className="font-semibold">Suggested:</span> “{suggestion.entry.title}” — both mention “{suggestion.shared[0]}”. <span className="text-[var(--faint)]">Curio’s idea, not your link yet.</span></p>
                <div className="flex gap-2 mt-2">
                  <button aria-label={`Accept suggestion: link to ${suggestion.entry.title}`} onClick={() => { setPendingLink({ fromId: selectedEntry.id, toId: suggestion.entry.id }); setLinkNote(""); }} className="rounded-full bg-[var(--text)] text-[var(--bg)] px-4 py-2 text-[14px] font-semibold min-h-[38px]">Link them</button>
                  <button aria-label="Dismiss suggestion" onClick={() => { const key = pairKey(selectedEntry.id, suggestion.entry.id); const next = new Set(dismissed); next.add(key); setDismissed(next); try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...next])); } catch {} }} className="rounded-full border border-[var(--border)] px-4 py-2 text-[14px] font-medium min-h-[38px]">Dismiss</button>
                </div>
              </div>
            )}
            <div className="flex gap-2 mt-3">
              <button aria-label={`Open ${selectedEntry.title}`} onClick={() => onOpen(selectedEntry.id)} className="flex-1 rounded-full bg-[var(--text)] text-[var(--bg)] py-3 text-[15px] font-semibold min-h-[48px]">Open</button>
              <button aria-label={`Connect ${selectedEntry.title} to another entry`} onClick={() => { setConnectFrom(selectedEntry.id); fitRef.current.snap(); }} className="flex-1 rounded-full border border-[var(--border)] py-3 text-[15px] font-semibold min-h-[48px]">Connect</button>
            </div>
            <p className="text-[12.5px] text-[var(--faint)] mt-2.5 text-center">Drag to move it · long-press and drag onto another object to link</p>
          </div>
        )}

        {/* link sheet */}
        {selectedLink && !pendingLink && (() => {
          const a = entries.find((e) => e.id === selectedLink.fromId);
          const b = entries.find((e) => e.id === selectedLink.toId);
          if (!a || !b) return null;
          return (
            <div className="absolute inset-x-3 bottom-3 z-30 rounded-[22px] bg-[var(--surface)] shadow-2xl border border-[var(--border)] p-4">
              <div className="flex items-center gap-3">
                {[a, b].map((e, i) => (
                  <div key={e.id} className="flex items-center gap-3 min-w-0 flex-1">
                    {i === 1 && <span aria-hidden className="text-[var(--faint)] shrink-0">—</span>}
                    {e.hasPhoto && e.photoUrl ? <img src={e.photoUrl} alt="" className="w-11 h-11 rounded-[10px] object-cover shrink-0" /> : <span aria-hidden className="w-11 h-11 rounded-[10px] shrink-0 flex items-center justify-center shrink-0" style={{ background: `${catColor(e.category)}1F` }}><span className="w-2.5 h-2.5 rounded-full" style={{ background: catColor(e.category) }} /></span>}
                    <p className="font-semibold text-[14.5px] leading-[1.3] line-clamp-2 min-w-0">{e.title}</p>
                  </div>
                ))}
                <button aria-label="Close connection" onClick={() => setSelectedLinkId(null)} className="text-[var(--faint)] w-9 h-9 text-lg shrink-0">✕</button>
              </div>
              {selectedLink.note ? (
                <blockquote className="mt-3 rounded-[14px] bg-[var(--fill)] px-4 py-3 text-[15.5px] leading-[1.6]">“{selectedLink.note}”<span className="block text-[12px] text-[var(--faint)] mt-1 not-italic">your words</span></blockquote>
              ) : (
                <p className="mt-3 text-[14.5px] text-[var(--dim)]">You linked these two. No note yet — add the thought that joins them.</p>
              )}
              <LinkNoteEditor key={selectedLink.id} link={selectedLink} onSave={(note) => updateLinkMut.mutate({ id: selectedLink.id, note })} saving={updateLinkMut.isPending} />
              <div className="flex gap-2 mt-3">
                <button aria-label={`Open ${a.title}`} onClick={() => onOpen(a.id)} className="flex-1 rounded-full bg-[var(--text)] text-[var(--bg)] py-2.5 px-2 text-[14px] font-semibold min-h-[44px]">Open {a.title.length > 18 ? a.title.slice(0, 17) + "…" : a.title}</button>
                <button aria-label={`Open ${b.title}`} onClick={() => onOpen(b.id)} className="flex-1 rounded-full bg-[var(--text)] text-[var(--bg)] py-2.5 px-2 text-[14px] font-semibold min-h-[44px]">Open {b.title.length > 18 ? b.title.slice(0, 17) + "…" : b.title}</button>
              </div>
              <button aria-label="Remove this connection" onClick={() => deleteLinkMut.mutate(selectedLink.id)} className="mt-2 w-full py-2 text-[14px] font-medium text-[var(--red)] min-h-[40px]">Remove connection</button>
            </div>
          );
        })()}

        {/* pending link confirm */}
        {pendingLink && (() => {
          const a = entries.find((e) => e.id === pendingLink.fromId);
          const b = entries.find((e) => e.id === pendingLink.toId);
          if (!a || !b) return null;
          return (
            <div className="absolute inset-x-3 bottom-3 z-40 rounded-[22px] bg-[var(--surface)] shadow-2xl border border-[var(--border)] p-4">
              <p className="text-[16px] font-semibold leading-[1.4]">Link “{a.title}” and “{b.title}”?</p>
              <label htmlFor="link-note" className="text-[13.5px] text-[var(--dim)] block mt-3 mb-1.5">The thought that joins them — in your words (optional)</label>
              <textarea id="link-note" {...FIELDS.createLink.note} value={linkNote} onChange={(e) => setLinkNote(e.target.value)} rows={2} placeholder="Jung is like Pistorius, Hesse is Sinclair." className="w-full bg-[var(--well)] rounded-[14px] px-3.5 py-2.5 text-[15.5px] leading-[1.55] outline-none resize-none" />
              <div className="flex gap-2 mt-3">
                <button aria-label="Confirm link" disabled={createLinkMut.isPending} onClick={() => createLinkMut.mutate()} className="flex-1 rounded-full bg-[var(--text)] text-[var(--bg)] py-3 text-[15px] font-semibold min-h-[48px] disabled:opacity-40">{createLinkMut.isPending ? "Linking…" : "Link"}</button>
                <button aria-label="Cancel link" onClick={() => setPendingLink(null)} className="flex-1 rounded-full border border-[var(--border)] py-3 text-[15px] font-medium min-h-[48px]">Cancel</button>
              </div>
              {createLinkMut.isError && <p role="alert" className="text-[14px] text-[var(--red)] mt-2">That link didn’t save — try again.</p>}
            </div>
          );
        })()}
      </div>

      {/* Connections as labeled controls — every line is reachable without touch. */}
      {links.length > 0 && (
        <div className="px-6 mt-4">
          <p className="text-[13px] font-semibold text-[var(--faint)]">Connections</p>
          <div className="mt-1.5 flex flex-col">
            {links.map((l) => {
              const a = entries.find((e) => e.id === l.fromId);
              const b = entries.find((e) => e.id === l.toId);
              if (!a || !b) return null;
              return (
                <button key={l.id} aria-label={`Connection: ${a.title} and ${b.title}${l.note ? `. Your note: ${l.note}` : ""}`} onClick={() => { setSelectedLinkId(l.id); setSelectedId(null); centerOn(l.fromId); }} className="text-left py-2.5 border-t border-[var(--border)] first:border-t-0 text-[14.5px] leading-[1.45] min-h-[44px]">
                  <span className="font-medium">{a.title}</span> <span aria-hidden className="text-[var(--faint)]">—</span> <span className="font-medium">{b.title}</span>
                  {l.note && <span className="block text-[13.5px] text-[var(--dim)] mt-0.5">“{l.note}”</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function LinkNoteEditor({ link, onSave, saving }: { link: Link; onSave: (note: string) => void; saving: boolean }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(link.note);
  if (!editing) {
    return <button aria-label={link.note ? "Edit the note on this connection" : "Add a note to this connection"} onClick={() => { setNote(link.note); setEditing(true); }} className="mt-2 text-[14px] font-medium text-[var(--dim)] underline underline-offset-4 decoration-[var(--border)] min-h-[40px]">{link.note ? "Edit note" : "Add a note"}</button>;
  }
  return (
    <div className="mt-3">
      <label htmlFor={`link-note-edit-${link.id}`} className="sr-only">Note on this connection</label>
      <textarea id={`link-note-edit-${link.id}`} {...FIELDS.updateLink.note} value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full bg-[var(--well)] rounded-[14px] px-3.5 py-2.5 text-[15.5px] leading-[1.55] outline-none resize-none" />
      <div className="flex gap-2 mt-2">
        <button aria-label="Save connection note" disabled={saving} onClick={() => { onSave(note.trim()); setEditing(false); }} className="rounded-full bg-[var(--text)] text-[var(--bg)] px-5 py-2 text-[14px] font-semibold min-h-[40px] disabled:opacity-40">Save note</button>
        <button aria-label="Cancel editing note" onClick={() => setEditing(false)} className="rounded-full border border-[var(--border)] px-5 py-2 text-[14px] font-medium min-h-[40px]">Cancel</button>
      </div>
    </div>
  );
}

/* ---------------- A–Z index (kept from the previous Library) ---------------- */
const SCROLL_KEY = "curio.library.scroll";

function IndexView({ entries, onSelect }: { entries: Curio[]; onSelect: (id: number | null) => void }) {
  const [q, setQ] = useState("");

  useEffect(() => {
    const y = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0);
    if (y > 0) {
      const t = setTimeout(() => window.scrollTo(0, y), 60);
      return () => clearTimeout(t);
    }
  }, []);
  useEffect(() => {
    const onScroll = () => { try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch {} };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const searching = q.trim().length > 0;
  const results = useMemo(() => {
    if (!searching) return [];
    return entries.map((e) => ({ e, s: scoreEntry(e, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title)).map((x) => x.e);
  }, [entries, q, searching]);

  const groups = useMemo(() => {
    const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
    const map = new Map<string, Curio[]>();
    for (const e of sorted) {
      const letter = (e.title.trim()[0] ?? "#").toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : "#";
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  return (
    <div>
      <div className="mt-4 sticky top-0 bg-[var(--bg)]/90 backdrop-blur-xl py-2 z-20">
        <label htmlFor="lib-search" className="sr-only">Search your encyclopedia</label>
        <input id="lib-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, your questions, explanations…" className="w-full bg-[var(--fill)] border-none rounded-full px-5 py-3.5 text-[17px] outline-none placeholder:text-[var(--faint)] min-h-[52px]" />
        {searching && <p className="text-[14px] text-[var(--faint)] mt-2 px-1" role="status">{results.length === 0 ? "No matches — try the words you’d use to describe the idea." : `${results.length} ${results.length === 1 ? "match" : "matches"}, best first`}</p>}
      </div>

      {searching ? (
        <div>
          {results.map((e) => <IndexRow key={e.id} entry={e} onOpen={() => onSelect(e.id)} />)}
        </div>
      ) : (
        <div className="relative pr-5">
          {groups.map(([letter, items]) => (
            <section key={letter} aria-label={`Entries starting with ${letter}`}>
              <h2 id={`letter-${letter}`} className="font-display text-[15px] font-bold text-[var(--faint)] pt-7 pb-1 scroll-mt-24">{letter}</h2>
              <div>{items.map((e) => <IndexRow key={e.id} entry={e} onOpen={() => onSelect(e.id)} />)}</div>
            </section>
          ))}
          <div className="fixed right-1.5 top-1/2 -translate-y-1/2 flex flex-col items-center z-20" aria-label="Alphabet index">
            {groups.map(([letter]) => (
              <button key={letter} aria-label={`Jump to ${letter}`} onClick={() => document.getElementById(`letter-${letter}`)?.scrollIntoView({ behavior: "smooth", block: "start" })} className="text-[11px] font-semibold text-[var(--dim)] w-6 min-h-[20px] py-0">{letter}</button>
            ))}
          </div>
          <p className="text-[14px] text-[var(--faint)] mt-10">{entries.length} {entries.length === 1 ? "entry" : "entries"} · A–Z</p>
        </div>
      )}
    </div>
  );
}

function IndexRow({ entry, onOpen }: { entry: Curio; onOpen: () => void }) {
  return (
    <button aria-label={`Open entry: ${entry.title}`} onClick={onOpen} className="w-full text-left py-4 border-t border-[var(--border)] first:border-t-0 flex items-start gap-3 min-h-[64px]">
      {entry.hasPhoto && entry.photoUrl ? (
        <img src={entry.photoUrl} alt="" className="w-11 h-11 rounded-[10px] object-cover shrink-0 mt-0.5" />
      ) : (
        <span aria-hidden className="w-11 h-11 rounded-[10px] shrink-0 mt-0.5 flex items-center justify-center" style={{ background: `${catColor(entry.category)}1F` }}>
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: catColor(entry.category) }} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="font-display text-[18px] font-bold leading-[1.3] truncate">{entry.title}</span>
          {entry.isFavorite && <span aria-hidden className="text-[var(--gold)] shrink-0">★</span>}
        </span>
        <span className="block text-[15px] leading-[1.5] text-[var(--dim)] truncate mt-0.5">“{entry.rawInput}”</span>
        <span className="block text-[13px] text-[var(--faint)] mt-1">{entry.category} · {new Date(entry.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}{entry.followups.length > 0 ? ` · ${entry.followups.length} follow-up${entry.followups.length > 1 ? "s" : ""}` : ""}</span>
      </span>
      <span aria-hidden className="text-[var(--faint)] text-[20px] leading-none mt-3 shrink-0">›</span>
    </button>
  );
}

/* The words on a no-photo entry's map note — chosen by the user, not Curio. */
function MapNoteEditor({ entry, invalidate, setError }: { entry: Curio; invalidate: () => void; setError: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(entry.mapLabel);
  const save = useMutation({
    mutationFn: async () => await api.updateEntry({ id: entry.id, mapLabel: words.trim() }),
    onSuccess: () => { setEditing(false); invalidate(); },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't save those words."),
  });
  return (
    <div className="mt-10">
      <p className="text-[14px] font-semibold mb-2">On the map</p>
      {editing ? (
        <div>
          <label htmlFor="map-note-words" className="text-[14px] text-[var(--dim)] block mb-2">The few words on this entry’s note — the ones you’ll recognize it by. Leave blank to use your question.</label>
          <input id="map-note-words" {...FIELDS.updateEntry.mapLabel} value={words} onChange={(e) => setWords(e.target.value)} placeholder={noteWords({ ...entry, mapLabel: "" })} className="w-full bg-[var(--well)] rounded-[16px] px-4 py-3 text-[16px] outline-none min-h-[48px]" />
          <div className="flex gap-2 mt-3">
            <button aria-label="Save map note words" disabled={save.isPending} onClick={() => save.mutate()} className="rounded-full bg-[var(--text)] text-[var(--bg)] px-5 py-2.5 text-[15px] font-semibold min-h-[44px] disabled:opacity-40">Save words</button>
            <button aria-label="Cancel editing map note" onClick={() => { setEditing(false); setWords(entry.mapLabel); }} className="rounded-full border border-[var(--border)] px-5 py-2.5 text-[15px] font-medium min-h-[44px]">Cancel</button>
          </div>
        </div>
      ) : (
        <p className="text-[15.5px] leading-[1.6] text-[var(--dim)]">
          Its note reads “{noteWords(entry)}”.{" "}
          <button aria-label="Change the words on the map note" onClick={() => { setWords(entry.mapLabel); setEditing(true); }} className="font-medium text-[var(--text)] underline underline-offset-4 decoration-[var(--border)] min-h-[40px]">Change the words</button>
        </p>
      )}
    </div>
  );
}

/* ---------------- One entry, opened from the index ---------------- */
function EntryDetail({ entry, links = [], entries = [], onOpenEntry, onBack, invalidate }: { entry: Curio; links?: Link[]; entries?: Curio[]; onOpenEntry?: (id: number) => void; onBack: () => void; invalidate: () => void }) {
  const [error, setError] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(entry.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);

  const upd = useMutation({ mutationFn: async (args: { isFavorite?: boolean }) => await api.updateCurio({ id: entry.id, ...args }), onSuccess: invalidate, onError: () => {} });
  const rename = useMutation({
    mutationFn: async () => await api.updateEntry({ id: entry.id, title: titleDraft.trim() }),
    onSuccess: () => { setEditingTitle(false); invalidate(); },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't rename."),
  });
  const del = useMutation({ mutationFn: async () => await api.deleteCurio({ id: entry.id }), onSuccess: () => { invalidate(); onBack(); }, onError: () => {} });
  const [followups, setFollowups] = useState<Pair[]>(entry.followups);
  useEffect(() => { setFollowups(entry.followups); }, [entry.followups]);

  return (
    <div>
      <div className="pt-6 flex items-center justify-between">
        <button aria-label="Back to Library index" onClick={onBack} className="text-[17px] font-medium min-h-[44px] pr-3 -ml-1">‹ Library</button>
        <button aria-label={entry.isFavorite ? `Unfavorite ${entry.title}` : `Favorite ${entry.title}`} onClick={() => upd.mutate({ isFavorite: !entry.isFavorite })} className={`text-[26px] leading-none min-w-[44px] min-h-[44px] ${entry.isFavorite ? "text-[var(--gold)]" : "text-[var(--faint)]"}`}>{entry.isFavorite ? "★" : "☆"}</button>
      </div>

      <p className="flex items-center gap-2 text-[14px] text-[var(--dim)] mt-4">
        <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: catColor(entry.category) }} />
        <span className="font-medium text-[var(--text)]">{entry.category}</span>
        <span aria-hidden>·</span><span>{new Date(entry.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span>
      </p>

      {editingTitle ? (
        <div className="mt-3">
          <label htmlFor="rename-title" className="sr-only">Entry title</label>
          <input id="rename-title" {...FIELDS.updateEntry.title} value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} className="w-full bg-[var(--well)] rounded-[16px] px-4 py-3.5 font-display text-[26px] font-bold outline-none min-h-[56px]" />
          <div className="flex gap-2 mt-3">
            <button aria-label="Save new title" disabled={!titleDraft.trim() || rename.isPending} onClick={() => rename.mutate()} className="rounded-full bg-[var(--text)] text-[var(--bg)] px-5 py-2.5 text-[15px] font-semibold min-h-[44px] disabled:opacity-40">Save title</button>
            <button aria-label="Cancel rename" onClick={() => { setEditingTitle(false); setTitleDraft(entry.title); }} className="rounded-full border border-[var(--border)] px-5 py-2.5 text-[15px] font-medium min-h-[44px]">Cancel</button>
          </div>
        </div>
      ) : (
        <h1 className="font-display text-[32px] leading-[1.15] font-bold mt-3">{entry.title}
          <button aria-label={`Rename ${entry.title}`} onClick={() => { setTitleDraft(entry.title); setEditingTitle(true); }} className="text-[15px] font-medium text-[var(--dim)] underline underline-offset-4 decoration-[var(--border)] ml-3 align-middle min-h-[44px]">Rename</button>
        </h1>
      )}

      {entry.hasPhoto && entry.photoUrl && (
        <figure className="mt-6">
          <button aria-label={photoOpen ? "Collapse the source photo" : "Enlarge the source photo"} onClick={() => setPhotoOpen(!photoOpen)} className="w-full">
            <img src={entry.photoUrl} alt="The photo you captured for this entry" className={`w-full rounded-[20px] ${photoOpen ? "" : "max-h-56 object-cover"}`} />
          </button>
          <figcaption className="text-[13px] text-[var(--faint)] mt-2">Your original photo — tap to {photoOpen ? "shrink" : "see it full size"}.</figcaption>
        </figure>
      )}

      {entry.sourceText && (
        <div className="mt-8">
          <p className="text-[14px] font-semibold mb-2">The author’s words</p>
          <blockquote className="border-l-2 border-[var(--border)] pl-4 text-[17px] leading-[1.7] italic text-[var(--dim)] whitespace-pre-wrap">{entry.sourceText}</blockquote>
        </div>
      )}
      {entry.unreadableNote && (
        <p className="mt-6 text-[15px] leading-[1.65] rounded-[16px] bg-[var(--fill)] px-4 py-3"><span className="font-semibold">Hard to read:</span> {entry.unreadableNote}</p>
      )}

      <p className="text-[15px] leading-relaxed text-[var(--faint)] mt-8">You asked: “{entry.rawInput}”</p>

      <div className="mt-4">
        <p className="text-[14px] font-semibold mb-2">Curio’s explanation</p>
        {entry.needsRetry && <p className="text-[15px] leading-relaxed text-[var(--red)] mb-2">The explanation didn’t come through when you captured this.</p>}
        <p className="text-[18px] leading-[1.8]">{entry.simpleAnswer}</p>
        {entry.whyItMatters && <p className="text-[16px] leading-[1.7] text-[var(--dim)] mt-4">{entry.whyItMatters}</p>}
        {entry.connections.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {entry.connections.map((c, i) => <li key={i} className="text-[16px] leading-[1.6] text-[var(--dim)] flex gap-2.5"><span aria-hidden style={{ color: catColor(entry.category) }}>—</span><span>{c}</span></li>)}
          </ul>
        )}
      </div>

      <FollowUpList pairs={followups} />
      <FollowUpForm
        entryId={entry.id}
        context={{ title: entry.title, originalQuestion: entry.rawInput, simpleAnswer: entry.simpleAnswer, sourceText: entry.sourceText }}
        suggestion={followups.length === 0 ? entry.followUp : ""}
        onAnswer={(_q, _a, all) => { if (all) setFollowups(all); invalidate(); }}
        setError={setError}
      />

      {error && <p role="alert" className="mt-5 text-[16px] leading-relaxed text-[var(--red)]">{error}</p>}

      {(() => {
        const mine = links.filter((l) => l.fromId === entry.id || l.toId === entry.id);
        if (mine.length === 0) return null;
        return (
          <div className="mt-10">
            <p className="text-[14px] font-semibold mb-2">Connected on your map</p>
            <div className="flex flex-col">
              {mine.map((l) => {
                const other = entries.find((e) => e.id === (l.fromId === entry.id ? l.toId : l.fromId));
                if (!other) return null;
                return (
                  <div key={l.id} className="py-3 border-t border-[var(--border)] first:border-t-0">
                    <button aria-label={`Open connected entry: ${other.title}`} onClick={() => onOpenEntry?.(other.id)} className="font-display text-[17px] font-bold text-left min-h-[40px]">{other.title} ›</button>
                    {l.note && <p className="text-[15px] leading-[1.6] text-[var(--dim)] mt-0.5">“{l.note}” <span className="text-[13px] text-[var(--faint)]">— your words</span></p>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {!entry.hasPhoto && <MapNoteEditor entry={entry} invalidate={invalidate} setError={setError} />}

      <div className="mt-12 pt-6 border-t border-[var(--border)]">
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <p className="text-[15px] flex-1">Delete this entry for good?</p>
            <button aria-label="Confirm delete entry" onClick={() => del.mutate()} className="rounded-full bg-[var(--red)] text-white px-5 py-2.5 text-[15px] font-semibold min-h-[44px]">Delete</button>
            <button aria-label="Cancel delete" onClick={() => setConfirmDelete(false)} className="rounded-full border border-[var(--border)] px-5 py-2.5 text-[15px] font-medium min-h-[44px]">Keep</button>
          </div>
        ) : (
          <button aria-label={`Delete ${entry.title}`} onClick={() => setConfirmDelete(true)} className="text-[15px] text-[var(--red)] min-h-[44px]">Delete entry</button>
        )}
      </div>
    </div>
  );
}
