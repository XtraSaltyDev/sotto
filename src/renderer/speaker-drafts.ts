export type SpeakerDrafts = Record<string, string>;

/**
 * Clears only the value that was successfully saved. A newer edit made while
 * the save was in flight, plus every other speaker draft, must survive.
 */
export const clearSavedSpeakerDraft = (
  drafts: SpeakerDrafts,
  speakerId: string,
  submittedLabel: string,
): SpeakerDrafts => {
  if (drafts[speakerId] !== submittedLabel) return drafts;

  const next = { ...drafts };
  delete next[speakerId];
  return next;
};
