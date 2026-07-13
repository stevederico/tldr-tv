# Changelog

<!--
  Project changelog for Book Player.
  New versions go at the top. Present tense, 3 words or less per item.
  Dash-prefixed items = still open (todo list).
-->

0.103.0

  Editorial library redesign
  Swiss player redesign

0.102.0

  Fix contrast tokens
  Cobalt brand accent
  Add design fonts

0.101.0

  Stricter image gate
  Generate cover fallback

0.100.0

  Keep PG essay media

0.99.0

  Untrack generated audio

0.98.0

  Filter small images
  Prefer large srcset

0.97.0

  Read title first

0.96.0

  Re-render tracked audio

0.95.0

  Document TTS invariants
  Re-render old audio

0.94.0

  Drop punctuation splice
  Trust native pauses

0.93.0

  Fix MP3 seek header
  Backfill guide audio

0.92.0

  MSE stream playback
  Fix audio skipping

0.91.0

  Fix stuck start
  Recover to file

0.90.0

  Faster stream start

0.89.0

  Blue play icon

0.88.0

  Play button icon
  Transparent icon bg

0.87.0

  Flush stream encoder
  Buffer before play
  Rebuffer on stall

0.86.0

  Larger captions icon
  Drop settings caption

0.85.0

  PiP captions button
  Fix stream skipping

0.84.0

  Rename to Watch It

0.83.1

  Fix stream popping
  Gapless stream encode

0.83.0

  Stream caption timings
  Live streaming captions

0.82.3

  Add play flash
  Consolidate loading lines

0.82.2

  Hide stream duration
  Move link icon

0.82.1

  Fix frozen captions

0.82.0

  Stream TTS audio
  Fast playback start

0.81.0

  Add PiP captions
  Highlight words PiP
  Fix PiP progress
  Add PiP spinner

0.80.1

  Fix PiP audio

0.81.0

  Add auto-gen publisher todo

0.80.0

  Expand competitor research

0.79.0

  Add competitor research

0.78.0

  Prioritize open todos
  Add Watch article
  Convert todo checkboxes

0.77.0

  Agnostic start script
  Top-align transcript art
  Reset stale guide jobs

0.76.0

  Pipeline emits MP3
  Add wavToMp3 helper
  Regen need-to-read

0.75.0

  Rename lib to utils
  Unignore playerUtils module
  Unignore grokImagine module

0.74.0

  Compress brand-age MP3
  Add brand-age guide

0.73.0

  Fix modal toggle
  Unignore toast module
  Mount global Toaster
  Add new guide

0.72.0

  ⭐ Fix highlighter drift
  Drop concat crossfade
  Lead highlight 270ms
  Regen founder-mode
  Fix Plus import

0.71.0

  Add text size setting
  Inherit transcript font
  Scale with viewport

0.70.0

  Preserve punctuation tokens
  Native Kokoro pauses
  Normalize em dashes
  Persist normalized transcript
  Regen founder-mode

0.69.0

  Splice punctuation pauses
  Lead highlight 120ms
  Center transcript scroll
  Bottom scroll padding
  Hide title input

0.68.0

  Add breath padding
  Preserve paragraph breaks
  Regen good-writing-3

0.67.0

  Fix word highlighter
  Fix progress disconnect
  Rewrite TTS alignment
  Strip stress marks
  Center library search

0.66.0

  Transcript content-visibility
  Library content-visibility
  Passive scroll listeners
  Memoize chapters menu
  Hoist regexes
  Drop view-mode toggle
  Clean todo list

0.65.0

  Fix double-toggle play
  Restore overlay marker

0.64.0

  Fix play button click
  Fix timeline progress
  Revert 44px hit area

0.63.0

  Timeline 44px hit area
  Captions safe-area iOS
  Overlay safe-area iOS
  Hide volume mobile
  Coarse-pointer thumb

0.62.0

  Chapters bottom Sheet mobile
  Settings bottom Sheet mobile
  Gate outside-click effects
  44px touch rows

0.61.0

  PlayerView mobile split
  Hide split toggle mobile

0.60.0

  Library mobile grid
  Header wraps search
  Modal full-screen mobile
  URL keyboard hints

0.59.0

  Add useIsMobile hook
  Phase B foundation

0.58.0

  Delete pg.css
  Merge theme vars
  Phase A done

0.57.0

  Convert selection popup
  Drop selection-popup CSS

0.56.0

  Convert PlayerView hero
  Convert overlay timeline
  Convert yt-bar controls
  Convert captions feedback
  State via data-attrs
  Drop hero player CSS

0.55.0

  Fix Kokoro coarticulation
  Whole-text phonemize
  Smaller TTS chunks
  Crossfade chunk joins
  Cache-bust audio URL
  Summary tab default

0.54.0

  Convert PlayerInfoPanel
  Panel tabs Tailwind
  Drop chapter rule CSS

0.53.0

  Convert chapters menu
  Add scrollbar-thin utility
  Drop chapters popup CSS

0.52.0

  Convert PlayerSettings Tailwind
  Toggle via data-attrs
  Drop settings panel CSS

0.51.0

  Convert modal Tailwind
  Convert source toggle
  Convert title editor
  Convert delete dialog
  Drop modal CSS

0.50.0

  Convert LibraryView shell
  Extract animations CSS
  Drop top-nav grid CSS
  Drop card status CSS

0.49.0

  Convert TranscriptView Tailwind
  Drop transcript-para CSS
  Word state via data-attrs

0.48.0

  Convert GuideProgress Tailwind
  Drop guide-progress CSS

0.47.0

  Orchestrate full pipeline
  One Grok call
  Wire Kokoro TTS
  Add Grok Imagine
  Add jobs_json column
  Surface processing badge
  Close modal on submit
  Fix chunk size
  Extract source_url
  Extract date and og:image

0.46.0

  Boost switch contrast
  Promote todo priorities

0.45.0

  Hide overlay on leave
  Add guide pipeline UI
  Add URL source flow
  Add fetch-url endpoint
  Stub pipeline endpoints
  Toggle theme in settings
  Touch selection support
  Edit title in modal
  Refresh todo roadmap

0.44.0

  Add timeline drag scrubbing
  Continuous side transcript scroll
  Center active words in pane
  Improve split view roll

0.43.0

  Fix bottom transcript scroll
  Preserve article paragraphs
  Send kind metadata
  Add fetch timeout
  Sync notes anchors
  Decode HTML entities
  Gate marker hits
  Defer modal close
  Remove dead state
  Restore page title
  Stop marker autoplay
  Clear stale highlight
  Edit guide title
  Compose active highlight
  Add touch fallback

0.42.0

  Add drag-select notes in transcript
  Make note popup clickable
  Add custom note editor
  Change selection highlight to blue
  Remove popup close button

0.41.0

  Extract PlayerChaptersMenu component
  Extract PlayerInfoPanel component
  Extract PlayerSettings component
  Use TranscriptView in side pane
  Shrink PlayerView size

0.40.0

  Add favicon and PWA icon
  Support kind filters
  Enhance create flow
  Extract useTranscript hook
  Refactor PlayerView
  Update LibraryView and backend
  Bump version to 0.40.0

0.39.1
  Remove root redirect

0.39.0
  Fix constants branding and legal pages
  Redirect root to library
  Sync version and icon

## Prior

Initial scaffold from skateboard (constants were default SaaS template).
