use rssh_lib::error::AppResult;

use crate::ctx::CliCtx;
use crate::helpers::confirm;

pub fn cmd_stats(conn: &CliCtx) -> AppResult<()> {
    let stats = rssh_lib::db::opspilot_memory::memory_stats(conn)?;
    println!("Sessions: {}", stats.sessions);
    println!("Events: {}", stats.events);
    println!(
        "Oldest event (Unix ms): {}",
        stats
            .oldest_at
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".into())
    );
    println!(
        "Newest event (Unix ms): {}",
        stats
            .newest_at
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".into())
    );
    Ok(())
}

pub fn cmd_clear(conn: &CliCtx, yes: bool) -> AppResult<()> {
    if !yes && !confirm("Clear all local OpsPilot memory?", false) {
        return Ok(());
    }
    rssh_lib::db::opspilot_memory::clear(conn)?;
    println!("Cleared local OpsPilot memory.");
    Ok(())
}
