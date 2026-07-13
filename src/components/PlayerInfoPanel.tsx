import type { Ref } from 'react';
import TranscriptView from './TranscriptView';
import type { NoteHighlightRange } from './TranscriptView';
import type { Chapter, Guide, TranscriptParagraph } from '../utils/playerUtils';

/** Which info-panel tab is active. */
export type PanelTab = 'summary' | 'chapters' | 'transcript' | 'notes';

const TAB_CLS =
  "relative font-[family-name:var(--font-mono)] text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground bg-transparent border-none py-2 px-1 cursor-pointer transition-colors hover:text-foreground data-[active]:text-foreground data-[active]:after:content-[''] data-[active]:after:absolute data-[active]:after:left-0 data-[active]:after:right-0 data-[active]:after:-bottom-px data-[active]:after:h-0.5 data-[active]:after:bg-[var(--brand)]";

/** Props for {@link PlayerInfoPanel}. */
export interface PlayerInfoPanelProps {
  /** Active tab. */
  panel: PanelTab;
  /** Set the active tab. */
  setPanel: (panel: PanelTab) => void;
  /** Chapter list. */
  chapters: Chapter[];
  /** Parsed transcript paragraphs (null when unavailable). */
  transcriptParas: TranscriptParagraph[] | null;
  /** Current guide (null while loading). */
  guide: Guide | null;
  /** Notes textarea contents. */
  notes: string;
  /** Update notes contents. */
  updateNotes: (value: string) => void;
  /** Index of the active chapter. */
  activeIdx: number;
  /** Jump playback to a chapter. */
  jumpToChapter: (chapter: Chapter, index: number) => void;
  /** Active word index for transcript highlighting. */
  activeWord: number;
  /** Seek to a word's time. */
  onWordClick: (wordIdx: number) => void;
  /** Ref attached to the active word span. */
  activeWordRef?: Ref<HTMLSpanElement>;
  /** Ref attached to the transcript scroll container. */
  transcriptScrollRef?: Ref<HTMLDivElement>;
  /** Format seconds as `m:ss`. */
  fmt: (sec: number | undefined | null) => string;
  /** Called when the user finishes a drag-selection in the transcript. */
  onTextSelected: (text: string, startIdx: number, endIdx: number) => void;
  /** Word range to re-highlight as a saved note. */
  highlightedNoteRange?: NoteHighlightRange | null;
}

/**
 * Tabbed info panel below the player: Summary, Chapters, Transcript, and Notes.
 *
 * @component
 * @returns The tabbed info panel.
 */
export default function PlayerInfoPanel({
  panel,
  setPanel,
  chapters,
  transcriptParas,
  guide,
  notes,
  updateNotes,
  activeIdx,
  jumpToChapter,
  activeWord,
  onWordClick,
  activeWordRef,
  transcriptScrollRef,
  fmt,
  onTextSelected,
  highlightedNoteRange,
}: PlayerInfoPanelProps) {
  return (
    <>
      <div className="py-2 flex items-center justify-between gap-3 border-b-2 border-foreground mb-3">
        <div className="inline-flex gap-6" role="tablist" aria-label="Panel">
          {([
            { key: 'summary' as const,    label: 'Summary',    show: true },
            { key: 'chapters' as const,   label: 'Chapters',   show: true },
            { key: 'transcript' as const, label: 'Transcript', show: !!guide?.transcript },
            { key: 'notes' as const,      label: 'Notes',      show: true },
          ]).filter((t: { key: PanelTab; label: string; show: boolean }) => t.show).map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={panel === t.key}
              data-active={panel === t.key || undefined}
              onClick={() => setPanel(t.key)}
              className={TAB_CLS}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {panel === 'chapters' && (
        <div>
          {chapters.map((c, i) => {
            const isActive = i === activeIdx;
            return (
              <div
                key={i}
                data-active={isActive || undefined}
                onClick={() => jumpToChapter(c, i)}
                className="group/chapter flex items-center gap-3.5 py-3 px-3 bg-transparent border-b border-border border-l-2 border-l-transparent cursor-pointer transition-[background-color,border-color,padding-left] duration-150 text-[0.92rem] font-medium w-full text-left text-foreground hover:bg-card hover:pl-4 data-[active]:bg-muted data-[active]:border-l-[var(--brand)]"
              >
                <div className="font-[family-name:var(--font-mono)] tabular-nums font-semibold text-muted-foreground w-[52px] shrink-0 text-[0.78rem] tracking-[0.02em] group-data-[active]/chapter:text-[var(--brand)]">
                  {fmt(c.time)}
                </div>
                <div className="flex-1 font-[family-name:var(--font-grotesk)] tracking-[-0.01em] group-data-[active]/chapter:font-bold">{c.title}</div>
              </div>
            );
          })}
        </div>
      )}

      {panel === 'summary' && (
        <div className="py-3.5 px-1.5 pb-6 font-['Manrope',system-ui,sans-serif]">
          {guide?.summary ? (
            <p className="text-[1.02rem] leading-[1.7] text-foreground m-0 tracking-[-0.005em] text-pretty">{guide.summary}</p>
          ) : (
            <div className="text-muted-foreground text-[0.95rem] py-2">No summary available for this guide yet.</div>
          )}
        </div>
      )}

      {panel === 'notes' && (
        <div className="py-3.5 px-1.5 pb-6">
          <textarea
            placeholder="Write your notes here…"
            value={notes}
            onChange={e => updateNotes(e.target.value)}
            aria-label="Notes for this guide"
            className="w-full min-h-[320px] resize-y bg-card text-foreground border border-border rounded-[3px] py-3.5 px-4 font-[family-name:var(--font-body)] text-base leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--brand)] focus:bg-muted"
          />
        </div>
      )}

      {panel === 'transcript' && (
        <div
          ref={transcriptScrollRef}
          className="h-[70vh] overflow-y-auto pt-2 px-1.5 pb-[60vh] font-['Literata',Charter,Georgia,serif] text-[1.15rem] scrollbar-thin"
        >
          {!guide ? (
            <div className="text-muted-foreground text-[0.95rem] py-3.5 px-1.5">Loading transcript…</div>
          ) : !transcriptParas ? (
            <div className="text-muted-foreground text-[0.95rem] py-3.5 px-1.5">Transcript unavailable.</div>
          ) : (
            <TranscriptView
              paras={transcriptParas}
              activeWord={activeWord}
              onWordClick={onWordClick}
              activeRef={activeWordRef}
              onTextSelected={onTextSelected}
              highlightedNoteRange={highlightedNoteRange}
            />
          )}
        </div>
      )}
    </>
  );
}
