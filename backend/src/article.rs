//! Pull a title, author, date, and transcript out of an article page.
//!
//! The matchers are scanners, not a regex crate. They follow the same order
//! the old Node route used: prefer `entry-content`, then other article
//! containers, then paragraphs, then the body.

/// Fields the create form needs from a fetched page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    /// Page title with the site suffix removed.
    pub title: String,
    /// Byline, when a meta tag had one.
    pub author: Option<String>,
    /// Plain text, capped at 25,000 characters.
    pub transcript: String,
    /// Publication date string, or `None`.
    pub date: Option<String>,
    /// Absolute `og:image` or twitter image URL.
    pub thumbnail: Option<String>,
}

/// Why a URL cannot be fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlError {
    /// Missing or not http(s).
    Invalid,
    /// Host is loopback, link-local, or a private range.
    Blocked,
}

const TRANSCRIPT_CAP: usize = 25_000;
const MIN_TRANSCRIPT: usize = 100;

/// Accept an http(s) URL whose host is not a private or link-local address.
///
/// # Errors
/// [`UrlError::Invalid`] when the string is not an http(s) URL.
/// [`UrlError::Blocked`] when the host is local or private.
pub fn public_http_url(raw: &str) -> Result<String, UrlError> {
    let trimmed = raw.trim();
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or(UrlError::Invalid)?;
    if rest.is_empty() || rest.starts_with('/') {
        return Err(UrlError::Invalid);
    }
    let host = host_of(rest).ok_or(UrlError::Invalid)?;
    if host.is_empty() || is_blocked_host(host) {
        return Err(UrlError::Blocked);
    }
    Ok(trimmed.to_string())
}

/// Extract an article from HTML.
///
/// # Errors
/// Returns `Err("short")` when the readable text is under 100 characters.
pub fn extract_article(html: &str, page_url: &str) -> Result<Extracted, &'static str> {
    let cleaned = strip_noise(html);
    let title = clean_title(&tag_inner(&cleaned, "title").unwrap_or_default());
    let fragment = best_container(&cleaned);
    let mut transcript = match fragment {
        Some(inner) => html_to_text(inner),
        None => fallback_text(&cleaned),
    };
    transcript = decode_entities(&transcript);
    if transcript.chars().count() < MIN_TRANSCRIPT {
        return Err("short");
    }
    if transcript.chars().count() > TRANSCRIPT_CAP {
        transcript = transcript.chars().take(TRANSCRIPT_CAP).collect();
    }
    let date = extract_date(&cleaned, &transcript);
    let thumbnail = extract_image(&cleaned, page_url);
    Ok(Extracted {
        title: if title.is_empty() { "Untitled".into() } else { title },
        author: meta_content(&cleaned, &["author", "twitter:creator", "og:article:author"]),
        transcript,
        date,
        thumbnail,
    })
}

/// Publication date only, for the re-scrape route.
pub fn extract_date_from_html(html: &str) -> Option<String> {
    let cleaned = strip_noise(html);
    let text = html_to_text(&cleaned);
    extract_date(&cleaned, &text)
}

fn host_of(after_scheme: &str) -> Option<&str> {
    let no_user = after_scheme.rsplit_once('@').map(|(_, host)| host).unwrap_or(after_scheme);
    let host_port = no_user.split(['/', '?', '#']).next().unwrap_or("");
    if let Some(inner) = host_port.strip_prefix('[') {
        return inner.split(']').next();
    }
    Some(host_port.split(':').next().unwrap_or(""))
}

fn is_blocked_host(host: &str) -> bool {
    let host = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    if host == "metadata.google.internal" || host == "0.0.0.0" || host == "::1" {
        return true;
    }
    if let Some(v4) = parse_v4(&host) {
        return is_private_v4(v4);
    }
    false
}

fn parse_v4(host: &str) -> Option<[u8; 4]> {
    let mut parts = [0u8; 4];
    let mut iter = host.split('.');
    for slot in &mut parts {
        let part = iter.next()?;
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    if iter.next().is_some() {
        return None;
    }
    Some(parts)
}

fn is_private_v4(ip: [u8; 4]) -> bool {
    ip[0] == 10
        || ip[0] == 127
        || ip[0] == 0
        || (ip[0] == 169 && ip[1] == 254)
        || (ip[0] == 172 && (16..=31).contains(&ip[1]))
        || (ip[0] == 192 && ip[1] == 168)
}

fn strip_noise(html: &str) -> String {
    let mut out = remove_blocks(html, "script");
    out = remove_blocks(&out, "style");
    out = remove_blocks(&out, "noscript");
    out = remove_comments(&out);
    out = remove_marked(&out, "section", "id=\"comments\"");
    out = remove_marked(&out, "div", "id=\"comments\"");
    out = remove_marked(&out, "ol", "comment-list");
    out = remove_marked(&out, "ul", "comment-list");
    remove_marked(&out, "article", "comment-body")
}

fn remove_comments(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if bytes[i..].starts_with(b"<!--") {
            if let Some(rel) = lower[i + 4..].find("-->") {
                i += 4 + rel + 3;
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn remove_blocks(input: &str, tag: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    while let Some(start) = find_ci(rest, &open) {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        match find_ci(after, &close) {
            Some(end) => {
                let tail = &after[end + close.len()..];
                let skip = tail.find('>').map(|n| n + 1).unwrap_or(0);
                rest = &tail[skip..];
            }
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn remove_marked(input: &str, tag: &str, marker: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    while let Some(start) = find_ci(rest, &open) {
        let after = &rest[start..];
        let tag_end = after.find('>').unwrap_or(0);
        let opening = &after[..=tag_end.min(after.len().saturating_sub(1))];
        if !opening.to_ascii_lowercase().contains(&marker.to_ascii_lowercase()) {
            out.push_str(&rest[..=start]);
            rest = &rest[start + 1..];
            continue;
        }
        out.push_str(&rest[..start]);
        match find_ci(after, &close) {
            Some(end) => {
                let tail = &after[end + close.len()..];
                let skip = tail.find('>').map(|n| n + 1).unwrap_or(0);
                rest = &tail[skip..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn best_container(html: &str) -> Option<&str> {
    const MARKERS: &[&str] = &[
        "entry-content",
        "post-content",
        "article-body",
        "article-content",
        "post-body",
    ];
    for marker in MARKERS {
        if let Some(inner) = container_inner(html, "div", marker) {
            if inner.len() > 200 {
                return Some(inner);
            }
        }
    }
    if let Some(inner) = element_inner(html, "main") {
        if inner.len() > 200 {
            return Some(inner);
        }
    }
    element_inner(html, "article").filter(|inner| inner.len() > 200)
}

fn container_inner<'a>(html: &'a str, tag: &str, marker: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let mut offset = 0;
    while offset < html.len() {
        let Some(start) = find_ci(&html[offset..], &open) else { break };
        let abs = offset + start;
        let after = &html[abs..];
        let tag_end = after.find('>')?;
        let opening = &after[..=tag_end];
        if opening.to_ascii_lowercase().contains(&marker.to_ascii_lowercase()) {
            let inner_start = abs + tag_end + 1;
            let close = format!("</{tag}");
            let end = find_ci(&html[inner_start..], &close)?;
            return Some(&html[inner_start..inner_start + end]);
        }
        offset = abs + 1;
    }
    None
}

fn element_inner<'a>(html: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let start = find_ci(html, &open)?;
    let after = &html[start..];
    let tag_end = after.find('>')?;
    if after[..tag_end].to_ascii_lowercase().contains("comment-body") {
        return None;
    }
    let inner_start = start + tag_end + 1;
    let close = format!("</{tag}");
    let end = find_ci(&html[inner_start..], &close)?;
    Some(&html[inner_start..inner_start + end])
}

fn fallback_text(cleaned: &str) -> String {
    let paras = paragraph_text(cleaned);
    if paras.chars().count() >= MIN_TRANSCRIPT {
        return paras;
    }
    let body = tag_inner(cleaned, "body").unwrap_or(cleaned);
    html_to_text(body)
}

fn paragraph_text(html: &str) -> String {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(start) = find_ci(rest, "<p") {
        let after = &rest[start..];
        let Some(tag_end) = after.find('>') else { break };
        let inner_at = start + tag_end + 1;
        let Some(end) = find_ci(&rest[inner_at..], "</p") else { break };
        let text = html_to_text(&rest[inner_at..inner_at + end]);
        if !text.is_empty() {
            out.push(text);
        }
        rest = &rest[inner_at + end..];
    }
    out.join("\n\n")
}

fn html_to_text(html: &str) -> String {
    let with_breaks = break_blocks(html);
    let mut text = String::new();
    let mut in_tag = false;
    for ch in with_breaks.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            text.push(ch);
        }
    }
    collapse_space(&decode_entities(&text))
}

fn break_blocks(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = lower.as_bytes();
    while i < html.len() {
        if bytes[i] == b'<' {
            let rest = &lower[i..];
            if rest.starts_with("<br") {
                out.push('\n');
            } else if closes_block(rest) {
                out.push('\n');
                out.push('\n');
            }
        }
        let ch = html[i..].chars().next().unwrap_or('\0');
        if bytes[i] != b'<' {
            out.push(ch);
        } else {
            // Keep the tag so the later strip still sees it.
            let end = html[i..].find('>').map(|n| i + n + 1).unwrap_or(html.len());
            out.push_str(&html[i..end]);
            i = end;
            continue;
        }
        i += ch.len_utf8();
    }
    out
}

fn closes_block(lower_at_tag: &str) -> bool {
    const TAGS: &[&str] = &[
        "</p", "</div", "</section", "</article", "</h1", "</h2", "</h3", "</h4", "</h5", "</h6",
        "</li", "</blockquote", "</tr",
    ];
    TAGS.iter().any(|tag| lower_at_tag.starts_with(tag))
}

fn collapse_space(text: &str) -> String {
    let mut out = String::new();
    let mut newline_run = 0;
    let mut space = false;
    for ch in text.chars() {
        if ch == '\n' {
            newline_run += 1;
            space = false;
            if newline_run <= 2 {
                out.push('\n');
            }
            continue;
        }
        newline_run = 0;
        if ch.is_whitespace() {
            if !space && !out.ends_with('\n') {
                out.push(' ');
                space = true;
            }
            continue;
        }
        space = false;
        out.push(ch);
    }
    out.trim().to_string()
}

fn tag_inner<'a>(html: &'a str, tag: &str) -> Option<&'a str> {
    element_inner(html, tag)
}

fn clean_title(raw: &str) -> String {
    let decoded = decode_entities(raw);
    let flat = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    for sep in [" | ", " – ", " — ", " - "] {
        if let Some((head, _)) = flat.split_once(sep) {
            return head.trim().to_string();
        }
    }
    flat
}

fn meta_content(html: &str, names: &[&str]) -> Option<String> {
    for tag in iter_tags(html, "meta") {
        let lower = tag.to_ascii_lowercase();
        let matches = names.iter().any(|name| {
            lower.contains(&format!("name=\"{name}\""))
                || lower.contains(&format!("name='{name}'"))
                || lower.contains(&format!("property=\"{name}\""))
        });
        if matches {
            if let Some(value) = attr_value(tag, "content") {
                let text = decode_entities(value).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn extract_date(cleaned: &str, body: &str) -> Option<String> {
    const NAMES: &[&str] = &[
        "article:published_time",
        "date",
        "article:published",
        "og:article:published_time",
    ];
    if let Some(value) = meta_content(cleaned, NAMES) {
        return Some(value);
    }
    for tag in iter_tags(cleaned, "time") {
        if let Some(value) = attr_value(tag, "datetime") {
            let text = decode_entities(value).trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    month_year(body)
}

fn extract_image(cleaned: &str, page_url: &str) -> Option<String> {
    const NAMES: &[&str] = &["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"];
    let raw = meta_content(cleaned, NAMES)?;
    Some(resolve_url(&raw, page_url))
}

fn month_year(text: &str) -> Option<String> {
    const MONTHS: &[&str] = &[
        "January", "February", "March", "April", "May", "June", "July", "August", "September",
        "October", "November", "December",
    ];
    for month in MONTHS {
        let mut rest = text;
        while let Some(at) = rest.find(month) {
            let after = &rest[at + month.len()..];
            let year: String = after
                .trim_start()
                .chars()
                .take(4)
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if year.len() == 4 && after.trim_start().starts_with(&year) {
                return Some(format!("{month} {year}"));
            }
            rest = &rest[at + month.len()..];
        }
    }
    None
}

fn resolve_url(raw: &str, base: &str) -> String {
    if raw.starts_with("https://") || raw.starts_with("http://") {
        return raw.to_string();
    }
    let scheme_end = base.find("://").unwrap_or(0);
    let after = scheme_end + 3;
    let origin_end = base[after..].find('/').map(|n| after + n).unwrap_or(base.len());
    let origin = &base[..origin_end];
    if raw.starts_with('/') {
        return format!("{origin}{raw}");
    }
    format!("{origin}/{raw}")
}

fn iter_tags<'a>(html: &'a str, tag: &str) -> Vec<&'a str> {
    let mut found = Vec::new();
    let open = format!("<{tag}");
    let mut rest = html;
    let mut offset = 0;
    while let Some(start) = find_ci(rest, &open) {
        let abs = offset + start;
        if let Some(end) = html[abs..].find('>') {
            found.push(&html[abs..=abs + end]);
            offset = abs + end + 1;
            rest = &html[offset..];
        } else {
            break;
        }
    }
    found
}

fn attr_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=");
    let at = find_ci(&lower, &key)?;
    let value = tag[at + key.len()..].trim_start();
    let quote = value.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let inner = &value[quote.len_utf8()..];
    let end = inner.find(quote)?;
    Some(&inner[..end])
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let lower_hay = hay.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    lower_hay.find(&lower_needle)
}

fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at..];
        if let Some(end) = after.find(';') {
            let token = &after[1..end];
            if let Some(ch) = decode_one(token) {
                out.push(ch);
                rest = &after[end + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &after[1..];
    }
    out.push_str(rest);
    out
}

fn decode_one(token: &str) -> Option<char> {
    if let Some(hex) = token.strip_prefix('#') .and_then(|t| t.strip_prefix('x').or_else(|| t.strip_prefix('X'))) {
        let code = u32::from_str_radix(hex, 16).ok()?;
        return char::from_u32(code);
    }
    if let Some(dec) = token.strip_prefix('#') {
        let code = dec.parse::<u32>().ok()?;
        return char::from_u32(code);
    }
    Some(match token.to_ascii_lowercase().as_str() {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ndash" => '–',
        "mdash" => '—',
        "hellip" => '…',
        "lsquo" | "rsquo" => '\'',
        "ldquo" | "rdquo" => '"',
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_and_non_http_urls() {
        assert_eq!(public_http_url("ftp://example.com"), Err(UrlError::Invalid));
        assert_eq!(public_http_url("http://127.0.0.1/x"), Err(UrlError::Blocked));
        assert_eq!(public_http_url("http://169.254.169.254/"), Err(UrlError::Blocked));
        assert!(public_http_url("https://example.com/a").is_ok());
    }

    #[test]
    fn extracts_entry_content_title_and_date() {
        let html = r#"<html><head>
            <title>Founder Mode | Site</title>
            <meta property="article:published_time" content="2024-09-01">
            <meta property="og:image" content="/cover.jpg">
            <meta name="author" content="Paul Graham">
            </head><body>
            <div class="entry-content"><p>This is a long enough paragraph about founder mode and how to run a company well when the usual advice stops working for you.</p></div>
            </body></html>"#;
        let got = extract_article(html, "https://paulgraham.com/foundermode.html").unwrap();
        assert_eq!(got.title, "Founder Mode");
        assert_eq!(got.author.as_deref(), Some("Paul Graham"));
        assert_eq!(got.date.as_deref(), Some("2024-09-01"));
        assert_eq!(got.thumbnail.as_deref(), Some("https://paulgraham.com/cover.jpg"));
        assert!(got.transcript.contains("founder mode"));
    }

    #[test]
    fn rejects_pages_without_readable_text() {
        let html = "<html><title>Hi</title><body><p>short</p></body></html>";
        assert!(extract_article(html, "https://example.com").is_err());
    }
}
