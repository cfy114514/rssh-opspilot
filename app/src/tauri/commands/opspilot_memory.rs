use rssh_core::commands::opspilot_memory::*;
use rssh_core::db::opspilot_memory::*;
use rssh_core::error::AppResult;
use rssh_core::state::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn opspilot_session_start(
    state: State<'_, Arc<AppState>>,
    session: OpsPilotSessionInput,
) -> AppResult<i64> {
    session_start(&state.db, &session)
}

#[tauri::command]
pub fn opspilot_session_end(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    ended_at: i64,
) -> AppResult<()> {
    session_end(&state.db, &session_id, ended_at)
}

#[tauri::command]
pub fn opspilot_event_append(
    state: State<'_, Arc<AppState>>,
    event: OpsPilotEventInput,
) -> AppResult<()> {
    event_append(&state.db, &event)
}

#[tauri::command]
pub fn opspilot_feedback_stats(
    state: State<'_, Arc<AppState>>,
    scope: OpsPilotFeedbackScope,
) -> AppResult<Vec<OpsPilotFeedbackStat>> {
    feedback_stats(&state.db, &scope)
}

#[tauri::command]
pub fn opspilot_memory_stats(state: State<'_, Arc<AppState>>) -> AppResult<OpsPilotMemoryStats> {
    memory_stats(&state.db)
}

#[tauri::command]
pub fn opspilot_memory_clear(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    memory_clear(&state.db)
}
