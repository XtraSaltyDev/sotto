import { describe, expect, it } from 'vitest';

import { clearSavedSpeakerDraft } from './speaker-drafts';

describe('clearSavedSpeakerDraft', () => {
  it('clears the saved speaker without erasing other unsaved names', () => {
    expect(
      clearSavedSpeakerDraft(
        { first: 'Alex', second: 'Sam', third: 'Taylor' },
        'first',
        'Alex',
      ),
    ).toEqual({ second: 'Sam', third: 'Taylor' });
  });

  it('keeps a newer edit made while the prior value was saving', () => {
    const drafts = { first: 'Alex Morgan', second: 'Sam' };

    expect(clearSavedSpeakerDraft(drafts, 'first', 'Alex')).toBe(drafts);
  });
});
