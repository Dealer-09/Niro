// skills.rs — Local markdown skill fragments injected into the system prompt on keyword match.
// Design: no remote registry, no executable skills, no auto-install.
// Skills are markdown files in %APPDATA%\com.dealer09.niro\skills\*.md with optional
// YAML-style frontmatter (name:, description:, when_to_use:).
// Built-in skills are embedded as Rust string literals.
use std::fs;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::Manager;

#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub when_to_use: String, // comma-separated keywords
    pub content: String,
}

// ── Built-in skills ────────────────────────────────────────────────────────
// Format: (name, when_to_use keywords, content)
// ponytail: inline as const, no external file
const BUILTIN: &[(&str, &str, &str)] = &[
    (
        "Email Composer",
        "compose email,write email,draft email,help me write an email,email to",
        "You are helping compose a professional email. \
Follow these rules: \
1. Ask for recipient, subject, and key points if not provided. \
2. Use a clear subject line. \
3. Keep the body concise and professional. \
4. End with an appropriate sign-off. \
5. After composing, offer to send via send_email tool or let the user copy it.",
    ),
    (
        "System Monitor",
        "system status,how is my pc,pc health,system info,monitor my system,full system report",
        "When asked for a system status or health report, gather ALL of: \
CPU model + cores, RAM total + free, Disk C free/total, uptime hours, Windows version, computer name, and top 5 CPU processes. \
Present results in a clean summary. Use run_command for each metric.",
    ),
    (
        "File Manager",
        "find my files,organize files,search documents,find documents,file on my desktop,file in downloads",
        "When helping find or manage files: \
1. Use search_files with the appropriate directory (Desktop, Downloads, Documents). \
2. Report exact paths, sizes, and dates. \
3. Offer to open the first result if relevant. \
4. Never delete files without explicit user confirmation.",
    ),
];

// ── Skills cache ───────────────────────────────────────────────────────────
static SKILLS: Lazy<Mutex<Vec<Skill>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Load built-in skills + any user *.md files from the app data skills dir.
/// Call once on startup; safe to call again to reload user skills.
pub fn load_skills(app: &tauri::AppHandle) {
    let mut skills: Vec<Skill> = BUILTIN.iter().map(|&(name, when, content)| Skill {
        name: name.into(),
        when_to_use: when.into(),
        content: content.into(),
    }).collect();

    // Load user skills from %APPDATA%\com.dealer09.niro\skills\*.md
    // Falls back gracefully if dir doesn't exist yet.
    if let Ok(data_dir) = app.path().app_data_dir() {
        let skills_dir = data_dir.join("skills");
        if let Ok(entries) = fs::read_dir(&skills_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |e| e == "md") {
                    if let Ok(raw) = fs::read_to_string(&path) {
                        if let Some(skill) = parse_skill_md(&raw) {
                            skills.push(skill);
                        }
                    }
                }
            }
        }
    }

    *SKILLS.lock() = skills;
}

/// Check if any loaded skill matches the message. Returns the skill's content block
/// (formatted for prompt injection) if matched, else None.
pub fn match_skill(message: &str) -> Option<String> {
    let lower = message.to_lowercase();
    let cache = SKILLS.lock();
    for skill in cache.iter() {
        let keywords: Vec<&str> = skill.when_to_use.split(',').map(str::trim).collect();
        if keywords.iter().any(|kw| !kw.is_empty() && lower.contains(kw)) {
            return Some(format!(
                "ACTIVE SKILL — {} (follow these instructions for this request):\n{}",
                skill.name, skill.content
            ));
        }
    }
    None
}

// ── Markdown frontmatter parser ────────────────────────────────────────────
// Expects optional frontmatter block:
//   ---
//   name: Email Composer
//   when_to_use: compose email, draft email
//   ---
//   <body content>
//
// If no frontmatter, uses filename stem as name and first line as when_to_use.
// ponytail: simple line-by-line parse, no YAML lib needed
fn parse_skill_md(raw: &str) -> Option<Skill> {
    let mut name = String::new();
    let mut when_to_use = String::new();
    let mut content_start = 0;

    if raw.trim_start().starts_with("---") {
        let rest = raw.trim_start().trim_start_matches("---").trim_start_matches('\n');
        if let Some(end) = rest.find("\n---") {
            let front = &rest[..end];
            for line in front.lines() {
                if let Some(v) = line.strip_prefix("name:") {
                    name = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("when_to_use:") {
                    when_to_use = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("description:") {
                    // description doubles as when_to_use if when_to_use not set
                    if when_to_use.is_empty() { when_to_use = v.trim().to_string(); }
                }
            }
            content_start = raw.find("\n---").map(|i| i + 4).unwrap_or(0);
        }
    }

    let content = raw[content_start..].trim().to_string();
    if content.is_empty() { return None; }
    if name.is_empty() { name = "Custom Skill".into(); }
    if when_to_use.is_empty() { when_to_use = name.to_lowercase(); }

    Some(Skill { name, when_to_use, content })
}
