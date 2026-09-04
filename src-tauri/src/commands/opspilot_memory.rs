use tauri::State;

use crate::db::opspilot_memory::{self, *};
use crate::error::AppResult;
use crate::state::AppState;

pub fn session_start(db: &crate::db::Db, session: &OpsPilotSessionInput) -> AppResult<i64> {
    opspilot_memory::start_session(db, session)
}

pub fn session_end(db: &crate::db::Db, session_id: &str, ended_at: i64) -> AppResult<()> {
    opspilot_memory::end_session(db, session_id, ended_at)
}

pub fn event_append(db: &crate::db::Db, event: &OpsPilotEventInput) -> AppResult<()> {
    opspilot_memory::append_event(db, event)
}

pub fn feedback_stats(
    db: &crate::db::Db,
    scope: &OpsPilotFeedbackScope,
) -> AppResult<Vec<OpsPilotFeedbackStat>> {
    opspilot_memory::feedback_stats(db, scope)
}

pub fn memory_stats(db: &crate::db::Db) -> AppResult<OpsPilotMemoryStats> {
    opspilot_memory::memory_stats(db)
}

pub fn memory_clear(db: &crate::db::Db) -> AppResult<()> {
    opspilot_memory::clear(db)
}

#[tauri::command]
pub fn opspilot_session_start(
    state: State<'_, AppState>,
    session: OpsPilotSessionInput,
) -> AppResult<i64> {
    session_start(&state.db, &session)
}

#[tauri::command]
pub fn opspilot_session_end(
    state: State<'_, AppState>,
    session_id: String,
    ended_at: i64,
) -> AppResult<()> {
    session_end(&state.db, &session_id, ended_at)
}

#[tauri::command]
pub fn opspilot_event_append(
    state: State<'_, AppState>,
    event: OpsPilotEventInput,
) -> AppResult<()> {
    event_append(&state.db, &event)
}

#[tauri::command]
pub fn opspilot_feedback_stats(
    state: State<'_, AppState>,
    scope: OpsPilotFeedbackScope,
) -> AppResult<Vec<OpsPilotFeedbackStat>> {
    feedback_stats(&state.db, &scope)
}

#[tauri::command]
pub fn opspilot_memory_stats(state: State<'_, AppState>) -> AppResult<OpsPilotMemoryStats> {
    memory_stats(&state.db)
}

#[tauri::command]
pub fn opspilot_memory_clear(state: State<'_, AppState>) -> AppResult<()> {
    memory_clear(&state.db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::opspilot_memory::{
        OpsPilotCwdSource, OpsPilotEventInput, OpsPilotEventKind, OpsPilotExitSource,
        OpsPilotSessionInput, OpsPilotTargetKind,
    };

    #[test]
    fn wrappers_share_the_domain_contract_and_error_codes() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let session = OpsPilotSessionInput {
            id: "session-1".into(),
            target_kind: OpsPilotTargetKind::Ssh,
            target_id: "profile-1".into(),
            host: Some("app.example".into()),
            started_at: 1,
        };
        assert_eq!(session_start(&db, &session).unwrap(), 0);
        event_append(
            &db,
            &OpsPilotEventInput {
                id: "event-1".into(),
                session_id: session.id.clone(),
                source_block_id: Some(1),
                kind: OpsPilotEventKind::CommandObserved,
                host: session.host.clone(),
                cwd: Some("/srv/app".into()),
                cwd_source: OpsPilotCwdSource::Prompt,
                cwd_confidence: 0.8,
                command_redacted: Some("pwd".into()),
                suggestion_id: None,
                origin_suggestion_id: None,
                exit_code: None,
                exit_source: OpsPilotExitSource::Unavailable,
                generation: 0,
                occurred_at: 2,
            },
        )
        .unwrap();
        assert_eq!(memory_stats(&db).unwrap().events, 1);
        session_end(&db, &session.id, 3).unwrap();

        let mut invalid = session;
        invalid.id.clear();
        assert_eq!(
            session_start(&db, &invalid).unwrap_err().code(),
            "opspilot_memory_invalid"
        );
        memory_clear(&db).unwrap();
        assert_eq!(memory_stats(&db).unwrap().events, 0);
    }
}
