use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::Db;
use crate::error::{AppError, AppResult};

pub const MAX_EVENTS: i64 = 5_000;

const MAX_ID_CHARS: usize = 255;
const MAX_TARGET_ID_CHARS: usize = 2_048;
const MAX_HOST_CHARS: usize = 255;
const MAX_CWD_CHARS: usize = 2_048;
const MAX_COMMAND_CHARS: usize = 4_096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsPilotTargetKind {
    Ssh,
    Local,
    DockerExec,
    KubectlExec,
}

impl OpsPilotTargetKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::Local => "local",
            Self::DockerExec => "docker_exec",
            Self::KubectlExec => "kubectl_exec",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsPilotEventKind {
    CommandObserved,
    SuggestionAccepted,
    SuggestionDismissed,
}

impl OpsPilotEventKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::CommandObserved => "command_observed",
            Self::SuggestionAccepted => "suggestion_accepted",
            Self::SuggestionDismissed => "suggestion_dismissed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsPilotCwdSource {
    Prompt,
    Unknown,
}

impl OpsPilotCwdSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsPilotExitSource {
    Unavailable,
    ShellIntegration,
}

impl OpsPilotExitSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::ShellIntegration => "shell_integration",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpsPilotSessionInput {
    pub id: String,
    pub target_kind: OpsPilotTargetKind,
    pub target_id: String,
    pub host: Option<String>,
    pub started_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpsPilotEventInput {
    pub id: String,
    pub session_id: String,
    pub source_block_id: Option<i64>,
    pub kind: OpsPilotEventKind,
    pub host: Option<String>,
    pub cwd: Option<String>,
    pub cwd_source: OpsPilotCwdSource,
    pub cwd_confidence: f64,
    pub command_redacted: Option<String>,
    pub suggestion_id: Option<String>,
    pub origin_suggestion_id: Option<String>,
    pub exit_code: Option<i32>,
    pub exit_source: OpsPilotExitSource,
    #[serde(default)]
    pub generation: i64,
    pub occurred_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpsPilotFeedbackScope {
    pub target_kind: OpsPilotTargetKind,
    pub target_id: String,
    pub host: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpsPilotFeedbackStat {
    pub suggestion_id: String,
    pub accepted: u64,
    pub dismissed: u64,
    pub scope_rank: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpsPilotMemoryStats {
    pub sessions: u64,
    pub events: u64,
    pub oldest_at: Option<i64>,
    pub newest_at: Option<i64>,
}

fn invalid(field: &'static str) -> AppError {
    AppError::config(
        "opspilot_memory_invalid",
        serde_json::json!({ "field": field }),
    )
}

fn validate_required(value: &str, field: &'static str) -> AppResult<()> {
    let len = value.chars().count();
    if value.trim().is_empty() || len > MAX_ID_CHARS {
        return Err(invalid(field));
    }
    Ok(())
}

fn validate_target_id(value: &str) -> AppResult<()> {
    let len = value.chars().count();
    if value.trim().is_empty() || len > MAX_TARGET_ID_CHARS {
        return Err(invalid("targetId"));
    }
    Ok(())
}

fn normalize_optional(value: &Option<String>) -> Option<String> {
    value.as_ref().filter(|v| !v.trim().is_empty()).cloned()
}

fn validate_optional(
    value: &Option<String>,
    field: &'static str,
    max_chars: usize,
) -> AppResult<()> {
    if value
        .as_ref()
        .is_some_and(|v| v.chars().count() > max_chars)
    {
        return Err(invalid(field));
    }
    Ok(())
}

fn validate_session(session: &OpsPilotSessionInput) -> AppResult<()> {
    validate_required(&session.id, "id")?;
    validate_target_id(&session.target_id)?;
    validate_optional(&session.host, "host", MAX_HOST_CHARS)?;
    if session.started_at < 0 {
        return Err(invalid("startedAt"));
    }
    Ok(())
}

fn validate_event(event: &OpsPilotEventInput) -> AppResult<()> {
    validate_required(&event.id, "id")?;
    validate_required(&event.session_id, "sessionId")?;
    validate_optional(&event.host, "host", MAX_HOST_CHARS)?;
    validate_optional(&event.cwd, "cwd", MAX_CWD_CHARS)?;
    validate_optional(
        &event.command_redacted,
        "commandRedacted",
        MAX_COMMAND_CHARS,
    )?;
    validate_optional(&event.suggestion_id, "suggestionId", MAX_ID_CHARS)?;
    validate_optional(
        &event.origin_suggestion_id,
        "originSuggestionId",
        MAX_ID_CHARS,
    )?;
    if event.occurred_at < 0
        || event.generation < 0
        || !event.cwd_confidence.is_finite()
        || !(0.0..=1.0).contains(&event.cwd_confidence)
        || event.source_block_id.is_some_and(|id| id < 0)
    {
        return Err(invalid("event"));
    }
    if event.exit_code.is_some() || event.exit_source != OpsPilotExitSource::Unavailable {
        return Err(invalid("exitState"));
    }

    match event.kind {
        OpsPilotEventKind::CommandObserved => {
            if event.source_block_id.is_none()
                || event
                    .command_redacted
                    .as_ref()
                    .is_none_or(|command| command.trim().is_empty())
                || event.suggestion_id.is_some()
            {
                return Err(invalid("commandObserved"));
            }
        }
        OpsPilotEventKind::SuggestionAccepted | OpsPilotEventKind::SuggestionDismissed => {
            if event.source_block_id.is_some()
                || event.command_redacted.is_some()
                || event.origin_suggestion_id.is_some()
                || event
                    .suggestion_id
                    .as_ref()
                    .is_none_or(|id| id.trim().is_empty())
            {
                return Err(invalid("suggestionEvent"));
            }
        }
    }
    Ok(())
}

pub fn start_session(db: &Db, session: &OpsPilotSessionInput) -> AppResult<i64> {
    validate_session(session)?;
    let host = normalize_optional(&session.host);
    db.with_transaction(|tx| {
        let generation: i64 = tx.query_row(
            "SELECT clear_generation FROM opspilot_memory_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO opspilot_sessions
             (id, target_kind, target_id, host, started_at, generation)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session.id,
                session.target_kind.as_str(),
                session.target_id,
                host,
                session.started_at,
                generation,
            ],
        )?;
        Ok(tx.query_row(
            "SELECT generation FROM opspilot_sessions WHERE id = ?1",
            [&session.id],
            |row| row.get(0),
        )?)
    })
}

pub fn end_session(db: &Db, id: &str, ended_at: i64) -> AppResult<()> {
    validate_required(id, "id")?;
    if ended_at < 0 {
        return Err(invalid("endedAt"));
    }
    db.with_transaction(|tx| {
        tx.execute(
            "UPDATE opspilot_sessions SET ended_at = ?2 WHERE id = ?1",
            params![id, ended_at],
        )?;
        tx.execute(
            "DELETE FROM opspilot_sessions
             WHERE id = ?1 AND NOT EXISTS (
                 SELECT 1 FROM opspilot_events WHERE session_id = ?1
             )",
            [id],
        )?;
        Ok(())
    })
}

pub fn append_event(db: &Db, event: &OpsPilotEventInput) -> AppResult<()> {
    validate_event(event)?;
    let host = normalize_optional(&event.host);
    let cwd = normalize_optional(&event.cwd);
    let command_redacted = normalize_optional(&event.command_redacted);
    let suggestion_id = normalize_optional(&event.suggestion_id);
    let origin_suggestion_id = normalize_optional(&event.origin_suggestion_id);

    db.with_transaction(|tx| {
        let clear_generation: i64 = tx.query_row(
            "SELECT clear_generation FROM opspilot_memory_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        if event.generation != clear_generation {
            return Err(AppError::config(
                "opspilot_event_stale_generation",
                serde_json::json!({}),
            ));
        }
        let session_generation: Option<i64> = tx
            .query_row(
                "SELECT generation FROM opspilot_sessions WHERE id = ?1",
                [&event.session_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(session_generation) = session_generation else {
            return Err(AppError::not_found(
                "opspilot_session_missing",
                serde_json::json!({ "id": event.session_id }),
            ));
        };
        if session_generation != event.generation {
            return Err(AppError::config(
                "opspilot_event_stale_generation",
                serde_json::json!({}),
            ));
        }
        tx.execute(
            "INSERT INTO opspilot_events
             (id, session_id, source_block_id, kind, host, cwd, cwd_source,
              cwd_confidence, command_redacted, suggestion_id, origin_suggestion_id,
              exit_code, exit_source, generation, occurred_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT DO NOTHING",
            params![
                event.id,
                event.session_id,
                event.source_block_id,
                event.kind.as_str(),
                host,
                cwd,
                event.cwd_source.as_str(),
                event.cwd_confidence,
                command_redacted,
                suggestion_id,
                origin_suggestion_id,
                event.exit_code,
                event.exit_source.as_str(),
                event.generation,
                event.occurred_at,
            ],
        )?;
        // Remember only sessions that actually own rows selected for trimming.
        // Deleting every zero-event session here would race a newly started
        // terminal that has not produced its first command yet.
        let trimmed_session_ids = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT session_id FROM (
                     SELECT session_id FROM opspilot_events
                     ORDER BY occurred_at DESC, id DESC
                     LIMIT -1 OFFSET ?1
                 )",
            )?;
            let ids = stmt
                .query_map([MAX_EVENTS], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        tx.execute(
            "DELETE FROM opspilot_events
             WHERE id IN (
                 SELECT id FROM opspilot_events
                 ORDER BY occurred_at DESC, id DESC
                 LIMIT -1 OFFSET ?1
             );",
            [MAX_EVENTS],
        )?;
        for session_id in trimmed_session_ids {
            tx.execute(
                "DELETE FROM opspilot_sessions
                 WHERE id = ?1 AND NOT EXISTS (
                     SELECT 1 FROM opspilot_events WHERE session_id = ?1
                 )",
                [session_id],
            )?;
        }
        Ok(())
    })
}

pub fn feedback_stats(
    db: &Db,
    scope: &OpsPilotFeedbackScope,
) -> AppResult<Vec<OpsPilotFeedbackStat>> {
    validate_target_id(&scope.target_id)?;
    validate_optional(&scope.host, "host", MAX_HOST_CHARS)?;
    validate_optional(&scope.cwd, "cwd", MAX_CWD_CHARS)?;
    let host = normalize_optional(&scope.host);
    let cwd = normalize_optional(&scope.cwd);
    let conn = db.lock()?;
    let mut stmt = conn.prepare(
        "WITH matched AS (
             SELECT e.suggestion_id,
                    e.kind,
                    CASE
                      WHEN ?3 IS NOT NULL AND ?4 IS NOT NULL
                           AND s.target_kind = ?1 AND s.target_id = ?2
                           AND e.host = ?3 AND e.cwd = ?4 THEN 3
                      WHEN ?3 IS NOT NULL
                           AND s.target_kind = ?1 AND s.target_id = ?2
                           AND e.host = ?3 THEN 2
                      WHEN s.target_kind = ?1 AND s.target_id = ?2 THEN 1
                      ELSE 0
                    END AS scope_rank
             FROM opspilot_events e
             JOIN opspilot_sessions s ON s.id = e.session_id
             WHERE e.suggestion_id IS NOT NULL
               AND e.kind IN ('suggestion_accepted', 'suggestion_dismissed')
         ), scoped AS (
             SELECT * FROM matched WHERE scope_rank > 0
         ), best AS (
             SELECT suggestion_id, MAX(scope_rank) AS scope_rank
             FROM scoped
             GROUP BY suggestion_id
         )
         SELECT m.suggestion_id,
                SUM(CASE WHEN m.kind = 'suggestion_accepted' THEN 1 ELSE 0 END),
                SUM(CASE WHEN m.kind = 'suggestion_dismissed' THEN 1 ELSE 0 END),
                b.scope_rank
         FROM scoped m
         JOIN best b
           ON b.suggestion_id = m.suggestion_id
          AND b.scope_rank = m.scope_rank
         GROUP BY m.suggestion_id, b.scope_rank
         ORDER BY m.suggestion_id",
    )?;
    let rows = stmt
        .query_map(
            params![scope.target_kind.as_str(), scope.target_id, host, cwd],
            |row| {
                Ok(OpsPilotFeedbackStat {
                    suggestion_id: row.get(0)?,
                    accepted: row.get::<_, i64>(1)? as u64,
                    dismissed: row.get::<_, i64>(2)? as u64,
                    scope_rank: row.get::<_, i64>(3)? as u8,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn memory_stats(db: &Db) -> AppResult<OpsPilotMemoryStats> {
    let conn = db.lock()?;
    let (sessions, events, oldest_at, newest_at): (i64, i64, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM opspilot_sessions),
                 COUNT(*), MIN(occurred_at), MAX(occurred_at)
             FROM opspilot_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    Ok(OpsPilotMemoryStats {
        sessions: sessions as u64,
        events: events as u64,
        oldest_at,
        newest_at,
    })
}

pub fn clear(db: &Db) -> AppResult<()> {
    db.with_transaction(|tx| {
        let current_generation: i64 = tx.query_row(
            "SELECT clear_generation FROM opspilot_memory_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let next_generation = current_generation
            .checked_add(1)
            .ok_or_else(|| invalid("clearGeneration"))?;
        tx.execute("DELETE FROM opspilot_events", [])?;
        tx.execute("DELETE FROM opspilot_sessions", [])?;
        tx.execute(
            "UPDATE opspilot_memory_state SET clear_generation = ?1 WHERE singleton = 1",
            [next_generation],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, started_at: i64) -> OpsPilotSessionInput {
        OpsPilotSessionInput {
            id: id.into(),
            target_kind: OpsPilotTargetKind::Ssh,
            target_id: "profile-1".into(),
            host: Some("app.example".into()),
            started_at,
        }
    }

    fn command_event(session_id: &str, index: i64) -> OpsPilotEventInput {
        OpsPilotEventInput {
            id: format!("event-{index:05}"),
            session_id: session_id.into(),
            source_block_id: Some(index),
            kind: OpsPilotEventKind::CommandObserved,
            host: Some("app.example".into()),
            cwd: Some("/srv/app".into()),
            cwd_source: OpsPilotCwdSource::Prompt,
            cwd_confidence: 0.8,
            command_redacted: Some(format!("echo {index}")),
            suggestion_id: None,
            origin_suggestion_id: None,
            exit_code: None,
            exit_source: OpsPilotExitSource::Unavailable,
            generation: 0,
            occurred_at: index,
        }
    }

    fn feedback_event(
        id: &str,
        session_id: &str,
        suggestion_id: &str,
        kind: OpsPilotEventKind,
        host: Option<&str>,
        cwd: Option<&str>,
        occurred_at: i64,
    ) -> OpsPilotEventInput {
        OpsPilotEventInput {
            id: id.into(),
            session_id: session_id.into(),
            source_block_id: None,
            kind,
            host: host.map(str::to_owned),
            cwd: cwd.map(str::to_owned),
            cwd_source: OpsPilotCwdSource::Unknown,
            cwd_confidence: 0.0,
            command_redacted: None,
            suggestion_id: Some(suggestion_id.into()),
            origin_suggestion_id: None,
            exit_code: None,
            exit_source: OpsPilotExitSource::Unavailable,
            generation: 0,
            occurred_at,
        }
    }

    #[test]
    fn validates_sessions_and_events_before_writing() {
        let db = crate::db::Db::open_in_memory().unwrap();

        let mut invalid_session = session(" ", 1);
        assert!(start_session(&db, &invalid_session).is_err());
        invalid_session = session("valid", -1);
        assert!(start_session(&db, &invalid_session).is_err());

        start_session(&db, &session("valid", 1)).unwrap();
        let mut invalid_event = command_event("valid", 1);
        invalid_event.cwd_confidence = f64::NAN;
        assert!(append_event(&db, &invalid_event).is_err());
        invalid_event = command_event("valid", 2);
        invalid_event.command_redacted = Some("".into());
        assert!(append_event(&db, &invalid_event).is_err());
        invalid_event = command_event("valid", 3);
        invalid_event.host = Some("界".repeat(256));
        assert!(append_event(&db, &invalid_event).is_err());
        invalid_event = command_event("valid", 4);
        invalid_event.exit_code = Some(0);
        assert_eq!(
            append_event(&db, &invalid_event).unwrap_err().code(),
            "opspilot_memory_invalid"
        );
        invalid_event = command_event("valid", 5);
        invalid_event.exit_source = OpsPilotExitSource::ShellIntegration;
        assert_eq!(
            append_event(&db, &invalid_event).unwrap_err().code(),
            "opspilot_memory_invalid"
        );

        assert_eq!(memory_stats(&db).unwrap().events, 0);
    }

    #[test]
    fn session_start_is_idempotent_and_end_persists_for_nonempty_session() {
        let db = crate::db::Db::open_in_memory().unwrap();
        start_session(&db, &session("session-1", 1)).unwrap();
        let mut duplicate = session("session-1", 99);
        duplicate.host = Some("changed.example".into());
        start_session(&db, &duplicate).unwrap();
        append_event(&db, &command_event("session-1", 2)).unwrap();
        end_session(&db, "session-1", 3).unwrap();

        let conn = db.lock().unwrap();
        let row: (String, i64, Option<i64>) = conn
            .query_row(
                "SELECT host, started_at, ended_at FROM opspilot_sessions WHERE id = 'session-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("app.example".into(), 1, Some(3)));
    }

    #[test]
    fn ending_a_zero_event_session_removes_it() {
        let db = crate::db::Db::open_in_memory().unwrap();
        start_session(&db, &session("empty", 1)).unwrap();
        end_session(&db, "empty", 2).unwrap();
        assert_eq!(memory_stats(&db).unwrap().sessions, 0);
    }

    #[test]
    fn command_block_append_is_idempotent() {
        let db = crate::db::Db::open_in_memory().unwrap();
        start_session(&db, &session("session-1", 1)).unwrap();
        append_event(&db, &command_event("session-1", 1)).unwrap();
        let mut duplicate = command_event("session-1", 1);
        duplicate.id = "different-event-id".into();
        append_event(&db, &duplicate).unwrap();
        assert_eq!(memory_stats(&db).unwrap().events, 1);
    }

    #[test]
    fn accepts_connector_target_ids_longer_than_uuid_sized_ids() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let mut long_target = session("long-target", 1);
        long_target.target_id = "k".repeat(2_048);
        start_session(&db, &long_target).unwrap();

        long_target.id = "too-long-target".into();
        long_target.target_id.push('x');
        assert_eq!(
            start_session(&db, &long_target).unwrap_err().code(),
            "opspilot_memory_invalid"
        );
    }

    #[test]
    fn feedback_uses_only_the_best_available_scope_per_suggestion() {
        let db = crate::db::Db::open_in_memory().unwrap();
        start_session(&db, &session("session-1", 1)).unwrap();
        let mut unrelated_session = session("unrelated-session", 1);
        unrelated_session.target_id = "profile-2".into();
        start_session(&db, &unrelated_session).unwrap();
        append_event(
            &db,
            &feedback_event(
                "global",
                "session-1",
                "logs",
                OpsPilotEventKind::SuggestionDismissed,
                None,
                None,
                1,
            ),
        )
        .unwrap();
        append_event(
            &db,
            &feedback_event(
                "unrelated",
                "unrelated-session",
                "unrelated-suggestion",
                OpsPilotEventKind::SuggestionAccepted,
                Some("other.example"),
                Some("/other"),
                4,
            ),
        )
        .unwrap();
        append_event(
            &db,
            &feedback_event(
                "host",
                "session-1",
                "logs",
                OpsPilotEventKind::SuggestionDismissed,
                Some("app.example"),
                None,
                2,
            ),
        )
        .unwrap();
        append_event(
            &db,
            &feedback_event(
                "exact",
                "session-1",
                "logs",
                OpsPilotEventKind::SuggestionAccepted,
                Some("app.example"),
                Some("/srv/app"),
                3,
            ),
        )
        .unwrap();

        let stats = feedback_stats(
            &db,
            &OpsPilotFeedbackScope {
                target_kind: OpsPilotTargetKind::Ssh,
                target_id: "profile-1".into(),
                host: Some("app.example".into()),
                cwd: Some("/srv/app".into()),
            },
        )
        .unwrap();
        assert_eq!(
            stats,
            vec![OpsPilotFeedbackStat {
                suggestion_id: "logs".into(),
                accepted: 1,
                dismissed: 0,
                scope_rank: 3,
            }]
        );
    }

    #[test]
    fn clear_removes_sessions_and_events() {
        let db = crate::db::Db::open_in_memory().unwrap();
        start_session(&db, &session("session-1", 1)).unwrap();
        append_event(&db, &command_event("session-1", 2)).unwrap();
        clear(&db).unwrap();
        assert_eq!(
            memory_stats(&db).unwrap(),
            OpsPilotMemoryStats {
                sessions: 0,
                events: 0,
                oldest_at: None,
                newest_at: None,
            }
        );
    }

    #[test]
    fn clear_watermark_rejects_queued_old_events_but_allows_a_restarted_session() {
        let db = crate::db::Db::open_in_memory().unwrap();
        start_session(&db, &session("session-1", 1)).unwrap();
        append_event(&db, &command_event("session-1", 10)).unwrap();
        clear(&db).unwrap();

        let mut old = command_event("session-1", 15);
        old.id = "queued-before-clear".into();
        assert_eq!(
            append_event(&db, &old).unwrap_err().code(),
            "opspilot_event_stale_generation"
        );

        let mut fresh = command_event("session-1", 21);
        fresh.id = "after-clear".into();
        fresh.generation = 1;
        assert_eq!(
            append_event(&db, &fresh).unwrap_err().code(),
            "opspilot_session_missing"
        );
        start_session(&db, &session("session-1", 1)).unwrap();
        append_event(&db, &fresh).unwrap();
        assert_eq!(memory_stats(&db).unwrap().events, 1);
    }

    #[test]
    fn clear_allows_new_events_when_the_wall_clock_moves_backward() {
        let db = crate::db::Db::open_in_memory().unwrap();
        start_session(&db, &session("session-1", 10)).unwrap();
        append_event(&db, &command_event("session-1", 20)).unwrap();
        clear(&db).unwrap();
        start_session(&db, &session("session-1", 0)).unwrap();

        let mut restarted = command_event("session-1", 0);
        restarted.id = "after-clock-rollback".into();
        restarted.generation = 1;
        append_event(&db, &restarted).unwrap();
        assert_eq!(memory_stats(&db).unwrap().events, 1);
    }

    #[test]
    fn append_caps_events_and_removes_orphan_sessions() {
        let db = crate::db::Db::open_in_memory().unwrap();
        start_session(&db, &session("kept", 1)).unwrap();
        start_session(&db, &session("trimmed", 0)).unwrap();
        for index in 0..(MAX_EVENTS + 3) {
            let owner = if index < 3 { "trimmed" } else { "kept" };
            append_event(&db, &command_event(owner, index)).unwrap();
        }

        let stats = memory_stats(&db).unwrap();
        assert_eq!(stats.events, MAX_EVENTS as u64);
        assert_eq!(stats.sessions, 1);
        assert_eq!(stats.oldest_at, Some(3));
        assert_eq!(stats.newest_at, Some(MAX_EVENTS + 2));
    }
}
