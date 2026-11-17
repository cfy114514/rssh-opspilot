/**
 * Keep the mobile Tab button compatible with both OpsPilot completion and the
 * shell's native completion. A suggestion takes priority; otherwise the raw
 * control byte is preserved.
 */
export function routeMobileTab(
  hasSuggestion: boolean,
  acceptSuggestion: () => void,
  sendRawTab: () => void,
): void {
  if (hasSuggestion) {
    acceptSuggestion();
    return;
  }
  sendRawTab();
}
