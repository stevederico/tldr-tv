import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import GuideProgress from './GuideProgress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import Plus from '@stevederico/skateboard-ui/icons/Plus';
import X from '@stevederico/skateboard-ui/icons/X';
import Trash2 from '@stevederico/skateboard-ui/icons/Trash2';
import { toast } from '../toast';
import type { Guide } from '../utils/playerUtils';

/** Which source the create form is reading from. */
type SourceMode = 'url' | 'text';

/** Data collected from a URL fetch or pasted text, used to create a guide. */
interface SourceData {
  title: string;
  author: string;
  transcript: string;
  sourceUrl?: string;
  date?: string;
  thumbnail?: string;
  /** Internal: last auto-derived title, so user edits aren't clobbered. */
  _derivedTitle?: string;
}

/** The guide a delete confirmation is pending for. */
interface PendingDelete {
  slug: string;
  title: string;
}

/**
 * Format a duration in seconds as `h:mm:ss` or `m:ss`.
 *
 * @param sec - Duration in seconds.
 * @returns Formatted duration, or '' for falsy input.
 */
function fmtDuration(sec: number | undefined): string {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Normalize a stored date (raw ISO like `2026-07-13T13:35:12-05:00`, or free
 * text like `June 2026`) to one consistent card label: `MMM D, YYYY` when it
 * parses, else the trimmed original. Keeps the grid from showing a mix of raw
 * timestamps and prose.
 *
 * @param raw - Stored date string.
 * @returns Formatted date, or '' for empty input.
 */
function fmtDate(raw: string | undefined): string {
  if (!raw) return '';
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw.trim();
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const THUMB_PREFIX_RX = /^\.\.\//;

/** Resolve a stored thumbnail path (`../x` -> `/x`) for browser use. */
function resolveThumb(p: string | undefined): string {
  if (!p) return '';
  return p.replace(THUMB_PREFIX_RX, '/');
}

/**
 * Library home view: searchable grid of guides plus a create-guide modal that
 * accepts a URL or pasted text, kicks off the backend pipeline, and shows
 * progress before opening the player.
 *
 * @component
 * @returns The library view.
 */
export default function LibraryView() {
  const navigate = useNavigate();
  const [guides, setGuides] = useState<Guide[]>([]);
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('url');
  const [sourceUrl, setSourceUrl] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [fetching, setFetching] = useState(false);

  // Data collected from URL or pasted text
  const [sourceData, setSourceData] = useState<SourceData>({ title: '', author: '', transcript: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitLabel, setSubmitLabel] = useState('Create video');

  // After create, the modal flips into "progress" mode showing the GuideProgress stepper
  // so the user can kick off the remaining enrichment jobs (TTS, chapters, images, etc.)
  // before opening the player.
  const [createdGuide, setCreatedGuide] = useState<Guide | null>(null); // full guide payload returned by GET /:slug

  // Delete confirmation state — when set, a modal asks the user to confirm.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  const urlInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);

  async function load() {
    const res = await fetch('/api/guides');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setGuides(await res.json());
  }

  /**
   * Confirm deletion via the modal. Optimistically removes the card from the
   * grid and rolls back the change if the request fails.
   */
  async function confirmDelete() {
    if (!pendingDelete) return;
    const { slug } = pendingDelete;
    const prev = guides;
    setDeletingSlug(slug);
    setGuides(gs => gs.filter(x => x.slug !== slug));
    try {
      const res = await fetch(`/api/guides/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setPendingDelete(null);
    } catch (err) {
      console.error('Delete guide failed', err);
      setGuides(prev);
      toast.error((err instanceof Error ? err.message : String(err)) || 'Could not delete that video.');
    } finally {
      setDeletingSlug(null);
    }
  }

  useEffect(() => { load(); }, []);

  // Backend orchestrates the create-guide pipeline in the background. While any
  // guide in the library is still running, poll the list every 3s so cards flip
  // from "processing" to ready (or error) without a refresh.
  useEffect(() => {
    const hasRunning = guides.some(g => g.jobs?.pipeline?.status === 'running');
    if (!hasRunning) return;
    const id = setInterval(() => { load().catch(() => {}); }, 3000);
    return () => clearInterval(id);
  }, [guides]);

  // Dialog handles Escape + outside click internally via onOpenChange.

  // Auto-focus the correct input when modal opens or when switching between URL/Text mode
  useEffect(() => {
    if (!modalOpen) return;

    const timer = setTimeout(() => {
      if (sourceMode === 'url' && urlInputRef.current) {
        urlInputRef.current.focus();
        urlInputRef.current.select?.();
      } else if (sourceMode === 'text' && textInputRef.current) {
        textInputRef.current.focus();
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [modalOpen, sourceMode]);

  // In text mode, keep sourceData.transcript synced with the textarea and derive a default
  // title from the first long line (only when the title field is still empty / unedited).
  useEffect(() => {
    if (sourceMode !== 'text') return;
    const trimmed = pastedText.trim();
    if (!trimmed) {
      setSourceData(d => (d.transcript ? { title: '', author: '', transcript: '' } : d));
      return;
    }
    setSourceData(d => {
      const firstLine = pastedText.split('\n').find(l => l.trim().length > 12) || 'Untitled Video';
      const derivedTitle = firstLine.trim().slice(0, 140);
      // Preserve any title the user has edited (different from the previously-derived value)
      const title = d.title && d.title !== d._derivedTitle ? d.title : derivedTitle;
      return { ...d, title, transcript: trimmed, _derivedTitle: derivedTitle };
    });
  }, [pastedText, sourceMode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return guides;
    return guides.filter(g =>
      g.title.toLowerCase().includes(q) || (g.author || '').toLowerCase().includes(q)
    );
  }, [guides, query]);

  function resetCreateForm() {
    setSourceMode('url');
    setSourceUrl('');
    setPastedText('');
    setFetching(false);
    setSourceData({ title: '', author: '', transcript: '' });
    setCreatedGuide(null);
    setSubmitLabel('Create video');
  }

  // Refetch the full guide payload so the GuideProgress component sees newly-produced
  // fields (audio, timing, chapters, etc.) after each enrichment step.
  async function refreshCreatedGuide() {
    if (!createdGuide?.slug) return;
    try {
      const res = await fetch(`/api/guides/${encodeURIComponent(createdGuide.slug)}`);
      if (!res.ok) return;
      const g = await res.json();
      setCreatedGuide(g);
    } catch {}
  }

  // Backend orchestrates the whole pipeline on create — poll the guide while
  // jobs.pipeline is running so the GuideProgress UI updates without any
  // per-step button clicks.
  useEffect(() => {
    if (!createdGuide?.slug) return;
    const status = createdGuide.jobs?.pipeline?.status;
    if (status && status !== 'running') return; // pipeline finished
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/guides/${encodeURIComponent(createdGuide.slug)}`);
        if (!res.ok) return;
        const g = await res.json();
        setCreatedGuide(g);
      } catch {}
    }, 2500);
    return () => clearInterval(id);
  }, [createdGuide?.slug, createdGuide?.jobs?.pipeline?.status]);

  // === New source-first create flow ===

  // Reusable fetch that returns data (now calls our backend for reliable extraction)
  async function fetchFromUrl(url: string): Promise<SourceData> {
    const res = await fetch('/api/fetch-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim() }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(json.error || 'Failed to fetch the page');
    }

    return {
      title: json.title || 'Untitled Video',
      author: json.author || '',
      transcript: json.transcript || '',
      sourceUrl: json.sourceUrl || url.trim(),
      date: json.date || '',
      thumbnail: json.thumbnail || '',
    };
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    setSubmitting(true);

    try {
      let data: SourceData = { ...sourceData };

      // Auto-fetch for URL mode inside the Create button
      if (sourceMode === 'url' && sourceUrl.trim() && !data.transcript) {
        setSubmitLabel('Fetching content…');
        data = await fetchFromUrl(sourceUrl);
        setSourceData(data);
      }

      // Auto-prepare from pasted text
      if (sourceMode === 'text' && pastedText.trim() && !data.transcript) {
        const firstLine = pastedText.split('\n').find(l => l.trim().length > 12) || 'Untitled Video';
        data = {
          title: firstLine.trim().slice(0, 140),
          author: '',
          transcript: pastedText.trim(),
        };
        setSourceData(data);
      }

      if (!data.transcript) {
        throw new Error('Please enter a URL or paste some text');
      }

      setSubmitLabel('Creating…');

      const metadata = {
        title: data.title || 'Untitled Video',
        author: data.author || null,
        transcript: data.transcript,
        sourceUrl: data.sourceUrl || (sourceMode === 'url' ? sourceUrl.trim() : null),
        date: data.date || null,
        thumbnail: data.thumbnail || null,
      };

      const createRes = await fetch('/api/guides', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(metadata),
      });
      const createBody = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        const msg = createBody?.error || `Failed (HTTP ${createRes.status})`;
        throw new Error(msg);
      }

      // Backend orchestrates the rest. Close the modal immediately and let the
      // library grid show the new guide as "processing" until the pipeline finishes.
      await load();
      setModalOpen(false);
      resetCreateForm();
    } catch (err) {
      console.error('Create guide failed', err);
      toast.error((err instanceof Error ? err.message : String(err)) || 'Something went wrong');
      setSubmitLabel('Create video');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <header className="sticky top-0 z-30 bg-[var(--nav-bg)] backdrop-blur-md backdrop-saturate-150 border-b border-border grid grid-cols-[auto_auto] sm:grid-cols-[auto_1fr_auto] grid-rows-[auto_auto] sm:grid-rows-1 items-center gap-x-3 sm:gap-x-6 gap-y-3 py-3 sm:py-3.5 px-4 sm:px-7">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="relative inline-flex size-[26px] items-center justify-center rounded-[2px] bg-[var(--brand)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <line x1="0" y1="14" x2="14" y2="0" stroke="white" strokeWidth="1" />
            </svg>
          </span>
          <span className="font-[family-name:var(--font-grotesk)] font-extrabold text-[1.1rem] tracking-[-0.03em]">TLDR-TV</span>
        </div>
        <div className="max-w-[560px] w-full sm:justify-self-center col-span-2 sm:col-span-1 sm:col-start-2 row-start-2 sm:row-start-1 order-3 sm:order-none">
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search videos"
            className="w-full bg-card border border-border text-foreground px-4 py-2.5 rounded-[2px] text-[0.92rem] outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--brand)] focus:bg-muted"
          />
        </div>
        <button
          onClick={() => { resetCreateForm(); setModalOpen(true); }}
          aria-label="Create new video"
          className="justify-self-end inline-flex items-center gap-2 bg-[var(--brand)] text-white font-[family-name:var(--font-mono)] font-semibold uppercase tracking-wider text-[0.76rem] py-2.5 px-4 rounded-[2px] cursor-pointer transition-colors duration-150 hover:bg-[var(--brand-hot)]"
        >
          <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
          <span className="hidden sm:inline">Create</span>
        </button>
      </header>

      {filtered.length === 0 ? (
        <div className="py-20 px-7 text-center">
          <div className="font-[family-name:var(--font-grotesk)] font-extrabold text-[1.4rem] mb-1.5">No videos yet.</div>
          <div className="text-muted-foreground">Tap <strong>Create</strong> to add one.</div>
        </div>
      ) : (
        <main className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-x-4 sm:gap-x-[18px] gap-y-6 sm:gap-y-7 px-4 sm:px-7 pt-5 pb-[60px]">
          {filtered.map(g => {
            const pipe = g.jobs?.pipeline;
            const processing = pipe?.status === 'running';
            const failed = pipe?.status === 'failed';
            const stepLabels: Record<string, string> = {
              analyze: 'Analyzing transcript',
              thumbnail: 'Generating cover',
              tts: 'Synthesizing audio',
              'chapter-timing': 'Timing chapters',
              'chapter-images': 'Generating chapter images',
              'chapter-real-images': 'Finding chapter photos',
            };
            let processingLabel = 'Processing…';
            if (processing && g.jobs) {
              for (const key of ['chapter-real-images','chapter-images','chapter-timing','tts','thumbnail','analyze']) {
                if (g.jobs[key]?.status === 'running') { processingLabel = stepLabels[key]; break; }
              }
            }
            const cardProps = processing
              ? { onClick: (e: MouseEvent) => e.preventDefault(), tabIndex: -1, 'aria-disabled': true }
              : {};
            return (
            <a
              key={g.slug}
              href={`/app/${encodeURIComponent(g.slug)}`}
              target="_blank"
              rel="noopener noreferrer"
              {...cardProps}
              data-processing={processing || undefined}
              className="group/card bg-transparent border-none p-2.5 -m-2.5 rounded-[3px] text-left cursor-pointer text-inherit flex flex-col no-underline transition-colors duration-150 hover:bg-muted data-[processing]:opacity-85 [content-visibility:auto] [contain-intrinsic-size:0_320px]"
            >
              <div className="relative w-full aspect-video bg-muted border border-border rounded-[2px] overflow-hidden transition-[transform,box-shadow] duration-200 group-hover/card:-translate-y-0.5 group-hover/card:shadow-[0_12px_30px_rgba(0,0,0,0.4)] group-data-[processing]/card:pointer-events-none mb-3">
                {g.thumbnail && (
                  <img
                    loading="lazy"
                    alt=""
                    src={resolveThumb(g.thumbnail)}
                    className="w-full h-full object-cover block transition-transform duration-[350ms] group-hover/card:scale-[1.04]"
                  />
                )}
                {g.duration ? (
                  <span className="absolute right-2 bottom-2 bg-black/85 text-white font-[family-name:var(--font-mono)] tabular-nums text-[0.72rem] font-medium px-1.5 py-0.5 rounded-[1px]">
                    {fmtDuration(g.duration)}
                  </span>
                ) : null}
                {processing && (
                  <span
                    role="status"
                    aria-live="polite"
                    className="absolute left-2.5 right-2.5 bottom-2.5 text-[0.72rem] font-semibold text-center px-2.5 py-1.5 rounded-md backdrop-blur-[6px] bg-black/65 text-white before:content-[''] before:inline-block before:size-2.5 before:mr-2 before:rounded-full before:bg-[#facc15] before:align-middle before:animate-[status-pulse_1.4s_ease-out_infinite]"
                  >
                    {processingLabel}
                  </span>
                )}
                {failed && (
                  <span role="alert" className="absolute left-2.5 right-2.5 bottom-2.5 text-[0.72rem] font-semibold text-center px-2.5 py-1.5 rounded-md backdrop-blur-[6px] bg-red-900/95 text-white">
                    Failed: {pipe?.error || 'unknown error'}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Delete ${g.title}`}
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setPendingDelete({ slug: g.slug, title: g.title });
                  }}
                  className="absolute top-2 right-2 size-8 inline-flex items-center justify-center bg-black/70 text-white border-none rounded-lg cursor-pointer opacity-0 -translate-y-0.5 transition-[opacity,transform,background-color] duration-150 backdrop-blur-[6px] z-[2] group-hover/card:opacity-100 group-hover/card:translate-y-0 focus-visible:opacity-100 focus-visible:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 hover:bg-red-800/95"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
              <h3 className="font-[family-name:var(--font-grotesk)] font-bold text-[1.15rem] tracking-[-0.01em] leading-[1.2] mt-0 mb-2 text-foreground line-clamp-2">{g.title}</h3>
              <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
                {g.author && <span className="font-[family-name:var(--font-mono)] uppercase tracking-wider text-[0.7rem] text-muted-foreground truncate">{g.author}</span>}
                {g.date && <span className="font-[family-name:var(--font-mono)] tabular-nums text-[0.7rem] text-muted-foreground shrink-0">{fmtDate(g.date)}</span>}
              </div>
            </a>
            );
          })}
        </main>
      )}

      <Dialog
        open={modalOpen}
        onOpenChange={open => { if (!open) { setModalOpen(false); resetCreateForm(); } }}
      >
        <DialogContent
          showCloseButton={false}
          className="bg-card border-border p-0 gap-0 overflow-hidden sm:max-w-[560px] sm:rounded-2xl max-sm:!w-screen max-sm:!max-w-none max-sm:!h-[100dvh] max-sm:!rounded-none max-sm:!border-0 max-sm:!top-0 max-sm:!left-0 max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!ring-0 max-sm:flex max-sm:flex-col"
        >
          <form autoComplete="off" onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 max-sm:h-full">
            <DialogHeader className="flex-row items-center justify-between py-4 px-5 border-b border-border gap-0">
              <DialogTitle className="font-[family-name:var(--font-grotesk)] font-extrabold text-[1.15rem] tracking-[-0.02em] m-0">
                {createdGuide ? 'Guide created' : 'New guide'}
              </DialogTitle>
              <button
                type="button"
                onClick={() => { setModalOpen(false); resetCreateForm(); }}
                aria-label="Close"
                className="bg-transparent border-none text-muted-foreground cursor-pointer p-1 rounded-md transition-colors hover:text-foreground hover:bg-muted"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </DialogHeader>
            <div className="px-5 py-4 flex flex-col gap-3.5 sm:max-h-[70vh] flex-1 overflow-y-auto">
              {createdGuide ? (
                <GuideProgress
                  slug={createdGuide.slug}
                  guide={createdGuide}
                  onRefresh={refreshCreatedGuide}
                />
              ) : (
              <>
              {/* Pure URL or Text flow — nothing else */}
              <div className="flex bg-secondary rounded-full p-[3px] mb-4 border border-border">
                {([
                  { mode: 'url' as const,  label: 'From URL' },
                  { mode: 'text' as const, label: 'Paste Text' },
                ]).map(({ mode, label }: { mode: SourceMode; label: string }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSourceMode(mode)}
                    data-active={sourceMode === mode || undefined}
                    className="flex-1 py-2 px-4 text-[13px] font-semibold rounded-full border-none bg-transparent text-secondary-foreground/70 cursor-pointer transition-colors hover:text-foreground data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm"
                  >
                    {label}
                  </button>
                ))}
              </div>

              {sourceMode === 'url' ? (
                <div className="mb-4">
                  <input
                    ref={urlInputRef}
                    type="url"
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    value={sourceUrl}
                    onChange={e => setSourceUrl(e.target.value)}
                    placeholder="https://example.com/article"
                    className="w-full border border-border bg-background text-foreground rounded-lg p-3 text-[15px] outline-none transition-colors focus:border-[var(--brand)]"
                  />
                </div>
              ) : (
                <div className="mb-4">
                  <textarea
                    ref={textInputRef}
                    value={pastedText}
                    onChange={e => setPastedText(e.target.value)}
                    rows={10}
                    placeholder="Paste the full article or essay text here..."
                    className="w-full border border-border bg-background text-foreground rounded-lg p-3 text-[15px] outline-none transition-colors focus:border-[var(--brand)] min-h-[180px] resize-y leading-normal"
                  />
                </div>
              )}

              </>
              )}
            </div>
            <DialogFooter className="flex-row justify-end gap-2.5 pt-3.5 pb-4 px-5 border-t border-border bg-background">
              {createdGuide ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setModalOpen(false); resetCreateForm(); }}
                    className="font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-transparent text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const slug = createdGuide.slug;
                      setModalOpen(false);
                      resetCreateForm();
                      navigate(`/app/${encodeURIComponent(slug)}`);
                    }}
                    className="font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-[var(--brand)] text-white shadow-[0_6px_20px_rgba(var(--brand-glow),0.35)] transition-colors hover:bg-[var(--brand-hot)] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    Open player
                  </button>
                </>
              ) : (
                <button
                  type="submit"
                  disabled={submitting || (sourceMode === 'url' ? !sourceUrl.trim() : !pastedText.trim())}
                  className="inline-flex items-center gap-2 font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-[var(--brand)] text-white shadow-[0_6px_20px_rgba(var(--brand-glow),0.35)] transition-colors hover:bg-[var(--brand-hot)] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitting && <Spinner className="size-4 text-white" />}
                  {submitLabel}
                </button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingDelete}
        onOpenChange={open => { if (!open && !deletingSlug) setPendingDelete(null); }}
      >
        <DialogContent
          showCloseButton={false}
          className="bg-card border-border p-0 gap-0 overflow-hidden sm:max-w-[460px] sm:rounded-2xl"
        >
          <DialogHeader className="flex-row items-center justify-between py-4 px-5 border-b border-border gap-0">
            <DialogTitle className="font-[family-name:var(--font-grotesk)] font-extrabold text-[1.15rem] tracking-[-0.02em] m-0">
              Delete video?
            </DialogTitle>
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              aria-label="Close"
              disabled={!!deletingSlug}
              className="bg-transparent border-none text-muted-foreground cursor-pointer p-1 rounded-md transition-colors hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </DialogHeader>
          <div className="px-5 py-4 flex flex-col gap-3.5">
            <DialogDescription className="m-0 text-foreground text-sm">
              <strong>{pendingDelete?.title}</strong> will be permanently removed. This can't be undone.
            </DialogDescription>
          </div>
          <DialogFooter className="flex-row justify-end gap-2.5 pt-3.5 pb-4 px-5 border-t border-border bg-background">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              disabled={!!deletingSlug}
              className="font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={!!deletingSlug}
              className="inline-flex items-center gap-2 font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-[#b91c1c] text-white transition-colors hover:bg-[#991b1b] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {deletingSlug && <Spinner className="size-4 text-white" />}
              {deletingSlug ? 'Deleting…' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
