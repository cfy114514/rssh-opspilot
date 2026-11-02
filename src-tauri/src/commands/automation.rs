use tauri::State;

use crate::automation::{
    AutomationStatus, ConnectionInfo, SharedTerminal, TerminalReply, TerminalRequest,
};
use crate::error::AppResult;
use crate::state::{AppState, SessionOwner};

#[tauri::command]
pub async fn automation_start(
    window: tauri::Window,
    state: State<'_, AppState>,
    writable: bool,
) -> AppResult<ConnectionInfo> {
    state
        .automation
        .start(&SessionOwner::Window(window.label().into()), writable)
}

#[tauri::command]
pub fn automation_poll(
    window: tauri::Window,
    state: State<'_, AppState>,
    bridge_id: String,
    sessions: Vec<SharedTerminal>,
) -> AppResult<Vec<TerminalRequest>> {
    state.automation.poll(
        &SessionOwner::Window(window.label().into()),
        &bridge_id,
        sessions,
    )
}

#[tauri::command]
pub fn automation_reply(
    window: tauri::Window,
    state: State<'_, AppState>,
    bridge_id: String,
    reply: TerminalReply,
) -> AppResult<()> {
    state.automation.reply(
        &SessionOwner::Window(window.label().into()),
        &bridge_id,
        reply,
    )
}

#[tauri::command]
pub fn automation_stop(
    window: tauri::Window,
    state: State<'_, AppState>,
    bridge_id: Option<String>,
) {
    state.automation.stop_bridge(
        &SessionOwner::Window(window.label().into()),
        bridge_id.as_deref(),
    );
}

#[tauri::command]
pub fn automation_status(state: State<'_, AppState>) -> AppResult<Option<AutomationStatus>> {
    state.automation.status()
}
