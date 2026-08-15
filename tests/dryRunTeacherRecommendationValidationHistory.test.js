'use strict';

// Feature 9 Step 4 — dryRunTeacherRecommendationValidationHistory.js CLI.
// Verifies argument parsing and orchestration without hitting the real
// database. Mirrors tests/dryRunWorksheetRecommendations.test.js's exact
// convention.

const mockGetTeacherValidationHistory = jest.fn();

jest.mock('../src/services/teacherRecommendationValidationService', () => ({
  getTeacherValidationHistory: (...args) => mockGetTeacherValidationHistory(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, printResult, run } = require('../src/scripts/dryRunTeacherRecommendationValidationHistory');

function makeEvent(overrides = {}) {
  return {
    id: 1, caseType: 'lowercase', family: 'curved',
    recommendation: { type: 'motor_family_practice', title: 'Curved Movement Practice', focusLetters: ['c', 'o'] },
    validation: 'confirmed', teacherNote: null, validatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return { status: 'evaluated', studentId: 13, events: [], latestByStream: { lowercase: {}, uppercase: {} }, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('46. parseArgs with a valid student id', () => {
  it('parses --student-id', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ studentId: 13, caseType: undefined, family: undefined });
  });
});

describe('47. missing --student-id', () => {
  it('throws requiring --student-id', () => {
    expect(() => parseArgs([])).toThrow(/--student-id is required/);
  });
});

describe('48. invalid --student-id', () => {
  it.each(['abc', '0', '-1', '1.5'])('throws for studentId=%p', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });
});

describe('49. valid --case-type filter', () => {
  it('parses --case-type', () => {
    expect(parseArgs(['--student-id=13', '--case-type=lowercase']).caseType).toBe('lowercase');
  });
});

describe('50. valid --family filter', () => {
  it('parses --family', () => {
    expect(parseArgs(['--student-id=13', '--family=curved']).family).toBe('curved');
  });
});

describe('51. invalid --case-type', () => {
  it('throws for an unrecognized case type', () => {
    expect(() => parseArgs(['--student-id=13', '--case-type=mixedcase'])).toThrow(/Invalid --case-type/);
  });
});

describe('52. invalid --family', () => {
  it('throws for an unrecognized family', () => {
    expect(() => parseArgs(['--student-id=13', '--family=diagonal'])).toThrow(/Invalid --family/);
  });
});

describe('53. --apply is a hard error', () => {
  it('rejects --apply', () => {
    expect(() => parseArgs(['--student-id=13', '--apply'])).toThrow(/read-only/);
  });
});

describe('54. --confirm is a hard error', () => {
  it('rejects --confirm', () => {
    expect(() => parseArgs(['--student-id=13', '--confirm'])).toThrow(/read-only/);
  });
});

describe('55. --dismiss is a hard error', () => {
  it('rejects --dismiss', () => {
    expect(() => parseArgs(['--student-id=13', '--dismiss'])).toThrow(/read-only/);
  });

  it('--write is also a hard error', () => {
    expect(() => parseArgs(['--student-id=13', '--write'])).toThrow(/read-only/);
  });
});

describe('56. empty history output', () => {
  it('prints "No teacher recommendation validations recorded."', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, makeResult({ events: [] }));
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/Teacher validation history: 0/);
    expect(output).toMatch(/No teacher recommendation validations recorded\./);
    logSpy.mockRestore();
  });
});

describe('57. non-empty history output', () => {
  it('prints each event numbered, with case/title/validation/date', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, makeResult({
      events: [
        makeEvent({ id: 2, validation: 'dismissed', validatedAt: '2026-08-20T00:00:00.000Z' }),
        makeEvent({ id: 1, validation: 'confirmed', validatedAt: '2026-08-10T00:00:00.000Z' }),
      ],
    }));
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/Teacher validation history: 2/);
    expect(output).toMatch(/1\. Lowercase — Curved Movement Practice/);
    expect(output).toMatch(/2\. Lowercase — Curved Movement Practice/);
    logSpy.mockRestore();
  });
});

describe('58. confirmed maps to "Confirmed"', () => {
  it('renders the teacher-facing label, not the machine value', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, makeResult({ events: [makeEvent({ validation: 'confirmed' })] }));
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/Validation: Confirmed/);
    logSpy.mockRestore();
  });
});

describe('59. dismissed maps to "Not suitable"', () => {
  it('renders the teacher-facing label, not "dismissed"', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, makeResult({ events: [makeEvent({ validation: 'dismissed' })] }));
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/Validation: Not suitable/);
    logSpy.mockRestore();
  });
});

describe('60. note displayed when present', () => {
  it('prints the Note: line only when teacherNote is set', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, makeResult({ events: [makeEvent({ teacherNote: 'Child was tired today' })] }));
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/Note: Child was tired today/);
    logSpy.mockRestore();
  });

  it('omits the Note: line when teacherNote is null', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, makeResult({ events: [makeEvent({ teacherNote: null })] }));
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).not.toMatch(/Note:/);
    logSpy.mockRestore();
  });
});

describe('61. no hashes printed anywhere', () => {
  it('printResult output never contains a 64-char hex fingerprint', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, makeResult({ events: [makeEvent()] }));
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).not.toMatch(/[a-f0-9]{64}/);
    logSpy.mockRestore();
  });
});

describe('62. no writes — run() only ever calls the read-only history service', () => {
  it('calls getTeacherValidationHistory exactly once and never any write method', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce(makeResult());
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await run({ studentId: 13, caseType: undefined, family: undefined });
    logSpy.mockRestore();
    expect(mockGetTeacherValidationHistory).toHaveBeenCalledTimes(1);
    expect(mockGetTeacherValidationHistory).toHaveBeenCalledWith({ studentId: 13, caseType: undefined, family: undefined });
  });

  it('forwards --case-type/--family filters to the service', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce(makeResult());
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await run({ studentId: 13, caseType: 'lowercase', family: 'curved' });
    logSpy.mockRestore();
    expect(mockGetTeacherValidationHistory).toHaveBeenCalledWith({ studentId: 13, caseType: 'lowercase', family: 'curved' });
  });
});

describe('read_failed status', () => {
  it('printResult reports an unable-to-read message', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, { status: 'read_failed' });
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/Unable to read teacher validation history/);
    logSpy.mockRestore();
  });

  it('run() resolves with result.status === "read_failed" (exit-code decision happens at the CLI boundary)', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, events: null, latestByStream: null });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const report = await run({ studentId: 13, caseType: undefined, family: undefined });
    logSpy.mockRestore();
    expect(report.result.status).toBe('read_failed');
  });
});
