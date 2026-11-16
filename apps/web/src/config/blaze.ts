/**
 * The BLAZE 2026 banner (DESIGN.md §3). Every value the rules require lives here, in one place.
 *
 * TODO(blaze): the deck URL, the repo URL and the EMBER2026 vote address are placeholders until the team
 * sends the real ones. Replace the three values marked TODO below; nothing else in the app hard-codes them.
 */
export const BLAZE = {
  event: 'BLAZE 2026',

  /** TODO(blaze): the Widget Factory deck link. */
  deckUrl: 'https://example.com/TODO-sigsig-deck',

  /** TODO(blaze): the public repository URL. */
  repoUrl: 'https://github.com/TODO/sigsig',

  /**
   * TODO(blaze): the EMBER2026 vote address, in the token-aware CashAddr form (bitcoincash:z…).
   * This is a placeholder string, not a real address: do not send anything to it.
   */
  voteAddress: 'bitcoincash:zTODO0placeholder0vote0address0ember2026',
  voteToken: 'EMBER2026',

  /** The project this re-implements, credited on every page. */
  credit: {
    name: 'Cermin',
    note: 'Mezo Hackathon 2',
    url: 'https://github.com/yeheskieltame/Cermin',
  },
} as const;

/** True while any banner value above is still a placeholder (the banner marks them for the team). */
export const BLAZE_HAS_PLACEHOLDERS =
  BLAZE.deckUrl.includes('TODO') || BLAZE.repoUrl.includes('TODO') || BLAZE.voteAddress.includes('TODO');
