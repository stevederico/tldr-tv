//! Guide catalog routes: library, player payload, create, and enrichment.
//!
//! Literal paths (`/api/guides`, `/api/tts`, `/api/fetch-url`) are registered
//! in `routes::dispatch` ahead of `/api/guides/:slug`. Suffixes such as
//! `stream.mp3` are matched here before the bare slug handler.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::article::{self, UrlError};
use crate::auth;
use crate::config::{self, Logger};
use crate::db::{self, GuideRecord, Pool, Value};
use crate::guide_ai::{self, Outline, TimedChapter, TimedWord};
use crate::http::{self, GrowingFileAction, GrowingFileBody, GrowingFileState, Request, Response};
use crate::json::{self, Json};
use crate::routes;
use crate::state::AppState;

const SLUG_MAX: usize = 80;
const TITLE_MAX: usize = 200;
const TTS_TEXT_MAX: usize = 20_000;
const AUDIO_MAX: usize = 25 * 1024 * 1024;
const CHAPTER_IMAGE_CAP: usize = 60;
const FETCH_TIMEOUT_MS: i64 = 15_000;
const STREAM_POLL_MS: u64 = 150;
const STREAM_MAX_IDLE_MS: u64 = 120_000;
const TTS_PARTS_CLEANUP_MS: u64 = 60_000;

/// `GET /api/guides` — public summaries, newest first.
pub fn list_guides(state: &AppState) -> Response {
    match state.pool.list_public_guides() {
        Ok(rows) => json_res(200, &Json::Arr(rows.iter().map(summary_json).collect())),
        Err(err) => {
            state.log.error("List guides error", &[("error", json::s(err.to_string()))]);
            err_json(500, "Failed to load guides")
        }
    }
}

/// `POST /api/guides` — create, or update when the slug already exists and the caller may write it.
pub fn create_guide(state: &AppState, req: &Request) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    let body = match json_body(req) {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(title) = text_field(&body, "title") else {
        return err_json(400, "Title required");
    };
    if title.chars().count() > TITLE_MAX {
        return err_json(400, "Title too long");
    }
    let explicit = text_field(&body, "slug");
    let base = explicit.clone().unwrap_or_else(|| slugify(&title));
    if !valid_slug(&base) {
        return err_json(400, "Invalid slug — use lowercase letters, numbers, and dashes");
    }
    match state.pool.get_guide(&base) {
        Ok(Some(existing)) => update_existing(state, existing, &body, actor.as_deref()),
        Ok(None) => insert_new(state, &base, &title, &body, actor, explicit.is_some()),
        Err(err) => {
            state.log.error("Create guide error", &[("error", json::s(err.to_string()))]);
            err_json(500, "Failed to create guide")
        }
    }
}

/// `POST /api/fetch-url` — download a public page and pull article text out of it.
pub fn fetch_url(_state: &AppState, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(raw) = text_field(&body, "url") else {
        return err_json(400, "URL is required");
    };
    let url = match article::public_http_url(&raw) {
        Ok(url) => url,
        Err(UrlError::Invalid) => return err_json(400, "Invalid URL"),
        Err(UrlError::Blocked) => return err_json(400, "Only http(s) URLs are supported"),
    };
    let page = match httpc_get(&url) {
        Ok(page) => page,
        Err(res) => return res,
    };
    let html = String::from_utf8_lossy(&page);
    match article::extract_article(&html, &url) {
        Ok(article) => json_res(200, &article_json(&article, &url)),
        Err("short") => err_json(422, "Could not extract readable text from the page"),
        Err(_) => err_json(500, "Failed to fetch or parse the page"),
    }
}

/// `POST /api/tts` — one-shot Kokoro synthesis. The body is JSON, not a guide row.
pub fn tts_once(state: &AppState, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(text) = text_field(&body, "text") else {
        return err_json(400, "Missing 'text'");
    };
    if text.chars().count() > TTS_TEXT_MAX {
        return err_json(413, "Text too long (max 20,000 chars)");
    }
    let voice = text_field(&body, "voice").unwrap_or_else(|| "af_heart".into());
    let speed = body.get("speed").and_then(Json::as_f64).map(|n| n.clamp(0.5, 2.0)).unwrap_or(1.0);
    let script = renderer(state);
    let payload = json::stringify(&json::obj([
        ("text", json::s(text)),
        ("voice", json::s(voice)),
        ("speed", json::n(speed)),
    ]));
    let stdout = match run_node(&script, &["wav"], &payload) {
        Ok(stdout) => stdout,
        Err(err) => {
            state.log.error("TTS error", &[("error", json::s(err))]);
            return err_json(500, "Failed to synthesize");
        }
    };
    let parsed = json::parse(stdout.trim().as_bytes()).unwrap_or(Json::Null);
    if parsed.get_str("audioBase64").is_none() {
        return err_json(500, "Failed to synthesize");
    }
    json_res(200, &parsed)
}

/// Dispatch `/api/guides/:slug` and `/api/guides/:slug/<suffix>`.
///
/// Known suffixes are literal and win over treating the whole path as a slug.
pub fn by_slug(state: &AppState, req: &Request) -> Response {
    let Some((slug, suffix)) = split_slug(&req.path) else {
        return Response::text(404, "404 Not Found");
    };
    if !valid_slug(slug) {
        return err_json(400, "Invalid slug");
    }
    match (req.method.as_str(), suffix) {
        ("GET", None) => get_guide(state, slug),
        ("DELETE", None) => delete_guide(state, req, slug),
        ("POST", Some("auto-chapters")) => auto_chapters(state, req, slug),
        ("POST", Some("analyze")) => analyze(state, req, slug),
        ("POST", Some("chapter-timing")) => chapter_timing(state, req, slug),
        ("POST", Some("summary")) => summary(state, req, slug),
        ("POST", Some("tts")) => start_tts(state, req, slug),
        ("GET" | "HEAD", Some("stream.mp3")) => stream_mp3(state, slug),
        ("POST", Some("date")) => refresh_date(state, req, slug),
        ("POST", Some("thumbnail")) => thumbnail(state, req, slug),
        ("POST", Some("chapter-images")) => start_chapter_images(state, req, slug),
        ("POST", Some("chapter-real-images")) => start_real_images(state, req, slug),
        ("POST", Some("audio")) => upload_audio(state, req, slug),
        _ => Response::text(404, "404 Not Found"),
    }
}

/// Serve `/audio/*` and `/images/*` from `backend/public`, honoring a single Range.
pub fn serve_media(state: &AppState, req: &Request) -> Response {
    let root = state.backend_dir.join("public");
    let Some(file) = http::serve_file(&root, &req.path) else {
        return Response::text(404, "404 Not Found");
    };
    apply_range(file, req.header("range"))
}

fn get_guide(state: &AppState, slug: &str) -> Response {
    match load_public(state, slug) {
        Ok(guide) => {
            let parts = tts_parts_dir(&state.backend_dir, slug);
            let partial = read_tts_timing(&parts);
            let mut detail = detail_json(&guide);
            if should_merge_stream_timing(&guide, partial.as_ref()) {
                if let Some(partial) = partial {
                    if let Json::Obj(map) = &mut detail {
                        map.insert("transcript".into(), json::s(partial.transcript));
                        map.insert(
                            "timing".into(),
                            json::obj([("words", Json::Arr(partial.words))]),
                        );
                    }
                }
            }
            json_res(200, &detail)
        }
        Err(res) => res,
    }
}

fn delete_guide(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    match state.pool.delete_guide(slug, actor.as_deref()) {
        Ok(0) => err_json(404, "Guide not found"),
        Ok(changes) => json_res(200, &json::obj([
            ("ok", Json::Bool(true)),
            ("slug", json::s(slug)),
            ("changes", json::i(changes as i64)),
        ])),
        Err(err) => {
            state.log.error("Delete guide error", &[("error", json::s(err.to_string()))]);
            err_json(500, "Failed to delete guide")
        }
    }
}

fn insert_new(state: &AppState, slug: &str, title: &str, body: &Json, actor: Option<String>, explicit: bool) -> Response {
    let slug = if explicit {
        slug.to_string()
    } else {
        match unique_slug(&state.pool, slug) {
            Ok(slug) => slug,
            Err(err) => {
                state.log.error("Create guide error", &[("error", json::s(err.to_string()))]);
                return err_json(500, "Failed to create guide");
            }
        }
    };
    let now = config::now_ms();
    let guide = record_from_body(&slug, title, body, actor.clone(), now, now);
    if let Err(err) = state.pool.insert_guide(&guide) {
        state.log.error("Create guide error", &[("error", json::s(err.to_string()))]);
        return err_json(500, "Failed to create guide");
    }
    let skip_images = body.get("skipImages").and_then(Json::as_bool).unwrap_or(false);
    spawn_pipeline(state, slug.clone(), skip_images);
    json_res(201, &json::obj([("slug", json::s(slug))]))
}

fn update_existing(state: &AppState, existing: GuideRecord, body: &Json, actor: Option<&str>) -> Response {
    if !caller_may_write(&existing, actor) {
        return json_res(409, &json::obj([
            ("error", json::s("A guide with this slug already exists")),
            ("slug", json::s(existing.slug.clone())),
        ]));
    }
    let mut guide = record_from_body(&existing.slug, &existing_title(&existing, body), body, existing.created_by.clone(), existing.created_at, config::now_ms());
    guide.audio_url = guide.audio_url.or(existing.audio_url);
    guide.timing_json = guide.timing_json.or(existing.timing_json);
    guide.jobs_json = guide.jobs_json.or(existing.jobs_json);
    if guide.chapters_json == "[]" && existing.chapters_json != "[]" {
        guide.chapters_json = existing.chapters_json;
    }
    match state.pool.update_guide(&guide, actor) {
        Ok(0) => err_json(404, "Guide not found"),
        Ok(_) => json_res(200, &json::obj([("slug", json::s(guide.slug))])),
        Err(err) => {
            state.log.error("Create guide error", &[("error", json::s(err.to_string()))]);
            err_json(500, "Failed to create guide")
        }
    }
}

fn existing_title(existing: &GuideRecord, body: &Json) -> String {
    text_field(body, "title").unwrap_or_else(|| existing.title.clone())
}

fn analyze(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    if let Err(res) = require_writable(state, slug, actor.as_deref()) {
        return res;
    }
    if let Err(err) = run_analyze(&state.pool, slug, &state.log) {
        return err_json(500, &err);
    }
    let Ok(Some(guide)) = state.pool.get_guide(slug) else {
        return err_json(404, "Guide not found");
    };
    let chapters = chapters_of(&guide)
        .into_iter()
        .map(|ch| {
            json::obj([
                ("title", json::s(ch.get_str("title").unwrap_or(""))),
                ("quote", json::s(ch.get_str("quote").unwrap_or(""))),
                ("caption", json::s(ch.get_str("caption").unwrap_or(""))),
            ])
        })
        .collect();
    json_res(200, &json::obj([
        ("author", opt_s(guide.author.as_deref())),
        ("summary", opt_s(guide.summary.as_deref())),
        ("chapters", Json::Arr(chapters)),
    ]))
}

fn summary(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    if let Err(res) = require_writable(state, slug, actor.as_deref()) {
        return res;
    }
    if let Err(err) = run_analyze(&state.pool, slug, &state.log) {
        return err_json(500, &err);
    }
    match state.pool.get_guide(slug) {
        Ok(Some(guide)) => json_res(200, &json::obj([("summary", opt_s(guide.summary.as_deref()))])),
        _ => err_json(404, "Guide not found"),
    }
}

fn auto_chapters(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    let guide = match require_writable(state, slug, actor.as_deref()) {
        Ok(guide) => guide,
        Err(res) => return res,
    };
    if guide.transcript.as_deref().unwrap_or("").is_empty() {
        return err_json(422, "Guide has no transcript");
    }
    let words = words_of(&guide);
    if words.is_empty() {
        return err_json(422, "Guide has no word timings");
    }
    let duration = guide.duration.or_else(|| words.last().map(|w| w.time.round() as i64));
    let outlines = match guide_ai::generate_chapters(guide.transcript.as_deref().unwrap_or(""), duration) {
        Ok(outlines) => outlines,
        Err(err) => return err_json(500, &err),
    };
    let timed = guide_ai::attach_chapter_times(&outlines, &words);
    if timed.is_empty() {
        return err_json(502, "No chapters generated");
    }
    let mut next = guide;
    next.chapters_json = json::stringify(&timed_json(&timed));
    next.updated_at = config::now_ms();
    if state.pool.update_guide(&next, actor.as_deref()).unwrap_or(0) == 0 {
        return err_json(404, "Guide not found");
    }
    json_res(200, &json::obj([("chapters", chapters_value(&next.chapters_json))]))
}

fn chapter_timing(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    if let Err(res) = require_writable(state, slug, actor.as_deref()) {
        return res;
    }
    if let Err(err) = run_chapter_timing(&state.pool, slug) {
        return err_json(500, &err);
    }
    match state.pool.get_guide(slug) {
        Ok(Some(guide)) => json_res(200, &json::obj([("chapters", chapters_value(&guide.chapters_json))])),
        _ => err_json(404, "Guide not found"),
    }
}

fn start_tts(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    let guide = match require_writable(state, slug, actor.as_deref()) {
        Ok(guide) => guide,
        Err(res) => return res,
    };
    if guide.transcript.as_deref().unwrap_or("").is_empty() {
        return err_json(422, "Guide has no transcript");
    }
    if job_running(&guide, "tts") {
        return json_res(202, &json::obj([
            ("jobId", json::s("tts")),
            ("status", json::s("running")),
            ("message", json::s("Already running")),
        ]));
    }
    let _ = merge_job(&state.pool, slug, "tts", &running_patch(0));
    let env = JobEnv::from_state(state);
    let owned = slug.to_string();
    spawn(env, move |env| run_tts_job(&env, &owned));
    json_res(202, &json::obj([("jobId", json::s("tts")), ("status", json::s("running"))]))
}

fn stream_mp3(state: &AppState, slug: &str) -> Response {
    let audio = state.backend_dir.join("public").join("audio").join(format!("{slug}.mp3"));
    if audio.is_file() {
        return Response::empty(302).header("Location", &format!("/audio/{slug}.mp3"));
    }
    let parts = tts_parts_dir(&state.backend_dir, slug);
    if read_tts_state(&parts).is_none() {
        return err_json(404, "Not generating");
    }
    let stream_file = parts.join("stream.mp3");
    Response::growing_file(
        200,
        "audio/mpeg",
        GrowingFileBody {
            path: stream_file,
            state_path: parts.join("state.json"),
            poll_ms: STREAM_POLL_MS,
            max_idle_ms: STREAM_MAX_IDLE_MS,
        },
    )
    .header("Cache-Control", "no-store")
    .header("X-Accel-Buffering", "no")
}

fn refresh_date(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    let guide = match require_writable(state, slug, actor.as_deref()) {
        Ok(guide) => guide,
        Err(res) => return res,
    };
    let Some(source) = guide.source_url.clone() else {
        return err_json(422, "Guide has no source_url");
    };
    let page = match httpc_get(&source) {
        Ok(page) => page,
        Err(res) => return res,
    };
    let html = String::from_utf8_lossy(&page);
    let Some(date) = article::extract_date_from_html(&html) else {
        return err_json(422, "No publication date found on source page");
    };
    let mut next = guide;
    next.date = Some(date.clone());
    next.updated_at = config::now_ms();
    if state.pool.update_guide(&next, actor.as_deref()).unwrap_or(0) == 0 {
        return err_json(404, "Guide not found");
    }
    json_res(200, &json::obj([("date", json::s(date))]))
}

fn thumbnail(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    let guide = match require_writable(state, slug, actor.as_deref()) {
        Ok(guide) => guide,
        Err(res) => return res,
    };
    if let Some(existing) = guide.thumbnail.clone().filter(|s| !s.is_empty()) {
        return json_res(200, &json::obj([("thumbnail", json::s(existing)), ("skipped", Json::Bool(true))]));
    }
    if guide.transcript.as_deref().unwrap_or("").is_empty() {
        return err_json(422, "Guide has no transcript");
    }
    match run_thumbnail(&state.pool, &state.backend_dir, slug, &state.log) {
        Ok(path) => json_res(200, &json::obj([("thumbnail", json::s(path))])),
        Err(err) => err_json(500, &err),
    }
}

fn start_chapter_images(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    let guide = match require_writable(state, slug, actor.as_deref()) {
        Ok(guide) => guide,
        Err(res) => return res,
    };
    let needed = chapters_missing_image(&guide);
    if chapters_of(&guide).is_empty() {
        return err_json(422, "Guide has no chapters");
    }
    if job_running(&guide, "chapter-images") {
        return json_res(202, &json::obj([("jobId", json::s("chapter-images")), ("status", json::s("running"))]));
    }
    if needed == 0 {
        return json_res(200, &json::obj([("skipped", Json::Bool(true)), ("message", json::s("All chapters already have images"))]));
    }
    if needed > CHAPTER_IMAGE_CAP {
        return err_json(422, &format!("Too many images ({needed} > cap {CHAPTER_IMAGE_CAP})"));
    }
    let _ = merge_job(&state.pool, slug, "chapter-images", &running_patch(needed));
    let env = JobEnv::from_state(state);
    let owned = slug.to_string();
    spawn(env, move |env| run_chapter_images(&env, &owned));
    json_res(202, &json::obj([("jobId", json::s("chapter-images")), ("status", json::s("running"))]))
}

fn start_real_images(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    if config::env_nonempty("UNSPLASH_ACCESS_KEY").is_none() {
        return err_json(500, "UNSPLASH_ACCESS_KEY not set");
    }
    let guide = match require_writable(state, slug, actor.as_deref()) {
        Ok(guide) => guide,
        Err(res) => return res,
    };
    if chapters_of(&guide).is_empty() {
        return err_json(422, "Guide has no chapters");
    }
    if job_running(&guide, "chapter-real-images") {
        return json_res(202, &json::obj([("jobId", json::s("chapter-real-images")), ("status", json::s("running"))]));
    }
    let needed = chapters_of(&guide).iter().filter(|ch| ch.get_str("realImage").is_none()).count();
    if needed == 0 {
        return json_res(200, &json::obj([("skipped", Json::Bool(true)), ("message", json::s("All chapters already have realImage"))]));
    }
    let _ = merge_job(&state.pool, slug, "chapter-real-images", &running_patch(needed));
    let env = JobEnv::from_state(state);
    let owned = slug.to_string();
    spawn(env, move |env| run_real_images(&env, &owned));
    json_res(202, &json::obj([("jobId", json::s("chapter-real-images")), ("status", json::s("running"))]))
}

fn upload_audio(state: &AppState, req: &Request, slug: &str) -> Response {
    let actor = match guard(state, req) {
        Ok(actor) => actor,
        Err(res) => return res,
    };
    let guide = match require_writable(state, slug, actor.as_deref()) {
        Ok(guide) => guide,
        Err(res) => return res,
    };
    let Some(content_type) = req.header("content-type") else {
        return err_json(400, "Missing 'audio' file field");
    };
    let bytes = match audio_field(content_type, &req.body) {
        Ok(bytes) => bytes,
        Err("type") => return err_json(415, "Unsupported content-type: unknown"),
        Err(_) => return err_json(400, "Missing 'audio' file field"),
    };
    if bytes.len() > AUDIO_MAX {
        return err_json(413, "File too large (max 25 MB)");
    }
    let dir = state.backend_dir.join("public").join("audio");
    if fs::create_dir_all(&dir).is_err() {
        return err_json(500, "Failed to upload audio");
    }
    let path = dir.join(format!("{slug}.mp3"));
    if fs::write(&path, &bytes).is_err() {
        return err_json(500, "Failed to upload audio");
    }
    let audio = format!("/audio/{slug}.mp3");
    let mut next = guide;
    next.audio_url = Some(audio.clone());
    next.updated_at = config::now_ms();
    if state.pool.update_guide(&next, actor.as_deref()).unwrap_or(0) == 0 {
        return err_json(404, "Guide not found");
    }
    json_res(200, &json::obj([("audio", json::s(audio)), ("bytes", json::i(bytes.len() as i64))]))
}

fn spawn_pipeline(state: &AppState, slug: String, skip_images: bool) {
    let _ = merge_job(&state.pool, &slug, "pipeline", &json::obj([
        ("status", json::s("running")),
        ("startedAt", json::i(config::now_ms())),
        ("error", Json::Null),
    ]));
    let env = JobEnv::from_state(state);
    spawn(env, move |env| run_pipeline(&env, &slug, skip_images));
}

fn run_pipeline(env: &JobEnv, slug: &str, skip_images: bool) {
    let Ok((pool, log)) = env.open() else { return };
    let _ = run_analyze(&pool, slug, &log);
    let _ = run_thumbnail(&pool, &env.backend_dir, slug, &log);
    run_tts_job(env, slug);
    let _ = run_chapter_timing(&pool, slug);
    if skip_images {
        let _ = merge_job(&pool, slug, "chapter-images", &json::obj([
            ("status", json::s("done")),
            ("skipped", Json::Bool(true)),
            ("reason", json::s("skipImages")),
            ("finishedAt", json::i(config::now_ms())),
        ]));
    } else {
        run_chapter_images(env, slug);
    }
    let _ = merge_job(&pool, slug, "pipeline", &json::obj([
        ("status", json::s("done")),
        ("finishedAt", json::i(config::now_ms())),
    ]));
}

fn run_analyze(pool: &Pool, slug: &str, log: &Logger) -> Result<(), String> {
    let Some(guide) = pool.get_guide(slug).map_err(|e| e.to_string())? else {
        return Err("Guide not found".into());
    };
    let transcript = guide.transcript.clone().unwrap_or_default();
    if transcript.is_empty() {
        return Err("Guide has no transcript".into());
    }
    if guide.summary.is_some() && guide.author.is_some() && chapter_count(&guide.chapters_json) > 0 {
        return Ok(());
    }
    let _ = merge_job(pool, slug, "analyze", &running_patch(0));
    let analysis = match guide_ai::analyze_transcript(&transcript, guide.duration, guide.source_url.as_deref()) {
        Ok(analysis) => analysis,
        Err(err) => {
            let _ = merge_job(pool, slug, "analyze", &failed_patch(&err));
            log.error("Analyze failed", &[("error", json::s(err.clone())), ("slug", json::s(slug))]);
            return Err(err);
        }
    };
    let Some(mut fresh) = pool.get_guide(slug).map_err(|e| e.to_string())? else {
        return Err("Guide not found".into());
    };
    if fresh.author.is_none() {
        fresh.author = analysis.author;
    }
    fresh.summary = Some(analysis.summary);
    if !analysis.chapters.is_empty() && chapter_count(&fresh.chapters_json) == 0 {
        fresh.chapters_json = json::stringify(&outlines_json(&analysis.chapters));
    }
    fresh.updated_at = config::now_ms();
    pool.update_guide_by_slug(&fresh).map_err(|e| e.to_string())?;
    let _ = merge_job(pool, slug, "analyze", &json::obj([
        ("status", json::s("done")),
        ("finishedAt", json::i(config::now_ms())),
        ("error", Json::Null),
    ]));
    Ok(())
}

fn run_thumbnail(pool: &Pool, backend_dir: &Path, slug: &str, log: &Logger) -> Result<String, String> {
    let Some(guide) = pool.get_guide(slug).map_err(|e| e.to_string())? else {
        return Err("Guide not found".into());
    };
    if let Some(existing) = guide.thumbnail.clone().filter(|s| !s.is_empty()) {
        return Ok(existing);
    }
    let transcript = guide.transcript.clone().unwrap_or_default();
    if transcript.is_empty() {
        return Err("Guide has no transcript".into());
    }
    let prompt = format!("{}. {}. Editorial illustration, no text.", guide.title, transcript.chars().take(600).collect::<String>());
    let bytes = match guide_ai::generate_image(&prompt) {
        Ok(bytes) => bytes,
        Err(err) => {
            let _ = merge_job(pool, slug, "thumbnail", &failed_patch(&err));
            log.error("Thumbnail failed", &[("error", json::s(err.clone()))]);
            return Err(err);
        }
    };
    let ext = guide_ai::image_ext(&bytes);
    let dir = backend_dir.join("public").join("images").join(slug);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("cover.{ext}")), &bytes).map_err(|e| e.to_string())?;
    let thumbnail = format!("/images/{slug}/cover.{ext}");
    let Some(mut fresh) = pool.get_guide(slug).map_err(|e| e.to_string())? else {
        return Err("Guide not found".into());
    };
    fresh.thumbnail = Some(thumbnail.clone());
    fresh.updated_at = config::now_ms();
    pool.update_guide_by_slug(&fresh).map_err(|e| e.to_string())?;
    let _ = merge_job(pool, slug, "thumbnail", &json::obj([
        ("status", json::s("done")),
        ("finishedAt", json::i(config::now_ms())),
        ("error", Json::Null),
    ]));
    Ok(thumbnail)
}

fn run_tts_job(env: &JobEnv, slug: &str) {
    let Ok((pool, log)) = env.open() else { return };
    let Ok(Some(guide)) = pool.get_guide(slug) else { return };
    let body = guide.transcript.clone().unwrap_or_default();
    if body.is_empty() {
        return;
    }
    let spoken = spoken_transcript(&guide.title, &body);
    let audio_dir = env.backend_dir.join("public").join("audio");
    let _ = fs::create_dir_all(&audio_dir);
    let out = audio_dir.join(format!("{slug}.mp3"));
    let parts = tts_parts_dir(&env.backend_dir, slug);
    let _ = fs::remove_dir_all(&parts);
    let _ = fs::create_dir_all(&parts);
    write_tts_state(
        &parts,
        &TtsStreamState {
            chunks_total: 0,
            chunks_done: 0,
            done: false,
            failed: false,
        },
    );

    let script = env.backend_dir.join("tts").join("render-guide.mjs");
    let payload = json::stringify(&json::obj([
        ("transcript", json::s(spoken)),
        ("voice", json::s("af_heart")),
        ("speed", json::n(1.0)),
        ("partsDir", json::s(parts.to_string_lossy())),
    ]));
    let out_arg = out.to_string_lossy().into_owned();
    let started = config::now_ms();
    let stdout = match run_node_progress(&script, &["guide", &out_arg], &payload, |progress| {
        let done = progress.get("chunksDone").and_then(Json::as_f64).unwrap_or(0.0) as i64;
        let total = progress.get("chunksTotal").and_then(Json::as_f64).unwrap_or(0.0) as i64;
        let _ = merge_job(&pool, slug, "tts", &json::obj([
            ("chunksDone", json::i(done)),
            ("chunksTotal", json::i(total)),
        ]));
    }) {
        Ok(stdout) => stdout,
        Err(err) => {
            write_tts_state(
                &parts,
                &TtsStreamState {
                    chunks_total: 0,
                    chunks_done: 0,
                    done: false,
                    failed: true,
                },
            );
            schedule_parts_cleanup(parts.clone());
            let _ = merge_job(&pool, slug, "tts", &failed_patch(&err));
            log.error("TTS job failed", &[("error", json::s(err)), ("slug", json::s(slug))]);
            return;
        }
    };
    let Some(result) = result_line(&stdout) else {
        write_tts_state(
            &parts,
            &TtsStreamState {
                chunks_total: 0,
                chunks_done: 0,
                done: false,
                failed: true,
            },
        );
        schedule_parts_cleanup(parts);
        let _ = merge_job(&pool, slug, "tts", &failed_patch("Kokoro returned no result"));
        return;
    };
    let Ok(Some(mut fresh)) = pool.get_guide(slug) else { return };
    if let Some(transcript) = result.get_str("transcript") {
        fresh.transcript = Some(transcript.to_string());
    }
    fresh.audio_url = Some(format!("/audio/{slug}.mp3"));
    fresh.duration = result.get("durationSec").and_then(Json::as_f64).map(|n| n.round() as i64);
    if let Some(words) = result.get("words") {
        fresh.timing_json = Some(json::stringify(&json::obj([("words", words.clone())])));
    }
    fresh.updated_at = config::now_ms();
    let _ = pool.update_guide_by_slug(&fresh);
    let _ = merge_job(&pool, slug, "tts", &json::obj([
        ("status", json::s("done")),
        ("ms", json::i(config::now_ms() - started)),
        ("finishedAt", json::i(config::now_ms())),
        ("error", Json::Null),
    ]));
    schedule_parts_cleanup(parts);
}

fn run_chapter_timing(pool: &Pool, slug: &str) -> Result<(), String> {
    let Some(guide) = pool.get_guide(slug).map_err(|e| e.to_string())? else {
        return Err("Guide not found".into());
    };
    let outlines = outlines_of(&guide);
    let words = words_of(&guide);
    if outlines.is_empty() || words.is_empty() {
        return Err("Guide has no word timings".into());
    }
    let timed = guide_ai::attach_chapter_times(&outlines, &words);
    if timed.is_empty() {
        return Err("No chapters generated".into());
    }
    let mut fresh = guide;
    fresh.chapters_json = json::stringify(&timed_json(&timed));
    fresh.updated_at = config::now_ms();
    pool.update_guide_by_slug(&fresh).map_err(|e| e.to_string())?;
    let _ = merge_job(pool, slug, "chapter-timing", &json::obj([
        ("status", json::s("done")),
        ("finishedAt", json::i(config::now_ms())),
        ("error", Json::Null),
    ]));
    Ok(())
}

fn run_chapter_images(env: &JobEnv, slug: &str) {
    let Ok((pool, log)) = env.open() else { return };
    let Ok(Some(guide)) = pool.get_guide(slug) else { return };
    let mut chapters = chapters_of(&guide);
    let dir = env.backend_dir.join("public").join("images").join(slug).join("generated");
    let _ = fs::create_dir_all(&dir);
    let mut done = 0usize;
    for (index, chapter) in chapters.iter_mut().enumerate() {
        if chapter.get("image").and_then(|image| image.get_str("generated")).is_some() {
            continue;
        }
        let quote = chapter.get_str("quote").or_else(|| chapter.get_str("title")).unwrap_or("");
        let prompt = format!("{quote}. Editorial illustration, no text.");
        match guide_ai::generate_image(&prompt) {
            Ok(bytes) => {
                let ext = guide_ai::image_ext(&bytes);
                let rel = format!("/images/{slug}/generated/{index}.{ext}");
                if fs::write(dir.join(format!("{index}.{ext}")), &bytes).is_ok() {
                    set_generated(chapter, &rel);
                    done += 1;
                    let _ = merge_job(&pool, slug, "chapter-images", &json::obj([("chunksDone", json::i(done as i64))]));
                }
            }
            Err(err) => {
                let _ = merge_job(&pool, slug, "chapter-images", &failed_patch(&err));
                log.error("chapter-images failed", &[("error", json::s(err)), ("slug", json::s(slug))]);
                return;
            }
        }
    }
    let Ok(Some(mut fresh)) = pool.get_guide(slug) else { return };
    fresh.chapters_json = json::stringify(&Json::Arr(chapters));
    fresh.updated_at = config::now_ms();
    let _ = pool.update_guide_by_slug(&fresh);
    let _ = merge_job(&pool, slug, "chapter-images", &json::obj([
        ("status", json::s("done")),
        ("finishedAt", json::i(config::now_ms())),
        ("error", Json::Null),
    ]));
}

fn run_real_images(env: &JobEnv, slug: &str) {
    let Ok((pool, _)) = env.open() else { return };
    let Some(key) = config::env_nonempty("UNSPLASH_ACCESS_KEY") else { return };
    let Ok(Some(guide)) = pool.get_guide(slug) else { return };
    let mut chapters = chapters_of(&guide);
    let dir = env.backend_dir.join("public").join("images").join(slug).join("real");
    let _ = fs::create_dir_all(&dir);
    let author = guide.author.clone().unwrap_or_default();
    for (index, chapter) in chapters.iter_mut().enumerate() {
        if chapter.get_str("realImage").is_some() {
            continue;
        }
        let title = chapter.get_str("title").unwrap_or("");
        let query = format!("{title} {author}").trim().to_string();
        if query.is_empty() {
            continue;
        }
        let Ok(Some(url)) = guide_ai::unsplash_photo(&query, &key) else { continue };
        let Ok(res) = crate::httpc::get_follow(&url, &[], FETCH_TIMEOUT_MS) else { continue };
        if !res.ok() || res.body.is_empty() {
            continue;
        }
        let ext = guide_ai::image_ext(&res.body);
        let rel = format!("/images/{slug}/real/{index}.{ext}");
        if fs::write(dir.join(format!("{index}.{ext}")), &res.body).is_ok() {
            if let Json::Obj(map) = chapter {
                map.insert("realImage".into(), json::s(rel));
            }
        }
        thread::sleep(std::time::Duration::from_millis(250));
    }
    let Ok(Some(mut fresh)) = pool.get_guide(slug) else { return };
    fresh.chapters_json = json::stringify(&Json::Arr(chapters));
    fresh.updated_at = config::now_ms();
    let _ = pool.update_guide_by_slug(&fresh);
    let _ = merge_job(&pool, slug, "chapter-real-images", &json::obj([
        ("status", json::s("done")),
        ("finishedAt", json::i(config::now_ms())),
        ("error", Json::Null),
    ]));
}

/// Paths and mode a background job needs. The request's `AppState` cannot cross threads.
struct JobEnv {
    db_path: PathBuf,
    backend_dir: PathBuf,
    prod: bool,
}

impl JobEnv {
    fn from_state(state: &AppState) -> JobEnv {
        JobEnv {
            db_path: state.db_path.clone(),
            backend_dir: state.backend_dir.clone(),
            prod: state.prod,
        }
    }

    fn open(&self) -> Result<(Pool, Logger), db::DbError> {
        let pool = Pool::open(&self.db_path.to_string_lossy(), 1)?;
        Ok((pool, Logger::new(self.prod)))
    }
}

fn spawn(env: JobEnv, work: impl FnOnce(JobEnv) + Send + 'static) {
    // Unit tests must not detach threads that outlive the temp database.
    if cfg!(test) {
        return;
    }
    thread::spawn(move || work(env));
}

fn renderer(state: &AppState) -> PathBuf {
    state.backend_dir.join("tts").join("render-guide.mjs")
}

fn run_node(script: &Path, args: &[&str], stdin_json: &str) -> Result<String, String> {
    run_node_progress(script, args, stdin_json, |_| {})
}

/// Spawn `node`, feed stdin JSON, and call `on_progress` for each `PROGRESS` line.
fn run_node_progress(
    script: &Path,
    args: &[&str],
    stdin_json: &str,
    mut on_progress: impl FnMut(&Json),
) -> Result<String, String> {
    use std::io::Read;
    let mut child = Command::new("node")
        .arg(script)
        .args(args)
        .current_dir(script.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("Could not start Kokoro ({err})"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(stdin_json.as_bytes()).map_err(|err| err.to_string())?;
    }
    let stdout = child.stdout.take().ok_or_else(|| "Kokoro stdout missing".to_string())?;
    let stderr_pipe = child.stderr.take();
    let stderr_thread = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });
    let mut collected = String::new();
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = line.map_err(|err| err.to_string())?;
        if let Some(raw) = line.strip_prefix("PROGRESS ") {
            if let Ok(progress) = json::parse(raw.as_bytes()) {
                on_progress(&progress);
            }
        }
        collected.push_str(&line);
        collected.push('\n');
    }
    let status = child.wait().map_err(|err| err.to_string())?;
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(brief_process_error(&stderr, &status.to_string()));
    }
    Ok(collected)
}

/// First useful line of a helper's stderr, capped so the player never shows a stack.
fn brief_process_error(stderr: &str, status: &str) -> String {
    let line = stderr
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("Error") || line.contains("Cannot find"))
        .unwrap_or("");
    let text = if line.is_empty() { status } else { line };
    text.chars().take(240).collect()
}

fn result_line(stdout: &str) -> Option<Json> {
    for line in stdout.lines().rev() {
        if let Some(json) = line.strip_prefix("RESULT ") {
            return json::parse(json.as_bytes()).ok();
        }
    }
    None
}

fn merge_job(pool: &Pool, slug: &str, step: &str, patch: &Json) -> Result<(), db::DbError> {
    pool.transaction(|conn| {
        let rows = conn.query(
            "SELECT jobs_json FROM Guides WHERE slug = ?",
            &[Value::Text(slug.into())],
        )?;
        let Some(row) = rows.first() else { return Ok(()) };
        let mut jobs = row
            .text("jobs_json")
            .and_then(|raw| json::parse(raw.as_bytes()).ok())
            .and_then(|value| match value {
                Json::Obj(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        let mut current = jobs.get(step).cloned().unwrap_or_else(|| json::obj([]));
        if let Json::Obj(dst) = &mut current {
            if let Json::Obj(src) = patch {
                for (key, value) in src {
                    dst.insert(key.clone(), value.clone());
                }
            }
        }
        jobs.insert(step.to_string(), current);
        conn.run(
            "UPDATE Guides SET jobs_json = ?, updated_at = ? WHERE slug = ?",
            &[
                Value::Text(json::stringify(&Json::Obj(jobs))),
                Value::Int(config::now_ms()),
                Value::Text(slug.into()),
            ],
        )?;
        Ok(())
    })
}

fn running_patch(total: usize) -> Json {
    json::obj([
        ("status", json::s("running")),
        ("startedAt", json::i(config::now_ms())),
        ("chunksDone", json::i(0)),
        ("chunksTotal", json::i(total as i64)),
        ("error", Json::Null),
    ])
}

fn failed_patch(err: &str) -> Json {
    json::obj([
        ("status", json::s("failed")),
        ("error", json::s(err)),
        ("finishedAt", json::i(config::now_ms())),
    ])
}

fn job_running(guide: &GuideRecord, step: &str) -> bool {
    jobs_value(&guide.jobs_json).get(step).and_then(|job| job.get_str("status")) == Some("running")
}

fn guard(state: &AppState, req: &Request) -> Result<Option<String>, Response> {
    let actor = caller_id(state, req);
    if let Some(id) = actor.as_deref() {
        routes::require_csrf(state, req, id)?;
    }
    Ok(actor)
}

fn caller_id(state: &AppState, req: &Request) -> Option<String> {
    let secret = state.jwt_secret.as_deref()?;
    let token = req.cookie("token")?;
    auth::jwt_verify(&token, secret).ok().map(|payload| payload.user_id)
}

fn caller_may_write(guide: &GuideRecord, actor: Option<&str>) -> bool {
    match guide.created_by.as_deref() {
        Some(owner) => actor == Some(owner),
        None => true,
    }
}

fn require_writable(state: &AppState, slug: &str, actor: Option<&str>) -> Result<GuideRecord, Response> {
    match state.pool.get_guide(slug) {
        Ok(Some(guide)) if caller_may_write(&guide, actor) => Ok(guide),
        Ok(_) => Err(err_json(404, "Guide not found")),
        Err(err) => {
            state.log.error("Get guide error", &[("error", json::s(err.to_string()))]);
            Err(err_json(500, "Failed to load guide"))
        }
    }
}

fn load_public(state: &AppState, slug: &str) -> Result<GuideRecord, Response> {
    match state.pool.get_guide(slug) {
        Ok(Some(guide)) if guide.visibility == "public" => Ok(guide),
        Ok(_) => Err(err_json(404, "Guide not found")),
        Err(err) => {
            state.log.error("Get guide error", &[("error", json::s(err.to_string()))]);
            Err(err_json(500, "Failed to load guide"))
        }
    }
}

fn unique_slug(pool: &Pool, base: &str) -> Result<String, db::DbError> {
    if pool.get_guide(base)?.is_none() {
        return Ok(base.to_string());
    }
    for n in 2..200 {
        let candidate = format!("{base}-{n}");
        if pool.get_guide(&candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}-x"))
}

/// Lowercase kebab slug. Non-ascii letters are dropped.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
        if out.len() >= SLUG_MAX {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= SLUG_MAX
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Title is spoken first unless the stored transcript already starts with it.
pub fn spoken_transcript(title: &str, body: &str) -> String {
    let title = title.trim();
    if title.is_empty() || body.trim_start().starts_with(title) {
        return body.to_string();
    }
    let titled = if title.ends_with(['.', '!', '?']) {
        title.to_string()
    } else {
        format!("{title}.")
    };
    format!("{titled}\n\n{body}")
}

fn split_slug(path: &str) -> Option<(&str, Option<&str>)> {
    let rest = path.strip_prefix("/api/guides/")?;
    if rest.is_empty() {
        return None;
    }
    match rest.split_once('/') {
        Some((slug, suffix)) if !suffix.is_empty() && !suffix.contains('/') => Some((slug, Some(suffix))),
        Some(_) => None,
        None => Some((rest, None)),
    }
}

fn record_from_body(slug: &str, title: &str, body: &Json, created_by: Option<String>, created_at: i64, updated_at: i64) -> GuideRecord {
    GuideRecord {
        slug: slug.to_string(),
        title: title.to_string(),
        author: text_field(body, "author"),
        date: text_field(body, "date"),
        duration: body.get("duration").and_then(Json::as_f64).map(|n| n.round() as i64),
        audio_url: text_field(body, "audio"),
        thumbnail: text_field(body, "thumbnail"),
        timing_offset: body.get("timingOffset").and_then(Json::as_f64).unwrap_or(0.0),
        default_view_mode: if body.get_str("defaultViewMode") == Some("real") { "real" } else { "generated" }.into(),
        transcript: body.get_str("transcript").map(str::to_string),
        summary: text_field(body, "summary"),
        source_url: text_field(body, "sourceUrl"),
        jobs_json: body.get("jobs").filter(|v| v.as_obj().is_some()).map(|v| json::stringify(v)),
        chapters_json: body.get("chapters").filter(|v| v.as_arr().is_some()).map(|v| json::stringify(v)).unwrap_or_else(|| "[]".into()),
        timing_json: body.get("timing").filter(|v| v.as_obj().is_some()).map(|v| json::stringify(v)),
        visibility: text_field(body, "visibility").unwrap_or_else(|| "public".into()),
        created_by,
        created_at,
        updated_at,
    }
}

fn summary_json(guide: &GuideRecord) -> Json {
    json::obj([
        ("slug", json::s(guide.slug.clone())),
        ("title", json::s(guide.title.clone())),
        ("author", opt_s(guide.author.as_deref())),
        ("date", opt_s(guide.date.as_deref())),
        ("duration", opt_i(guide.duration)),
        ("thumbnail", opt_s(guide.thumbnail.as_deref())),
        ("chapterCount", json::i(chapter_count(&guide.chapters_json))),
        ("visibility", json::s(guide.visibility.clone())),
        ("jobs", jobs_value(&guide.jobs_json)),
        ("createdAt", json::i(guide.created_at)),
        ("updatedAt", json::i(guide.updated_at)),
    ])
}

fn detail_json(guide: &GuideRecord) -> Json {
    let mut summary = match summary_json(guide) {
        Json::Obj(map) => map,
        _ => BTreeMap::new(),
    };
    summary.insert("audio".into(), opt_s(guide.audio_url.as_deref()));
    summary.insert("timingOffset".into(), json::n(guide.timing_offset));
    summary.insert("defaultViewMode".into(), json::s(guide.default_view_mode.clone()));
    summary.insert("summary".into(), opt_s(guide.summary.as_deref()));
    summary.insert("sourceUrl".into(), opt_s(guide.source_url.as_deref()));
    summary.insert("transcript".into(), json::s(guide.transcript.clone().unwrap_or_default()));
    summary.insert("chapters".into(), chapters_value(&guide.chapters_json));
    summary.insert("timing".into(), guide.timing_json.as_deref().and_then(|raw| json::parse(raw.as_bytes()).ok()).unwrap_or(Json::Null));
    Json::Obj(summary)
}

fn article_json(article: &article::Extracted, url: &str) -> Json {
    json::obj([
        ("title", json::s(article.title.clone())),
        ("author", opt_s(article.author.as_deref())),
        ("transcript", json::s(article.transcript.clone())),
        ("date", opt_s(article.date.as_deref())),
        ("thumbnail", opt_s(article.thumbnail.as_deref())),
        ("sourceUrl", json::s(url)),
    ])
}

fn chapters_value(raw: &str) -> Json {
    json::parse(raw.as_bytes()).ok().filter(|v| v.as_arr().is_some()).unwrap_or_else(|| Json::Arr(Vec::new()))
}

fn jobs_value(raw: &Option<String>) -> Json {
    raw.as_deref()
        .and_then(|text| json::parse(text.as_bytes()).ok())
        .filter(|value| value.as_obj().is_some())
        .unwrap_or_else(|| json::obj([]))
}

fn chapter_count(raw: &str) -> i64 {
    chapters_value(raw).as_arr().map(|items| items.len() as i64).unwrap_or(0)
}

fn chapters_of(guide: &GuideRecord) -> Vec<Json> {
    match chapters_value(&guide.chapters_json) {
        Json::Arr(items) => items,
        _ => Vec::new(),
    }
}

fn chapters_missing_image(guide: &GuideRecord) -> usize {
    chapters_of(guide).iter().filter(|ch| ch.get("image").and_then(|image| image.get_str("generated")).is_none()).count()
}

fn outlines_of(guide: &GuideRecord) -> Vec<Outline> {
    chapters_of(guide)
        .iter()
        .filter_map(|chapter| {
            Some(Outline {
                title: chapter.get_str("title")?.to_string(),
                quote: chapter.get_str("quote")?.to_string(),
                caption: chapter.get_str("caption").unwrap_or("").to_string(),
            })
        })
        .collect()
}

fn words_of(guide: &GuideRecord) -> Vec<TimedWord> {
    let Some(raw) = guide.timing_json.as_deref() else { return Vec::new() };
    let Ok(parsed) = json::parse(raw.as_bytes()) else { return Vec::new() };
    let Some(items) = parsed.get("words").and_then(Json::as_arr) else { return Vec::new() };
    items.iter().filter_map(|item| {
        Some(TimedWord {
            word: item.get_str("w")?.to_string(),
            time: item.get("t")?.as_f64()?,
        })
    }).collect()
}

fn outlines_json(chapters: &[Outline]) -> Json {
    Json::Arr(chapters.iter().map(|chapter| json::obj([
        ("time", json::i(0)),
        ("title", json::s(chapter.title.clone())),
        ("quote", json::s(chapter.quote.clone())),
        ("caption", json::s(chapter.caption.clone())),
    ])).collect())
}

fn timed_json(chapters: &[TimedChapter]) -> Json {
    Json::Arr(chapters.iter().map(|chapter| json::obj([
        ("time", json::n(chapter.time)),
        ("title", json::s(chapter.title.clone())),
        ("quote", json::s(chapter.quote.clone())),
        ("caption", json::s(chapter.caption.clone())),
    ])).collect())
}

fn set_generated(chapter: &mut Json, path: &str) {
    let Json::Obj(map) = chapter else { return };
    let mut image = map.get("image").cloned().unwrap_or_else(|| json::obj([]));
    if let Json::Obj(fields) = &mut image {
        fields.insert("generated".into(), json::s(path));
    }
    map.insert("image".into(), image);
}

fn text_field(body: &Json, key: &str) -> Option<String> {
    body.get_str(key).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn opt_s(value: Option<&str>) -> Json {
    match value {
        Some(text) if !text.is_empty() => json::s(text),
        _ => Json::Null,
    }
}

fn opt_i(value: Option<i64>) -> Json {
    value.map(json::i).unwrap_or(Json::Null)
}

fn json_body(req: &Request) -> Result<Json, Response> {
    let value = json::parse(&req.body).map_err(|_| err_json(400, "Invalid request body"))?;
    if value.as_obj().is_none() {
        return Err(err_json(400, "Invalid request body"));
    }
    Ok(value)
}

fn json_res(status: u16, value: &Json) -> Response {
    Response::json(status, &json::stringify(value))
}

fn err_json(status: u16, message: &str) -> Response {
    json_res(status, &json::obj([("error", json::s(message))]))
}

fn httpc_get(url: &str) -> Result<Vec<u8>, Response> {
    match crate::httpc::get_follow(url, &[
        ("User-Agent", "Mozilla/5.0 (compatible; BookPlayerBot/1.0)"),
        ("Accept", "text/html,application/xhtml+xml"),
    ], FETCH_TIMEOUT_MS) {
        Ok(res) if res.ok() => Ok(res.body),
        Ok(res) => Err(err_json(502, &format!("Failed to fetch page (status {})", res.status))),
        Err(err) if err.0.to_ascii_lowercase().contains("time") => Err(err_json(504, "Upstream fetch timed out after 15s")),
        Err(err) => {
            eprintln!("fetch-url error: {err}");
            Err(err_json(500, "Failed to fetch or parse the page"))
        }
    }
}

fn apply_range(file: Response, range: Option<&str>) -> Response {
    let ctype = file.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.clone()).unwrap_or_else(|| "application/octet-stream".into());
    let total = file.body.len();
    let Some(spec) = range.and_then(|value| value.trim().strip_prefix("bytes=")) else {
        return Response::bytes(file.status, &ctype, file.body).header("Accept-Ranges", "bytes");
    };
    let Some((start, end)) = parse_byte_range(spec, total) else {
        return Response::empty(416).header("Content-Range", &format!("bytes */{total}"));
    };
    let slice = file.body[start..end].to_vec();
    let last = end.saturating_sub(1);
    Response::bytes(206, &ctype, slice)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", &format!("bytes {start}-{last}/{total}"))
}

fn parse_byte_range(spec: &str, total: usize) -> Option<(usize, usize)> {
    if total == 0 {
        return None;
    }
    let spec = spec.split(',').next().unwrap_or(spec);
    let (start_s, end_s) = spec.split_once('-')?;
    if start_s.is_empty() {
        let suffix: usize = end_s.parse().ok()?;
        let len = suffix.min(total);
        return Some((total - len, total));
    }
    let start: usize = start_s.parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if end_s.is_empty() {
        total
    } else {
        end_s.parse::<usize>().ok()?.saturating_add(1).min(total)
    };
    if end <= start {
        return None;
    }
    Some((start, end))
}

/// Pull the `audio` part out of a multipart body.
pub fn audio_field(content_type: &str, body: &[u8]) -> Result<Vec<u8>, &'static str> {
    let boundary = content_type.split("boundary=").nth(1).ok_or("missing")?.split(';').next().unwrap_or("").trim().trim_matches('"');
    if boundary.is_empty() {
        return Err("missing");
    }
    let marker = format!("--{boundary}");
    let text_marker = marker.as_bytes();
    let mut rest = body;
    while let Some(at) = find_bytes(rest, text_marker) {
        rest = &rest[at + text_marker.len()..];
        if rest.starts_with(b"--") {
            break;
        }
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        }
        let Some(header_end) = find_bytes(rest, b"\r\n\r\n") else { break };
        let headers = String::from_utf8_lossy(&rest[..header_end]).to_ascii_lowercase();
        let mut part = &rest[header_end + 4..];
        if let Some(next) = find_bytes(part, text_marker) {
            part = &part[..next];
        }
        if part.ends_with(b"\r\n") {
            part = &part[..part.len() - 2];
        }
        if headers.contains("name=\"audio\"") {
            if let Some(kind) = header_value(&headers, "content-type") {
                if !kind.starts_with("audio/") {
                    return Err("type");
                }
            }
            return Ok(part.to_vec());
        }
    }
    Err("missing")
}

fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    for line in headers.lines() {
        let (key, value) = line.split_once(':')?;
        if key.trim() == name {
            return Some(value.trim());
        }
    }
    None
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|window| window == needle)
}

/// Directory holding a slug's streaming TTS artifacts.
fn tts_parts_dir(backend_dir: &Path, slug: &str) -> PathBuf {
    backend_dir.join("public").join("audio").join(format!("{slug}.parts"))
}

/// Live state of an in-progress streaming TTS render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TtsStreamState {
    /// Total source chunks (0 until the first progress event).
    pub chunks_total: u32,
    /// Chunks whose MP3 has been written.
    pub chunks_done: u32,
    /// Canonical file persisted; streams may drain and finish.
    pub done: bool,
    /// Synthesis failed — streaming clients should stop.
    pub failed: bool,
}

/// Partial timing streamed alongside audio chunks (live captions).
#[derive(Debug, Clone, PartialEq)]
pub struct TtsStreamTiming {
    /// Cumulative per-word timings for the portion rendered so far.
    pub words: Vec<Json>,
    /// Normalized transcript the timings tokenize against.
    pub transcript: String,
}

/// Pure state-machine step for the stream tail loop (Node `__testStreamTailNext`).
pub fn stream_tail_next(offset: u64, size: u64, state: Option<TtsStreamState>) -> GrowingFileAction {
    http::growing_file_next(
        offset,
        size,
        state.map(|s| GrowingFileState {
            done: s.done,
            failed: s.failed,
        }),
    )
}

/// Whether GET `/api/guides/:slug` should merge the streaming timing sidecar.
pub fn should_merge_stream_timing(guide: &GuideRecord, partial: Option<&TtsStreamTiming>) -> bool {
    let has_final = guide
        .timing_json
        .as_deref()
        .and_then(|raw| json::parse(raw.as_bytes()).ok())
        .and_then(|timing| timing.get("words").and_then(Json::as_arr).map(|w| !w.is_empty()))
        .unwrap_or(false);
    !has_final && job_running(guide, "tts") && partial.is_some_and(|p| !p.words.is_empty())
}

fn write_tts_state(parts_dir: &Path, state: &TtsStreamState) {
    let _ = fs::write(
        parts_dir.join("state.json"),
        json::stringify(&json::obj([
            ("chunksTotal", json::i(state.chunks_total as i64)),
            ("chunksDone", json::i(state.chunks_done as i64)),
            ("done", Json::Bool(state.done)),
            ("failed", Json::Bool(state.failed)),
        ])),
    );
}

fn read_tts_state(parts_dir: &Path) -> Option<TtsStreamState> {
    let raw = fs::read_to_string(parts_dir.join("state.json")).ok()?;
    let parsed = json::parse(raw.as_bytes()).ok()?;
    Some(TtsStreamState {
        chunks_total: parsed.get("chunksTotal").and_then(Json::as_f64).unwrap_or(0.0) as u32,
        chunks_done: parsed.get("chunksDone").and_then(Json::as_f64).unwrap_or(0.0) as u32,
        done: parsed.get("done").and_then(Json::as_bool) == Some(true),
        failed: parsed.get("failed").and_then(Json::as_bool) == Some(true),
    })
}

fn read_tts_timing(parts_dir: &Path) -> Option<TtsStreamTiming> {
    let raw = fs::read_to_string(parts_dir.join("timing.json")).ok()?;
    let parsed = json::parse(raw.as_bytes()).ok()?;
    let words = parsed.get("words").and_then(Json::as_arr)?.to_vec();
    let transcript = parsed.get_str("transcript")?.to_string();
    Some(TtsStreamTiming { words, transcript })
}

fn schedule_parts_cleanup(parts_dir: PathBuf) {
    if cfg!(test) {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(TTS_PARTS_CLEANUP_MS));
        let _ = fs::remove_dir_all(parts_dir);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_drops_punctuation_and_case() {
        assert_eq!(slugify("Founder Mode!"), "founder-mode");
    }

    #[test]
    fn spoken_transcript_prepends_the_title_once() {
        assert_eq!(spoken_transcript("Founder Mode", "Body text"), "Founder Mode.\n\nBody text");
        assert_eq!(spoken_transcript("Founder Mode", "Founder Mode.\n\nBody"), "Founder Mode.\n\nBody");
    }

    #[test]
    fn audio_field_reads_the_named_part() {
        let body = b"------b\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\nMP3\r\n------b--\r\n";
        let got = audio_field("multipart/form-data; boundary=----b", body).unwrap();
        assert_eq!(got, b"MP3");
    }

    #[test]
    fn byte_range_is_inclusive() {
        assert_eq!(parse_byte_range("0-1", 5), Some((0, 2)));
        assert_eq!(parse_byte_range("4-", 5), Some((4, 5)));
        assert_eq!(parse_byte_range("-2", 5), Some((3, 5)));
    }

    #[test]
    fn stream_tail_next_writes_waits_and_ends() {
        let running = TtsStreamState {
            chunks_total: 3,
            chunks_done: 1,
            done: false,
            failed: false,
        };
        assert_eq!(stream_tail_next(0, 100, Some(running)), GrowingFileAction::Write);
        assert_eq!(stream_tail_next(100, 100, Some(running)), GrowingFileAction::Wait);
        assert_eq!(
            stream_tail_next(
                100,
                100,
                Some(TtsStreamState {
                    chunks_total: 3,
                    chunks_done: 3,
                    done: true,
                    failed: false,
                })
            ),
            GrowingFileAction::End
        );
        assert_eq!(
            stream_tail_next(
                50,
                50,
                Some(TtsStreamState {
                    chunks_total: 1,
                    chunks_done: 0,
                    done: false,
                    failed: true,
                })
            ),
            GrowingFileAction::End
        );
        assert_eq!(stream_tail_next(0, 0, None), GrowingFileAction::End);
    }

    #[test]
    fn should_merge_stream_timing_only_while_tts_runs_without_final() {
        let now = 1_i64;
        let mut guide = GuideRecord {
            slug: "demo".into(),
            title: "Demo".into(),
            author: None,
            date: None,
            duration: None,
            audio_url: None,
            thumbnail: None,
            timing_offset: 0.0,
            default_view_mode: "generated".into(),
            transcript: Some("hello".into()),
            summary: None,
            source_url: None,
            jobs_json: Some(json::stringify(&json::obj([(
                "tts",
                json::obj([("status", json::s("running"))]),
            )]))),
            chapters_json: "[]".into(),
            timing_json: None,
            visibility: "public".into(),
            created_by: None,
            created_at: now,
            updated_at: now,
        };
        let partial = TtsStreamTiming {
            words: vec![json::obj([("w", json::s("hi")), ("t", json::n(0.0))])],
            transcript: "hi".into(),
        };
        assert!(should_merge_stream_timing(&guide, Some(&partial)));
        guide.timing_json = Some(r#"{"words":[{"w":"done","t":0}]}"#.into());
        assert!(!should_merge_stream_timing(&guide, Some(&partial)));
        guide.timing_json = None;
        guide.jobs_json = Some(json::stringify(&json::obj([(
            "tts",
            json::obj([("status", json::s("done"))]),
        )])));
        assert!(!should_merge_stream_timing(&guide, Some(&partial)));
        assert!(!should_merge_stream_timing(&guide, None));
    }
}
