# Feature 7 — Persistent-Difficulty Persistence Design (Deferred)

**Status as of Step 4: DEFERRED.** This document is pure design/reference —
no schema described here has been migrated, no model exists for it, and
nothing in the running application reads or writes this shape. It exists so
a future step (or a future contributor) does not have to re-derive this
design from scratch, and so the current deferral decision is documented as
intentional rather than merely absent.

See `src/config/persistentDifficultyPolicy.js` and
`src/services/persistentDifficultyService.js` for the actual, currently-running,
fully computed-on-demand implementation this document does NOT replace or
schedule — it only describes what a *future* append-only history layer
could look like, if and when one of the revisit triggers in §7 fires.

## 1. Why persistence is deferred right now

Feature 7's current status is always exactly reconstructable from the raw,
already-persisted, immutable `LetterAttempt` evidence — nothing about
"today's answer" requires its own storage. Live validation (Step 3 and
Step 4) found **zero** streams, across every student in the live dataset,
currently reaching `persistent` or `not_persistent` — every stream today is
`insufficient_data` (either `insufficient_cycles` or
`insufficient_temporal_dispersion`). There is, quite literally, no
meaningful state yet to preserve. See the Step 4 final report's live
validation sections for the exact numbers this conclusion is based on.

## 2. Why a mutable "current status" table would be dangerous

A table storing only `{student_id, case_type, family, current_status}` is
tempting but wrong as a *sole* source of truth: the value can silently go
stale the moment any of the following happens without a perfectly-timed
recompute —

- a new practice cycle arrives (the rolling window shifts),
- the "recent" window's contents change as evidence ages out of the earlier
  window,
- the student's performance genuinely improves or regresses,
- the Step 4 policy itself changes (window size, separation requirement,
  difficulty bar).

Without a flawless invalidation/recompute pipeline triggered on every one of
these events, a teacher or Feature 8 worksheet recommender could read a
`current_status` row that no longer matches what the live evidence actually
shows — exactly the kind of "difficulty detected → the label just sticks"
staleness risk Feature 7's own design has tried to avoid from Step 1
onward. If persistence is ever introduced, it must never be a bare mutable
current-state row as the only record.

## 3. The recommended future shape: append-only events, not mutable state

If/when persistence is introduced, it should follow the same pattern
`student_threshold_history` (Feature 2) already established: **append-only
event rows**, each representing the result of one evaluation at one point
in time, over one immutable evidence snapshot — never updated in place,
never deleted, never treated as "the current truth" without also checking
whether newer evidence exists.

A likely table name: `persistent_difficulty_history` (mirrors
`student_threshold_history`'s own naming convention).

### 3.1 Candidate fields

| Field | Necessary? | Rationale |
|---|---|---|
| `id` | yes | primary key |
| `student_id` | yes | scope |
| `case_type` | yes | one of the six streams |
| `family` | yes | one of the six streams |
| `status` | yes | `insufficient_data`\|`not_persistent`\|`persistent` (and, if recovery is ever activated, `resolved` — see §6) |
| `reason` | yes | the specific sub-reason (`insufficient_cycles`, `repeated_difficulty_across_windows`, etc.) |
| `window_size` | yes | which policy window size produced this event (protects old events if the constant ever changes) |
| `earlier_successful_cycles` / `earlier_failed_cycles` | yes | the earlier window's outcome tally only — never the raw cycles themselves |
| `earlier_evidence_start` / `earlier_evidence_end` | yes | ISO timestamps bounding the earlier window |
| `recent_successful_cycles` / `recent_failed_cycles` | yes | same, for the recent window |
| `recent_evidence_start` / `recent_evidence_end` | yes | same |
| `separation_ms` | yes | the actual gap observed |
| `required_separation_ms` | yes | the policy value THAT WAS ACTIVE at evaluation time (never re-derived from the current constant — see §5) |
| `affected_letters` (JSONB) | yes | the exact snapshot (§8), never re-queried later |
| `evidence_fingerprint` | yes | see §4 |
| `policy_version` | yes | see §5 |
| `mapping_version` | yes | see §6 — reuses `letterBaselineFamilies.js`'s existing `MAPPING_VERSION` constant (`'letter-baseline-family-v1'` as of this writing), never a new duplicate version scheme |
| `created_at` | yes | append-only ordering |

### 3.2 Deliberately excluded

- No raw `LetterAttempt` row copies, no `session_key` list, no `attempt_id`
  list — `evidence_fingerprint` (§4) exists precisely so "was this the same
  evidence" is answerable without ever storing or exposing the underlying
  IDs.
- No stroke data, no `normalized_features`, no per-cycle raw scores — this
  table (like every Feature 7 API response) stays strictly categorical/
  summary, matching the read-only endpoint's own existing discipline.
- No `old_status` column — an event's relationship to the *previous* event
  for the same stream is derivable by querying the prior row
  (`ORDER BY created_at DESC LIMIT 1 OFFSET 1`), the same way
  `ThresholdHistory.old_threshold` isn't strictly required either but was
  added there for query convenience — worth revisiting only once a real
  query pattern justifies it, not preemptively.

## 4. Evidence fingerprint

A stable hash (sha256, matching `ThresholdHistory.evidence_fingerprint`'s
own precedent in `dynamicThresholdService.js`'s `computeEvidenceFingerprint`)
computed from exactly the inputs that determine the evaluation outcome:
`student_id`, `case_type`, `family`, the ordered list of the 10 selected
cycles' `(session_key, attempt_number)` pairs and their reconstructed
`outcome`, and `policy_version`. Two evaluations over identical evidence
under the identical policy produce an identical fingerprint — the
mechanism a future event-generation rule (§5 below, and the Step 4 prompt's
own §11) would use to avoid writing a duplicate row for a read that changed
nothing. The fingerprint is a one-way hash, never a way to reconstruct the
underlying session keys/attempt IDs from the stored value — it protects
privacy the same way `ThresholdHistory`'s existing fingerprint already does.

## 5. Policy version

Reserve `policy_version = 'persistent_difficulty_v1'` on every future event
row. Feature 7's window size, two-window requirement, 24-hour separation,
and "≤1 success = difficult" bar are all pilot engineering defaults (Step 2
report) that may be revisited later. An old event must remain interpretable
exactly as it was computed at the time — a future policy change (e.g.
`WINDOW_SIZE` becoming 7) must never cause old rows to be silently
reinterpreted under the new rule. `required_separation_ms`/`window_size`
being stored per-row (§3.1) reinforces this: even without parsing
`policy_version`, the row's own numbers tell you what threshold it was
judged against.

## 6. Mapping version

Reuse `letterBaselineFamilies.js`'s existing `MAPPING_VERSION` constant
(currently `'letter-baseline-family-v1'`) verbatim — do not invent a second,
Feature-7-specific version scheme for the same underlying mapping. This
mirrors exactly how `ThresholdHistory.mapping_version` already reuses it
(Feature 2's own precedent).

## 7. affectedLetters snapshot

Stored as the literal JSONB array the API returned at evaluation time
(`[{letter, totalCycles, failedCycles}, ...]`) — never re-derived later by
re-querying current attempts. Practice continues after an event is
recorded; the live "which letters are struggling" answer will keep
changing, but a teacher or researcher asking "what evidence produced THIS
persistent flag, back when it was flagged" needs the frozen snapshot, not
today's answer.

## 8. Event-generation rule (not every read)

**Not every `evaluatePersistentDifficulty()` call should produce a history
row.** An event should be written only for a *meaningful state transition*:

- no previous event exists **and** current status is `persistent` → write
  a `persistent` event (the "first detected at" case, §11);
- previous event was `persistent` **and** a future recovery rule (§9,
  still undesigned/undecided) concludes `resolved` → write a `resolved`
  event;
- current evidence fingerprint (§4) equals the fingerprint already recorded
  on the latest event for that stream → **no new event**, even if the read
  happened again.

`not_persistent` is deliberately NOT proposed as its own event category in
most cases (§10) — "current evidence doesn't show persistence" is usually
not a meaningful teacher-facing moment worth its own permanent row. The
one exception worth reserving room for: a `not_persistent` reached
immediately after a `persistent` event (i.e., a de-facto recovery signal)
— see §9's `resolved` design instead of double-counting this as a second
event type.

## 9. Recovery/resolution — designed for compatibility, not activated

Feature 7 v1 intentionally has no `resolved` status (Step 2/3 decision,
unchanged this step). If a future event history is introduced, its
`status` column must be an open string/enum, never a boolean — so adding
`resolved` later is an additive vocabulary change, not a schema migration.
A plausible future recovery rule (NOT chosen or implemented now): a stream
previously `persistent`, whose next temporally-valid recent window (and
possibly a second confirming window) shows ≥4-of-5 successes, transitions
to `resolved`. This is exactly the shape of rule Step 2's own
"recent_improvement" `not_persistent` reason already computes at the
window level — recovery design would likely reuse it, not reinvent it.

## 10. Teacher-validation extensibility (Feature 9, not now)

Feature 9 is planned to add teacher validation + long-term history. This
schema deliberately leaves room for future additive columns —
`teacher_confirmed`, `teacher_dismissed`, `teacher_note`, `validated_at`,
`validated_by` — without needing to redesign the event table itself: these
would be additive nullable columns on `persistent_difficulty_history`
(mirroring how `TeacherValidation`/`ThresholdHistory.source =
'teacher_override'` already layer human input onto existing Feature 2/3
event shapes elsewhere in this codebase). **None of these fields are added
now.**

## 11. Explicit persistence revisit triggers

Persistence should be reconsidered — not automatically implemented, but
actively re-evaluated — when ANY of the following occurs:

1. A real live stream reaches `persistent` for the first time.
2. Feature 8 (teacher worksheet recommendations) needs a durable "first
   detected at" timestamp that computed-on-demand cannot cheaply provide.
3. Feature 9 (teacher validation + long-term history) is implemented.
4. A research protocol begins deliberately collecting longitudinal
   evaluation events for its own analysis purposes.

## 12. Feature 8 compatibility note

Feature 8 can consume `GET /handwriting/persistent-difficulty/:studentId`
directly, exactly as it exists today (Step 3) — Feature 7 persistence is
**not** a prerequisite for Feature 8's first implementation. A teacher
screen that calls this endpoint on open always sees a live-recomputed
result (§2's staleness risk avoided entirely) at the cost of not yet having
a durable "since when" answer (§11 item 2 is the trigger for closing that
gap later).
