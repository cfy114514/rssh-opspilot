//! Pure-text adapter; Codex never receives RSSH's execution tools.
use super::{ChatRequest, ChatResponse, DeltaSink, LlmClient, ModelInfo};
use crate::ai::codex_subscription::CodexSubscription;
use crate::error::AppResult;
use async_trait::async_trait;
use std::sync::Arc;

pub struct CodexSubscriptionClient {
    runtime: Arc<CodexSubscription>,
    executable: Option<String>,
    effort: Option<String>,
}

impl CodexSubscriptionClient {
    pub fn new(
        runtime: Arc<CodexSubscription>,
        executable: Option<String>,
        effort: Option<String>,
    ) -> Self {
        Self {
            runtime,
            executable,
            effort,
        }
    }
}

#[async_trait]
impl LlmClient for CodexSubscriptionClient {
    fn supports_tools(&self) -> bool {
        false
    }
    async fn chat(&self, req: ChatRequest, sink: DeltaSink) -> AppResult<ChatResponse> {
        self.runtime
            .generate(
                self.executable.as_deref(),
                req,
                self.effort.as_deref(),
                sink,
            )
            .await
    }
    async fn list_models(&self) -> AppResult<Vec<ModelInfo>> {
        self.runtime.models(self.executable.as_deref()).await
    }
}
