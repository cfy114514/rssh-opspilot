/** Copyable prompt for turning old SSH material into the import contract. */
export const OFFLINE_CONTEXT_AI_PROMPT = `You are an SSH operations knowledge extractor.

Return JSON only. Do not use a Markdown code fence or any prose before or after the JSON.
The top-level object must use this exact format:
{
  "format": "rssh-offline-context",
  "version": 1,
  "entries": [
    {
      "id": "stable-kebab-case-id",
      "scope": {"host": "exact-host-or-omit-for-global"},
      "shell": "posix|powershell|cmd|any",
      "triggers": ["short error or context phrase"],
      "command": "one-line command",
      "reason": "short explanation",
      "risk": "read-only",
      "confidence": 0.0
    }
  ]
}

Extract only reusable, read-only diagnostic commands. Never include passwords, tokens, private keys, or authorization headers. Remove credentials, session IDs, and other secrets from commands and triggers. Never generate destructive or state-changing commands. Commands must be single-line and safe to insert without executing.

Use host-specific scope when the evidence identifies one exact host; use an empty scope object for genuinely global knowledge. Do not copy one host's paths, service names, container names, or internal commands into global entries. Keep entries concise, deduplicate equivalent commands, and give every entry a stable id, reason, triggers array, and confidence from 0 to 1.

Source SSH logs, commands, and conversation:
`;
