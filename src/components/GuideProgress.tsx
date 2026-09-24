import { useEffect, useRef } from 'react';
import type { Guide, GuideJob } from '../utils/playerUtils';
import { mutationHeaders } from '../utils/api';

/** A single completeness step within a phase. */
interface ProgressStep {
  /** Unique step key. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Returns true when the field is already populated on the guide. */
  has: (g: Guide) => boolean;
  /** Endpoint suffix POST'd to /api/guides/:slug/<run> to produce this field. */
  run?: string;
  /** When true, the run returns 202 + a background job to poll. */
  pollWhileRunning?: boolean;
}

/** A grouped phase of completeness steps. */
interface ProgressPhase {
  /** Phase display name. */
  name: string;
  /** Steps in this phase. */
  steps: ProgressStep[];
}

/** Status of a step relative to the guide and any server job. */
type StepStatus = 'done' | 'running' | 'failed' | 'missing';

// Phases + steps that a "complete" guide needs.
// `has(g)` returns true when the field is already populated on the guide payload.
// `run` is the endpoint suffix POST'd to /api/guides/:slug/<run> to produce it.
// `pollWhileRunning` means the step returns 202 + a background job; poll the
// guide payload every POLL_INTERVAL_MS until guide.jobs[run].status flips to
// 'done' (then has() goes true) or 'failed'.
const POLL_INTERVAL_MS = 2500;

const PHASES: ProgressPhase[] = [
  {
    name: 'Text',
    steps: [
      { key: 'title',      label: 'Title',         has: g => !!g.title },
      { key: 'author',     label: 'Author',        has: g => !!g.author, run: 'analyze' },
      { key: 'date',       label: 'Date',          has: g => !!g.date, run: 'date' },
      { key: 'transcript', label: 'Transcript',    has: g => !!g.transcript },
      { key: 'summary',    label: 'Summary',       has: g => !!g.summary, run: 'analyze' },
    ],
  },
  {
    name: 'Audio',
    steps: [
      { key: 'audio',         label: 'Audio',              has: g => !!g.audio, run: 'tts', pollWhileRunning: true },
      { key: 'duration',      label: 'Duration',           has: g => !!g.duration },
      { key: 'timing',        label: 'Word timings',       has: g => ((!Array.isArray(g.timing) && g.timing?.words?.length) || 0) > 0 },
      { key: 'timingOffset',  label: 'Timing calibration', has: g => typeof g.timingOffset === 'number' },
    ],
  },
  {
    name: 'Chapters',
    steps: [
      { key: 'chapters',           label: 'Chapter outlines',     has: g => (g.chapters?.length || 0) > 0, run: 'analyze' },
      { key: 'chapter-timing',     label: 'Chapter times',        has: g => !!g.chapters?.length && (g.chapters.length === 1 || g.chapters.slice(1).every(c => Number(c.time) > 0)), run: 'chapter-timing' },
      { key: 'chapter-quotes',     label: 'Chapter quotes',       has: g => !!g.chapters?.length && g.chapters.every(c => c.quote) },
      { key: 'chapter-captions',   label: 'Chapter captions',     has: g => !!g.chapters?.length && g.chapters.every(c => c.caption) },
      { key: 'chapter-images',     label: 'Illustrative images',  has: g => !!g.chapters?.length && g.chapters.every(c => c.image?.generated), run: 'chapter-images', pollWhileRunning: true },
      { key: 'chapter-real-images',label: 'Real images',          has: g => !!g.chapters?.length && g.chapters.every(c => c.realImage), run: 'chapter-real-images', pollWhileRunning: true },
    ],
  },
  {
    name: 'Library',
    steps: [
      { key: 'thumbnail',       label: 'Cover thumbnail',  has: g => !!g.thumbnail, run: 'thumbnail' },
      { key: 'defaultViewMode', label: 'Default view',     has: g => !!g.defaultViewMode },
      { key: 'visibility',      label: 'Visibility',       has: g => !!g.visibility },
    ],
  },
];

/**
 * Resolve the display status of a step from the guide payload + any server job.
 *
 * @param step - The step descriptor.
 * @param guide - The current guide payload.
 * @returns Step status.
 */
function statusFor(step: ProgressStep, guide: Guide): StepStatus {
  if (step.has(guide)) return 'done';
  const serverJob = step.run ? guide.jobs?.[step.run] : null;
  if (serverJob?.status === 'running') return 'running';
  if (serverJob?.status === 'failed') return 'failed';
  return 'missing';
}

const STATUS_LABELS: Record<StepStatus, string> = {
  done: '✓',
  running: '…',
  failed: '✕',
  missing: '·',
};

const STATUS_ICON_STYLES: Record<StepStatus, string> = {
  done:    'bg-success/15 text-success',
  running: 'bg-warning/15 text-warning',
  failed:  'bg-destructive/20 text-destructive',
  missing: 'bg-muted text-muted-foreground',
};

/** Props for {@link GuideProgress}. */
export interface GuideProgressProps {
  /** Slug of the guide being built. */
  slug: string;
  /** The guide payload (or null while loading). */
  guide: Guide | null;
  /** Refetch callback to refresh the guide payload while polling. */
  onRefresh?: () => void;
}

/**
 * Step-by-step guide completeness panel with background-job polling.
 *
 * @component
 * @returns Completeness checklist, or null when there is no guide.
 */
export default function GuideProgress({ slug, guide, onRefresh }: GuideProgressProps) {
  const pollersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Stop any pollers on unmount or when slug changes.
  useEffect(() => {
    const pollers = pollersRef.current;
    return () => {
      for (const id of Object.values(pollers)) clearInterval(id);
    };
  }, [slug]);

  // If a server-side job is already running on mount (e.g. user refreshed mid-job),
  // start polling for it without an explicit button press.
  useEffect(() => {
    if (!guide?.jobs) return;
    for (const phase of PHASES) {
      for (const step of phase.steps) {
        if (!step.run || !step.pollWhileRunning) continue;
        if (guide.jobs[step.run]?.status === 'running' && !pollersRef.current[step.key]) {
          startPolling(step);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide?.jobs]);

  if (!guide) return null;

  function startPolling(step: ProgressStep) {
    if (pollersRef.current[step.key]) return;
    pollersRef.current[step.key] = setInterval(() => {
      onRefresh?.();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling(stepKey: string) {
    const id = pollersRef.current[stepKey];
    if (id) {
      clearInterval(id);
      delete pollersRef.current[stepKey];
    }
  }

  // When the guide payload says the job finished, stop polling and reflect the result.
  for (const phase of PHASES) {
    for (const step of phase.steps) {
      if (!step.pollWhileRunning) continue;
      const serverJob = step.run ? guide.jobs?.[step.run] : null;
      if (pollersRef.current[step.key] && serverJob && serverJob.status !== 'running') {
        stopPolling(step.key);
      }
    }
  }

  /**
   * Toggle the guide visibility to 'public'. Used by the Publish button when
   * the pipeline has finished.
   */
  async function publish() {
    const r = await fetch(`/api/guides/${encodeURIComponent(slug)}`);
    if (!r.ok) return;
    const g = await r.json();
    await fetch(`/api/guides`, {
      method: 'POST',
      headers: mutationHeaders(true),
      body: JSON.stringify({ ...g, visibility: 'public' }),
    });
    onRefresh?.();
  }

  const allDone = PHASES.every(p => p.steps.every(s => s.has(guide)));
  const anyRunning = PHASES.some(p => p.steps.some(s => {
    const sj = s.run ? guide.jobs?.[s.run] : null;
    return sj?.status === 'running';
  }));
  const totalSteps = PHASES.reduce((n, p) => n + p.steps.length, 0);
  const doneSteps = PHASES.reduce(
    (n, p) => n + p.steps.filter(s => s.has(guide)).length,
    0
  );

  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <div className="flex items-baseline justify-between pb-2 border-b border-border">
        <strong>Guide completeness</strong>
        <span className="text-muted-foreground tabular-nums">
          {doneSteps} / {totalSteps} {allDone ? '— complete' : anyRunning ? '— building…' : ''}
        </span>
        {allDone && guide.visibility !== 'public' && (
          <button
            type="button"
            onClick={publish}
            className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full border border-border bg-transparent text-foreground cursor-pointer transition-colors hover:bg-muted hover:border-foreground disabled:opacity-50 disabled:cursor-default"
          >
            Publish
          </button>
        )}
      </div>

      {PHASES.map(phase => (
        <div key={phase.name}>
          <div className="font-['Bricolage_Grotesque'] text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground mb-1.5">
            {phase.name}
          </div>
          <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
            {phase.steps.map(step => {
              const status = statusFor(step, guide);
              const serverJob: GuideJob | null | undefined = step.run ? guide.jobs?.[step.run] : null;
              const progress = status === 'running' && serverJob?.chunksTotal
                ? `${serverJob.chunksDone || 0}/${serverJob.chunksTotal}`
                : null;
              const serverError = status === 'failed' && serverJob?.error;
              const iconCls = STATUS_ICON_STYLES[status];
              const labelCls = status === 'missing' ? 'text-muted-foreground' : 'text-foreground';
              return (
                <li key={step.key} className="grid grid-cols-[22px_1fr_auto_auto] items-center gap-2.5 py-1.5 rounded-md">
                  <span
                    className={`inline-flex size-[18px] items-center justify-center rounded-full text-xs font-bold font-['Bricolage_Grotesque'] ${iconCls}`}
                    aria-hidden="true"
                  >
                    {STATUS_LABELS[status]}
                  </span>
                  <span className={labelCls}>{step.label}</span>
                  {progress && <span className="text-[11px] text-muted-foreground tabular-nums">{progress}</span>}
                  {status === 'running' && !progress && <span className="text-[11px] text-muted-foreground tabular-nums">running…</span>}
                  {serverError && (
                    <div className="col-start-2 -col-end-1 text-[11px] text-destructive mt-0.5">{serverError}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
