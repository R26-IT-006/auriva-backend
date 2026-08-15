# Feature 9 — Teacher Validation + Long-Term History: Persistence Design

**Status as of Step 2: DESIGN ONLY.** This document describes the table,
trust model, and race/idempotency contracts a future Step 3 migration and
model will implement. No migration exists yet, no model exists yet, no
route exists yet, and nothing in the running application reads or writes
this shape. `src/config/feature9Provenance.js` (Step 2) is the only code
this document depends on so far — two policy-version constants and two
pure fingerprint helpers, described in full in that file's own header
comment.

## 1. Purpose

Feature 9 stores human teacher judgements about Feature 8 educational
practice recommendations. It answers two questions and preserves the
answers over time:

1. What did the system recommend?
2. What did the teacher think about that recommendation?

It does **not** store clinical validation, diagnosis, severity, or
treatment approval. A `confirmed`/`dismissed` judgement means only that a
teacher agrees or disagrees that a practice recommendation is currently
suitable — never that a difficulty was proven or disproven, and never a
statement about the student's clinical status.

## 2. Append-only rule

**No UPDATE. No DELETE.** Every teacher action — including a teacher
changing their mind about the same recommendation — appends a new row.
History is a sequence of events, never a single mutable "current judgement"
field. This mirrors `student_threshold_history`'s own established
append-only precedent (Feature 2) rather than the mutable
`find­OrCreate`+`update` pattern the pre-existing, unrelated
`teacher_validation` table (collection-mode quality ratings) uses — that
table's pattern is deliberately not reused here (Step 1 audit §3/§25).

## 3. Write trigger

A history row is written **only** when a teacher explicitly presses
**Confirm** or **Not suitable**. It is never written as a side effect of:

- `GET` (reading current recommendations or history),
- the teacher opening or re-opening the report screen,
- `TeacherReportScreen.js`'s existing `useFocusEffect` re-fetching Feature 8
  recommendations on every screen focus,
- a card simply rendering.

This is the same discipline Feature 7/8's own read-only endpoints already
follow (no write ever happens from a GET) — Feature 9's write path is new,
but the "reads never write" boundary is not.

## 4. Target table (not yet migrated)

`teacher_recommendation_validations` — one append-only row per teacher
action, snapshotting the exact recommendation the teacher saw plus their
judgement.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER, PK | |
| `student_id` | INTEGER | no DB-level FK, matching every other table in this schema (`letter_attempts`, `student_threshold_history`) |
| `teacher_id` | INTEGER | always `req.user.id` server-side, never client-supplied (Step 1 audit §9/§43) |
| `case_type` | STRING(20) | `lowercase` \| `uppercase` |
| `family` | STRING(20) | `straight` \| `curved` \| `complex` |
| `recommendation_type` | STRING(50) | e.g. `motor_family_practice` |
| `recommendation_title` | STRING(200) | snapshot |
| `focus_letters` | JSONB | snapshot, order preserved exactly as Feature 8 returned it |
| `suggested_activities` | JSONB | snapshot |
| `rationale` | TEXT | snapshot |
| `validation` | STRING(20) | `confirmed` \| `dismissed` only |
| `teacher_note` | TEXT, nullable | optional; max length deferred to Step 3 (§7 below) |
| `evidence_fingerprint` | STRING(64) | from `computePersistentEvidenceFingerprint()` |
| `recommendation_fingerprint` | STRING(64) | from `computeWorksheetRecommendationFingerprint()` |
| `persistent_policy_version` | STRING(30) | `PERSISTENT_DIFFICULTY_POLICY_VERSION` |
| `recommendation_policy_version` | STRING(30) | `WORKSHEET_RECOMMENDATION_POLICY_VERSION` |
| `mapping_version` | STRING(30) | `letterBaselineFamilies.js`'s own `MAPPING_VERSION`, reused verbatim — never a second `feature9_mapping_v1` scheme |
| `created_at` | DATE | the one and only timestamp this table needs — an append-only row's insertion moment *is* the event moment; no separate `validated_at` (Step 1 audit §55) |

This table is **not created in Step 2**. It is documented here so Step 3's
migration has a single, already-reviewed target to implement against.

## 5. Validation vocabulary

Exactly two persisted values: `confirmed`, `dismissed`. No `modified`,
`approved`, `rejected`, `correct`, or `incorrect`.

UI wording mapping (machine vocabulary is never shown to a teacher
verbatim):

| Persisted value | Teacher-facing label |
|---|---|
| `confirmed` | Confirmed |
| `dismissed` | Not suitable |

"Not suitable" is used instead of "Incorrect" deliberately (Step 1 audit
§11) — teacher disagreement does not mean the system was objectively
wrong; it means the recommendation is not appropriate for this student
right now.

## 6. Snapshot policy

Every event stores the recommendation content (`recommendation_title`,
`focus_letters`, `suggested_activities`, `rationale`) at the moment the
teacher acted, even though Feature 8 can recompute a current recommendation
on demand at any time. This is deliberate: history must preserve **what the
teacher actually saw**, not what Feature 8 would compute if re-run today.
Feature 8's recommendation content or policy may change later — the
historical row must remain interpretable exactly as it was at the time,
the same discipline `docs/feature7-persistence-design.md` §5 already
established for a hypothetical Feature 7 event table.

## 7. Teacher note

Optional, nullable. No existing backend convention for a TEXT-field length
bound was found anywhere in this codebase during the Step 1 audit (the
pre-existing `teacher_validation.teacher_notes` column is unbound TEXT with
no `isLength` validator applied anywhere in its controller). Per Step 2's
own instruction, a length limit is **not decided here** — it is deferred to
Step 3's validation design, to be chosen only if a genuine reviewed
convention or product requirement emerges by then.

## 8. Fingerprint roles

Two separate fingerprints, never collapsed into one:

- **`evidence_fingerprint`** — identity of the Feature 7 evidence window
  (`studentId`, `caseType`, `family`, both windows' cycle counts and
  timestamps, `affectedLetters`, `persistent_policy_version`,
  `mapping_version`). Answers: *"was this the same persistent-difficulty
  evidence?"*
- **`recommendation_fingerprint`** — identity of the Feature 8
  recommendation instance built from that evidence (`studentId`,
  `caseType`, `family`, `recommendationType`, `focusLetters`,
  `evidenceFingerprint`, `recommendation_policy_version`). Answers: *"was
  this the same teacher-facing recommendation instance?"* — and it chains
  in `evidence_fingerprint` rather than re-deriving evidence identity
  itself.

Both are computed by `src/config/feature9Provenance.js` (Step 2, this
step) — pure functions, zero DB access, zero Feature 7/8 service imports.

## 9. Server-side trust model (Step 3/4)

A future write endpoint may accept from the frontend:

- `caseType`, `family`
- `validation`
- `teacherNote`
- `recommendationFingerprint` (the fingerprint the teacher's client last
  fetched, for the race check in §10)

It must **never trust** the frontend for: `recommendation_title`,
`focus_letters`, `suggested_activities`, `rationale`,
`evidence_fingerprint`, either policy version, or `teacher_id`. All of
these must be reconstructed server-side by re-evaluating Feature 8
(`evaluateWorksheetRecommendations({studentId})`) and locating the matching
`(caseType, family)` stream — the same discipline
`dynamicThresholdService.js`'s automatic-persistence logic already applies
to its own evidence (Step 1 audit §39).

## 10. Race handling (Step 3/4)

If the client-supplied `recommendationFingerprint` does not equal the
fingerprint the server computes from its own fresh Feature 8 re-evaluation,
the write must be rejected with **`409 recommendation_changed`** and no row
written. This protects against a teacher validating a recommendation that
changed (new practice data arrived) between viewing it and pressing
Confirm/Not suitable.

## 11. Idempotency (Step 3)

Candidate partial unique index:

```
(student_id, teacher_id, case_type, family, validation, recommendation_fingerprint)
```

This means a double-POST of the same action for the same recommendation
instance (e.g. a network retry on "Confirm") produces exactly **one**
event, not two. It deliberately does **not** prevent a teacher from later
appending a *different* `validation` value for the same recommendation
instance — `confirmed` then `dismissed` for the same
`recommendation_fingerprint` are two valid, distinct history events,
because `validation` is itself part of the unique key. Only a literal
duplicate (`confirmed` immediately followed by another `confirmed` with the
identical fingerprint) is prevented.

## 12. Latest-state semantics

The teacher's current status for a **currently displayed** recommendation
must be resolved by:

```
recommendation_fingerprint  (of the exact instance currently displayed)
+ created_at DESC
+ id DESC
```

**Not** by `student_id + case_type + family` alone. A newer recommendation
instance (new evidence, §13 below) may exist for the same three-tuple with
a different fingerprint — resolving "latest state" by the three-tuple alone
would incorrectly attach an old validation to unrelated new evidence.

## 13. Stream-level history (distinct from §12)

For historical browsing (a teacher reviewing everything ever recorded for
a given `student + case + family`), it is correct and useful to aggregate
**all** recommendation instances over time by the three-tuple — this is a
genuinely different query from §12's "what is the current state of the
recommendation on screen right now" resolution. The two must not be
conflated: stream-level history answers "what has this stream's story
been," while latest-state answers "does today's specific recommendation
already have a teacher judgement."

## 14. New-evidence semantics

A new `evidence_fingerprint` (different underlying Feature 7 window) always
produces a new `recommendation_fingerprint`, even if `caseType`, `family`,
and `focusLetters` happen to look similar to a prior instance. A prior
validation does **not** automatically carry forward to genuinely new
evidence — the teacher-facing state for that new instance is "Not
reviewed" until they act on it again. This is the direct, intended
consequence of chaining `evidence_fingerprint` into the recommendation
fingerprint (§8).

## 15. Recommendation-suppression decision

A `dismissed` validation does **not** suppress Feature 8 from generating
that recommendation again on a future evaluation. Feature 8 remains fully
independent of Feature 9's history — this is a hard boundary (Step 1 audit
§30/§33). The UI may show the teacher's prior status alongside a
recurring recommendation ("Previously marked: Not suitable"), but the
recommendation itself keeps appearing for as long as the underlying Feature
7 evidence continues to warrant it.

## 16. No algorithm feedback

Teacher validation must never directly change: baseline (Feature 1),
threshold (Feature 2), support level (Feature 3), pre-writing activity
selection (Feature 4), repetition recommendation (Feature 5), demo-speed
recommendation (Feature 6), persistent-difficulty detection (Feature 7), or
worksheet-recommendation generation (Feature 8). Feature 9 records human
judgement; it does not feed it back into any algorithm in this version.

## 17. Privacy

Teacher notes are ownership-gated (readable only through a
`teacherService.getOwnStudentById`-protected endpoint, exactly like every
other Feature 1–8 read endpoint), never included in `TeacherReportScreen.js`'s
existing `Share.share()` output by default, and never publicly exposed
outside the authenticated teacher API.

## 18. History-response design (Step 3/4)

A future history-list response should return, per event:

```javascript
{
  id,
  caseType,
  family,
  recommendation: { type, title, focusLetters },
  validation,
  teacherNote,
  validatedAt, // == created_at
}
```

Fingerprints are **not** exposed by default in this list response — they
are a write-time integrity mechanism (§9/§10), not information a teacher
needs to see. A future Feature 8 teacher-facing GET response, separately,
may need to expose `recommendationFingerprint` as opaque integrity metadata
so the frontend can echo it back on write (§10) — that is a Feature 8 API
addition, not made in this step, and not made in Step 2.

## 19. Two explicitly rejected alternative architectures

- **A separate `recommendation_events` table**, written independently of
  validation, was considered and rejected for MVP (Step 1 audit §23/§24):
  since a row is only ever written when a teacher acts (§3), the
  recommendation snapshot and the validation are always created in the same
  instant — a second table would only pay for itself if recommendations
  needed to be tracked independent of any validation ever happening, which
  nothing in this application currently requires.
- **Activating Feature 7's own deferred `persistent_difficulty_history`
  table** (`docs/feature7-persistence-design.md`) was considered and
  rejected: Feature 9 validates the Feature 8 **recommendation**, not
  Feature 7's raw stream status directly (Step 1 audit §6/§9/§11) — the two
  tables are separate but linkable (via `evidence_fingerprint`,
  `mapping_version`, and `persistent_policy_version`, all of which both
  designs share), not one unified table, and not a Feature 7 table with
  bolted-on teacher columns.

## 20. Revisit trigger

This design should be revisited once Step 3 begins (migration + model +
services) — at that point the table in §4, the index in §11, and the
length bound deferred in §7 all need a final, implemented decision.
