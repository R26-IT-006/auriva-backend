'use strict';

// Deterministic, rule-based grouping of letters by dominant motor primitive —
// NOT a machine-learned clustering. Used to roll per-letter progress up into
// broader stroke-pattern categories for the teacher report (Motor Pattern
// Progress section). Every letter the app teaches (a-z, A-Z) must land in
// exactly one group; anything not explicitly listed below falls into
// 'mixed' by design, not by omission.
//
// Case matters: a letter's lowercase and uppercase forms can differ in
// dominant stroke shape (e.g. 'a' is curved, 'A' is diagonal), so they are
// classified independently.

const CURVED              = ['a', 'c', 'e', 'o', 's', 'g', 'C', 'O', 'S', 'G'];
const DIAGONAL             = ['v', 'w', 'x', 'y', 'z', 'k', 'A', 'V', 'W', 'X', 'Y', 'Z', 'K'];
const VERTICAL_HORIZONTAL  = ['i', 'l', 't', 'f', 'E', 'F', 'H', 'I', 'L', 'T'];

const ALL_LETTERS = [
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
];

const explicitlyGrouped = new Set([...CURVED, ...DIAGONAL, ...VERTICAL_HORIZONTAL]);
const MIXED = ALL_LETTERS.filter(letter => !explicitlyGrouped.has(letter));

const LETTER_TO_PRIMITIVE = {};
for (const letter of CURVED)              LETTER_TO_PRIMITIVE[letter] = 'curved';
for (const letter of DIAGONAL)            LETTER_TO_PRIMITIVE[letter] = 'diagonal';
for (const letter of VERTICAL_HORIZONTAL) LETTER_TO_PRIMITIVE[letter] = 'vertical_horizontal';
for (const letter of MIXED)                LETTER_TO_PRIMITIVE[letter] = 'mixed';

const PRIMITIVE_LABELS = {
  curved:              'Curved strokes',
  diagonal:            'Diagonal strokes',
  vertical_horizontal: 'Vertical/horizontal strokes',
  mixed:               'Mixed strokes',
};

module.exports = {
  LETTER_TO_PRIMITIVE,
  PRIMITIVE_LABELS,
  PRIMITIVE_GROUPS: {
    curved:              CURVED,
    diagonal:            DIAGONAL,
    vertical_horizontal: VERTICAL_HORIZONTAL,
    mixed:               MIXED,
  },
};
