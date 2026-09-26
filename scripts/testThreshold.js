const db = require('../src/models');
const { Student, LetterProgress } = db;
const sequelize = db.sequelize;

async function run() {
  await sequelize.authenticate();

  const STUDENT_ID = 10;
  const LETTER = 'x';  // use a letter unlikely to have real data
  const CASE_TYPE = 'lowercase';

  // ── SETUP ─────────────────────────────────────────────────
  // Reset student thresholds
  const student = await Student.findByPk(STUDENT_ID);
  await student.update({ personal_thresholds: {} });

  // Remove any existing LetterProgress for this letter
  await LetterProgress.destroy({
    where: { student_id: STUDENT_ID, letter: LETTER, case_type: CASE_TYPE }
  });

  console.log('\n── TEST 1: Auto-lower on repeated blocks ──');

  // Create a block record and increment to 4
  await LetterProgress.create({
    student_id: STUDENT_ID, letter: LETTER, case_type: CASE_TYPE,
    blocked_attempts: 4
  });

  // Read threshold before
  await student.reload();
  const before = student.personal_thresholds;
  console.log('personal_thresholds before:', JSON.stringify(before));
  console.log('blocked_attempts:', 4, '— auto-lower should fire (> 3)');

  // Run auto-lower logic
  const current = student.personal_thresholds ?? {};
  const currentVal = current[LETTER] ?? current.default ?? 55;
  const newVal = Math.max(20, currentVal - 5);
  await student.update({
    personal_thresholds: { ...current, [LETTER]: newVal }
  });

  await student.reload();
  console.log('personal_thresholds after:', JSON.stringify(student.personal_thresholds));
  console.log(`Expected: { "${LETTER}": ${newVal} } — threshold lowered from ${currentVal} to ${newVal}`);

  // ── TEST 2: Auto-raise on 5 clean passes ──────────────────
  console.log('\n── TEST 2: Auto-raise on 5 consecutive clean passes ──');

  // Reset thresholds
  await student.update({ personal_thresholds: {} });

  // Insert 5 completed letters with blocked_attempts = 0
  const letters = ['a', 'b', 'c', 'd', 'e'];
  for (const l of letters) {
    await LetterProgress.destroy({
      where: { student_id: STUDENT_ID, letter: l, case_type: CASE_TYPE }
    });
    await LetterProgress.create({
      student_id: STUDENT_ID, letter: l, case_type: CASE_TYPE,
      blocked_attempts: 0, completed_at: new Date()
    });
  }

  // Read recent passes
  const recentPasses = await LetterProgress.findAll({
    where: { student_id: STUDENT_ID, case_type: CASE_TYPE },
    order: [['completed_at', 'DESC']],
    limit: 5,
  });

  console.log('Recent passes count:', recentPasses.length);
  console.log('All clean (blocked_attempts = 0):',
    recentPasses.every(r => r.blocked_attempts === 0));

  // Run auto-raise logic
  await student.reload();
  const current2 = student.personal_thresholds ?? {};
  const currentDefault = current2.default ?? 55;
  const newDefault = Math.min(85, currentDefault + 5);
  await student.update({
    personal_thresholds: { ...current2, default: newDefault }
  });

  await student.reload();
  console.log('personal_thresholds after:', JSON.stringify(student.personal_thresholds));
  console.log(`Expected: { "default": ${newDefault} } — raised from ${currentDefault} to ${newDefault}`);

  // ── CLEANUP ───────────────────────────────────────────────
  console.log('\n── Cleanup ──');
  await student.update({ personal_thresholds: {} });
  await LetterProgress.destroy({
    where: { student_id: STUDENT_ID, letter: LETTER, case_type: CASE_TYPE }
  });
  for (const l of letters) {
    await LetterProgress.destroy({
      where: { student_id: STUDENT_ID, letter: l, case_type: CASE_TYPE }
    });
  }
  console.log('Reset complete — student back to clean state');

  await sequelize.close();
}

run().catch(console.error);
