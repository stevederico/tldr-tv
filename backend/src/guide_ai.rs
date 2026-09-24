//! xAI and Unsplash calls for guide enrichment, plus local chapter timing.
//!
//! Outbound calls go through [`crate::httpc`] (system libcurl). A circuit
//! breaker stops the process after three consecutive transport or 5xx failures.
//! Retries wait 1s, then 2s, then 4s.

use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::Duration;

use crate::config;
use crate::httpc::{self, HttpResponse};
use crate::json::{self, Json};

const CHAT_URL: &str = "https://api.x.ai/v1/chat/completions";
const IMAGE_URL: &str = "https://api.x.ai/v1/images/generations";
const CHAT_MODEL: &str = "grok-4.3";
const IMAGE_MODEL: &str = "grok-imagine-image-quality";
const TIMEOUT_MS: i64 = 90_000;
const MAX_ATTEMPTS: u32 = 4;
const BREAKER_LIMIT: u32 = 3;
/// Pause between chapter image calls so a guide does not burst the image API.
const IMAGE_GAP: Duration = Duration::from_millis(250);

static FAILURES: AtomicU32 = AtomicU32::new(0);

/// One chapter outline before times are attached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outline {
    /// Short headline.
    pub title: String,
    /// Verbatim phrase from the transcript.
    pub quote: String,
    /// One-sentence caption.
    pub caption: String,
}

/// Author, summary, and chapter outlines from one model call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Analysis {
    /// Author name, when the model was confident.
    pub author: Option<String>,
    /// Two or three paragraphs of summary.
    pub summary: String,
    /// Chapter outlines in transcript order. Times are not set yet.
    pub chapters: Vec<Outline>,
}

/// A timed word from Kokoro.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedWord {
    /// Token text.
    pub word: String,
    /// Start time in seconds.
    pub time: f64,
}

/// A chapter with a start time in seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedChapter {
    /// Start time. The first chapter is forced to 0.
    pub time: f64,
    /// Headline.
    pub title: String,
    /// Verbatim quote.
    pub quote: String,
    /// Caption.
    pub caption: String,
}

/// Ask Grok for author, summary, and chapter outlines.
///
/// # Errors
/// Missing key, a short transcript, a transport failure, or an empty summary.
pub fn analyze_transcript(transcript: &str, duration_sec: Option<i64>, source_url: Option<&str>) -> Result<Analysis, String> {
    let key = api_key()?;
    if transcript.chars().count() < 50 {
        return Err("Transcript too short".into());
    }
    let target = duration_sec
        .map(|secs| (secs / 180).clamp(6, 15))
        .unwrap_or(8);
    let prompt = build_prompt(transcript, target, source_url.unwrap_or(""));
    let body = json::stringify(&json::obj([
        ("model", json::s(CHAT_MODEL)),
        ("max_tokens", json::i(4096)),
        (
            "messages",
            Json::Arr(vec![json::obj([
                ("role", json::s("user")),
                ("content", json::s(prompt)),
            ])]),
        ),
    ]));
    let res = post_chat(&key, &body)?;
    let text = choice_text(&res).ok_or_else(|| "Empty model response".to_string())?;
    let parsed = parse_model_json(&text)?;
    let summary = parsed
        .get_str("summary")
        .unwrap_or("")
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .to_string();
    if summary.is_empty() {
        return Err("Empty summary from model".into());
    }
    let author = parsed
        .get_str("author")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let chapters = outlines_from(&parsed);
    Ok(Analysis { author, summary, chapters })
}

/// Ask Grok for chapter outlines only (the `chapters.js` prompt, not analyze).
///
/// # Errors
/// Missing key, a short transcript, a transport failure, or an empty array.
pub fn generate_chapters(transcript: &str, duration_sec: Option<i64>) -> Result<Vec<Outline>, String> {
    let key = api_key()?;
    if transcript.chars().count() < 50 {
        return Err("Transcript too short".into());
    }
    let secs = duration_sec.unwrap_or(0).max(0) as f64;
    let target = ((secs / 180.0).round() as i64).clamp(6, 15);
    let prompt = build_chapters_prompt(transcript, secs.round() as i64, target);
    let body = json::stringify(&json::obj([
        ("model", json::s(CHAT_MODEL)),
        ("max_tokens", json::i(4096)),
        (
            "messages",
            Json::Arr(vec![json::obj([
                ("role", json::s("user")),
                ("content", json::s(prompt)),
            ])]),
        ),
    ]));
    let res = post_chat(&key, &body)?;
    let text = choice_text(&res).ok_or_else(|| "Empty model response".to_string())?;
    let items = parse_chapters_array(&text)?;
    let chapters = items
        .iter()
        .filter_map(|item| {
            let title = item.get_str("title").unwrap_or("").trim().to_string();
            let quote = item.get_str("quote").unwrap_or("").trim().to_string();
            let caption = item.get_str("caption").unwrap_or("").trim().to_string();
            if title.is_empty() || quote.is_empty() {
                None
            } else {
                Some(Outline { title, quote, caption })
            }
        })
        .collect::<Vec<_>>();
    if chapters.is_empty() {
        return Err("No chapters generated".into());
    }
    Ok(chapters)
}

/// Match chapter quotes against word timings. Drops quotes that cannot be found.
pub fn attach_chapter_times(outlines: &[Outline], words: &[TimedWord]) -> Vec<TimedChapter> {
    if outlines.is_empty() || words.is_empty() {
        return Vec::new();
    }
    let mut cursor = 0;
    let mut out = Vec::new();
    for chapter in outlines {
        let Some((time, next)) = find_quote_time(words, &chapter.quote, cursor) else {
            continue;
        };
        out.push(TimedChapter {
            time,
            title: chapter.title.clone(),
            quote: chapter.quote.clone(),
            caption: chapter.caption.clone(),
        });
        cursor = next;
    }
    if let Some(first) = out.first_mut() {
        first.time = 0.0;
    }
    out
}

/// Download one Grok Imagine image.
///
/// # Errors
/// Missing key, a short prompt, or a failed generation or download.
pub fn generate_image(prompt: &str) -> Result<Vec<u8>, String> {
    let key = api_key()?;
    if prompt.chars().count() < 3 {
        return Err("Prompt too short".into());
    }
    let body = json::stringify(&json::obj([
        ("model", json::s(IMAGE_MODEL)),
        ("prompt", json::s(prompt)),
    ]));
    let res = post_retry(IMAGE_URL, &[("authorization", &format!("Bearer {key}"))], &body, TIMEOUT_MS)?;
    let parsed = json::parse(&res.body).map_err(|_| "Grok Imagine returned invalid JSON".to_string())?;
    let url = parsed
        .get("data")
        .and_then(Json::as_arr)
        .and_then(|items| items.first())
        .and_then(|item| item.get_str("url"))
        .ok_or_else(|| "Grok Imagine returned no image URL".to_string())?;
    thread::sleep(IMAGE_GAP);
    let image = httpc::get_follow(url, &[], TIMEOUT_MS).map_err(|e| e.0)?;
    if !image.ok() || image.body.is_empty() {
        return Err(format!("Image download {}", image.status));
    }
    Ok(image.body)
}

/// First Unsplash photo URL for `query`, if the key is set and a hit exists.
///
/// # Errors
/// Transport failures. A miss is `Ok(None)`.
pub fn unsplash_photo(query: &str, key: &str) -> Result<Option<String>, String> {
    let url = format!(
        "https://api.unsplash.com/search/photos?per_page=1&query={}",
        httpc::form_encode(query)
    );
    let auth = format!("Client-ID {key}");
    let res = httpc::get(&url, &[("Authorization", auth.as_str())], 15_000).map_err(|e| e.0)?;
    if !res.ok() {
        return Err(format!("Unsplash {}", res.status));
    }
    let parsed = json::parse(&res.body).map_err(|_| "Unsplash returned invalid JSON".to_string())?;
    let photo = parsed
        .get("results")
        .and_then(Json::as_arr)
        .and_then(|items| items.first())
        .and_then(|item| item.get("urls"))
        .and_then(|urls| urls.get_str("regular"))
        .map(str::to_string);
    Ok(photo)
}

/// File extension from image magic bytes.
pub fn image_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        "png"
    } else if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        "jpg"
    } else if bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        "webp"
    } else {
        "png"
    }
}

fn api_key() -> Result<String, String> {
    config::env_nonempty("XAI_API_KEY").ok_or_else(|| "XAI_API_KEY not set".to_string())
}

fn post_chat(key: &str, body: &str) -> Result<HttpResponse, String> {
    let header = format!("Bearer {key}");
    post_retry(CHAT_URL, &[("authorization", header.as_str())], body, TIMEOUT_MS)
}

fn post_retry(url: &str, headers: &[(&str, &str)], body: &str, timeout_ms: i64) -> Result<HttpResponse, String> {
    if FAILURES.load(Ordering::Relaxed) >= BREAKER_LIMIT {
        return Err("Upstream paused after repeated failures".into());
    }
    let mut last = String::from("upstream request failed");
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            thread::sleep(Duration::from_secs(1u64 << (attempt - 1)));
        }
        match httpc::post_json(url, headers, body, timeout_ms) {
            Ok(res) if res.ok() => {
                FAILURES.store(0, Ordering::Relaxed);
                return Ok(res);
            }
            Ok(res) if res.status == 429 || res.status >= 500 => {
                FAILURES.fetch_add(1, Ordering::Relaxed);
                last = format!("upstream {}", res.status);
            }
            Ok(res) => {
                FAILURES.fetch_add(1, Ordering::Relaxed);
                return Err(format!("upstream {}", res.status));
            }
            Err(err) => {
                FAILURES.fetch_add(1, Ordering::Relaxed);
                last = err.0;
            }
        }
    }
    Err(last)
}

fn choice_text(res: &HttpResponse) -> Option<String> {
    let parsed = json::parse(&res.body).ok()?;
    parsed
        .get("choices")
        .and_then(Json::as_arr)
        .and_then(|items| items.first())
        .and_then(|item| item.get("message"))
        .and_then(|message| message.get_str("content"))
        .map(str::to_string)
}

fn parse_model_json(raw: &str) -> Result<Json, String> {
    let trimmed = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let start = trimmed.find('{').ok_or("Model did not return JSON")?;
    let end = trimmed.rfind('}').ok_or("Model did not return JSON")?;
    json::parse(trimmed[start..=end].as_bytes()).map_err(|_| "Model returned invalid JSON".to_string())
}

fn outlines_from(parsed: &Json) -> Vec<Outline> {
    let Some(items) = parsed.get("chapters").and_then(Json::as_arr) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let title = item.get_str("title").unwrap_or("").trim().to_string();
            let quote = item.get_str("quote").unwrap_or("").trim().to_string();
            let caption = item.get_str("caption").unwrap_or("").trim().to_string();
            if title.is_empty() || quote.is_empty() {
                None
            } else {
                Some(Outline { title, quote, caption })
            }
        })
        .collect()
}

fn build_prompt(transcript: &str, chapter_target: i64, source_url: &str) -> String {
    let source = if source_url.is_empty() {
        String::new()
    } else {
        format!("\nSource URL (use this to identify the author): {source_url}\n")
    };
    format!(
        "Read the essay below and return ONLY a JSON object with fields author, summary, and chapters.\n\
author is a plain name or null. summary is 2-3 paragraphs, about 150 words, no markdown.\n\
chapters is an array of objects with title (2-6 words), quote (verbatim 4-12 words from the essay), \
and caption (one sentence, max 18 words). Aim for about {chapter_target} chapters. \
Chapter 1's quote must be the start of the essay. Quotes must appear in order.\n\
{source}\nReturn raw JSON only.\n\nEssay:\n\"\"\"\n{transcript}\n\"\"\""
    )
}

/// Prompt from `backend/tts/chapters.js` — chapters array only, not analyze.
fn build_chapters_prompt(transcript: &str, duration_sec: i64, target_chapters: i64) -> String {
    format!(
        "You are splitting an audio essay into chapters for a visual player.\n\n\
Total audio duration: {duration_sec}s. Aim for about {target_chapters} chapters.\n\n\
For each chapter, return:\n\
- \"title\": 2-6 words, headline style, no trailing punctuation\n\
- \"quote\": a verbatim phrase (4-12 words) copied EXACTLY from the transcript that opens that chapter. Must appear in the transcript exactly as written. This is the anchor used to compute the chapter's start time.\n\
- \"caption\": one sentence (max 18 words) summarizing what happens in this chapter\n\n\
Rules:\n\
- Chapter 1 must start at the beginning of the transcript.\n\
- Each \"quote\" must be a direct copy-paste from the transcript text below — no paraphrasing.\n\
- Quotes must appear in the order they occur in the transcript.\n\
- Return ONLY a JSON array, no prose, no markdown fences.\n\n\
Transcript:\n\
\"\"\"\n\
{transcript}\n\
\"\"\""
    )
}

fn parse_chapters_array(raw: &str) -> Result<Vec<Json>, String> {
    let mut text = raw.trim().to_string();
    if let Some(rest) = text.strip_prefix("```json").or_else(|| text.strip_prefix("```")) {
        text = rest.trim().to_string();
    }
    if let Some(rest) = text.strip_suffix("```") {
        text = rest.trim().to_string();
    }
    let start = text.find('[').ok_or("Model did not return an array")?;
    let end = text.rfind(']').ok_or("Model did not return an array")?;
    let parsed = json::parse(text[start..=end].as_bytes()).map_err(|_| "Model returned invalid JSON".to_string())?;
    match parsed {
        Json::Arr(items) => Ok(items),
        _ => Err("Model did not return an array".into()),
    }
}

fn find_quote_time(words: &[TimedWord], quote: &str, from: usize) -> Option<(f64, usize)> {
    let tokens: Vec<String> = norm(quote).split_whitespace().map(str::to_string).collect();
    if tokens.is_empty() || words.is_empty() {
        return None;
    }
    let probe = tokens.iter().take(3).cloned().collect::<Vec<_>>();
    let start = from.min(words.len());
    if words.len() >= probe.len() {
        for index in start..=words.len() - probe.len() {
            let matched = probe.iter().enumerate().all(|(offset, token)| norm(&words[index + offset].word) == *token);
            if matched {
                return Some((words[index].time, index + probe.len()));
            }
        }
    }
    let first = &tokens[0];
    for (index, word) in words.iter().enumerate().skip(start) {
        if norm(&word.word) == *first {
            return Some((word.time, index + 1));
        }
    }
    None
}

fn norm(value: &str) -> String {
    let mut out = String::new();
    let mut spaced = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            spaced = false;
        } else if !spaced && !out.is_empty() {
            out.push(' ');
            spaced = true;
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapter_times_follow_quotes_and_start_at_zero() {
        let words = vec![
            word("Alpha", 0.2),
            word("beta", 0.5),
            word("gamma", 1.0),
            word("delta", 1.4),
        ];
        let outlines = vec![
            Outline { title: "One".into(), quote: "Alpha beta".into(), caption: "c".into() },
            Outline { title: "Two".into(), quote: "gamma delta".into(), caption: "c".into() },
        ];
        let timed = attach_chapter_times(&outlines, &words);
        assert_eq!(timed.len(), 2);
        assert_eq!(timed[0].time, 0.0);
        assert_eq!(timed[1].time, 1.0);
    }

    #[test]
    fn drops_quotes_that_are_not_in_the_audio() {
        let words = vec![word("only", 0.1)];
        let outlines = vec![Outline { title: "Missing".into(), quote: "nowhere".into(), caption: "c".into() }];
        assert!(attach_chapter_times(&outlines, &words).is_empty());
    }

    fn word(text: &str, time: f64) -> TimedWord {
        TimedWord { word: text.into(), time }
    }
}
