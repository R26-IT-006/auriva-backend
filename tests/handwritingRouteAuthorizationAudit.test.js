'use strict';

// Final pre-PP2 fix — exhaustive route-authorization audit (spec item 4/12).
// Enumerates EVERY route currently registered in routes/handwriting.js from
// the router source itself (not a hand-maintained list that could silently
// drift), classifies each as student-scoped-production /
// collection-mode-research / not-student-scoped, and — for every
// student-scoped production route — asserts the corresponding controller
// function's own source contains an ownership check (or is dispatched
// through a wrapper already proven to, like wordRead). This is a
// regression guard: a future new route that forgets an ownership check
// will fail this test, not just escape a one-time audit.

const fs = require('fs');
const path = require('path');

function read(p) { return fs.readFileSync(path.resolve(__dirname, p), 'utf8'); }

const routesSource      = read('../src/routes/handwriting.js');
const handwritingSource = read('../src/controllers/handwritingController.js');
const collectionSource  = read('../src/controllers/collectionController.js');
const liveSessionSource = read('../src/controllers/liveSessionController.js');
const liveSessionSvcSource = read('../src/services/liveSessionService.js');
const reportSource      = read('../src/controllers/reportController.js');

// Every route line, extracted directly from the router source — proves
// this test's own route list can never silently go stale relative to the
// real router.
const ROUTE_LINE_RE = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(\S+?)\)\s*;/g;

function extractRoutes(source) {
  const routes = [];
  let m;
  while ((m = ROUTE_LINE_RE.exec(source)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], handlerRef: m[3] });
  }
  return routes;
}

const routes = extractRoutes(routesSource);

// Sanity: the router actually has routes, and the extraction regex found a
// realistic number (guards against the regex silently matching nothing if
// the file's formatting ever changes).
test('sanity — route extraction found the expected approximate route count', () => {
  expect(routes.length).toBeGreaterThanOrEqual(39);
});

// Every ctrl./collectionCtrl./liveSessionCtrl./reportCtrl. handler maps to
// exactly one of these controller source files.
function sourceForHandler(handlerRef) {
  if (handlerRef.startsWith('collectionCtrl.')) return collectionSource;
  if (handlerRef.startsWith('liveSessionCtrl.')) return liveSessionSource + liveSessionSvcSource;
  if (handlerRef.startsWith('reportCtrl.')) return reportSource;
  if (handlerRef.startsWith('ctrl.')) return handwritingSource;
  throw new Error(`Unrecognized handler reference: ${handlerRef}`);
}

function functionName(handlerRef) {
  return handlerRef.split('.')[1];
}

/**
 * Returns the source text of the function body that actually PERFORMS the
 * ownership check for a given handler — following one level of delegation
 * (wordRead, liveSessionService) where that's the real, established
 * pattern, rather than requiring the check to be textually inline in a
 * thin controller.
 */
function resolveEnforcingFunctionBody(handlerRef) {
  const fnName = functionName(handlerRef);

  if (handlerRef.startsWith('liveSessionCtrl.')) {
    const serviceFnName = DELEGATES_TO_SERVICE_FUNCTION[fnName];
    const idx = liveSessionSvcSource.indexOf(`async function ${serviceFnName}`);
    expect(idx).toBeGreaterThan(-1);
    return liveSessionSvcSource.slice(idx, idx + 800);
  }

  const source = sourceForHandler(handlerRef);
  const idx = source.indexOf(`async function ${fnName}`) !== -1
    ? source.indexOf(`async function ${fnName}`)
    : source.indexOf(fnName); // arrow-function/const style (postWordAttempt, postWordActivity)
  expect(idx).toBeGreaterThan(-1); // the handler function must actually exist in the expected source
  return source.slice(idx, idx + 2000);
}

// Collection-mode research endpoints — listed separately per spec item 4.
// exportMlSamples is the one documented, justified exception (multi-student
// research export, no single studentId to check ownership against).
const COLLECTION_MODE_ROUTES = new Set([
  '/collection-session/start', '/collection-session/:id/complete',
  '/teacher-validation', '/teacher-validation/:sessionId', '/ml-samples/export',
]);

// Word-progress reads are dispatched through the shared wordRead() wrapper
// (const getWordProgress=(req,res)=>wordRead(req,res,...)), which itself
// contains the ownership check — verified once, here, rather than per-route.
const WORD_READ_FUNCTIONS = new Set(['getWordProgress', 'getWordAttempts', 'getWordReport']);

// liveSessionController's two handlers are thin delegates — the actual
// ownership check lives one level down, inside liveSessionService's own
// upsertLiveSession/getLiveSession (verified directly in
// liveSessionAuthorization.test.js). Map the controller function to the
// SERVICE function whose body actually contains the check, rather than
// expecting it inline in the thin controller.
const DELEGATES_TO_SERVICE_FUNCTION = {
  putLiveSession: 'upsertLiveSession',
  getLiveSession: 'getLiveSession', // same name on both sides — still resolved via liveSessionSvcSource
};

describe('Every registered handwriting route is classified and, if student-scoped production, ownership-protected', () => {
  it('wordRead() (the shared dispatcher for getWordProgress/getWordAttempts/getWordReport) itself contains an ownership check', () => {
    const wordReadBody = handwritingSource.slice(
      handwritingSource.indexOf('async function wordRead'),
      handwritingSource.indexOf('async function wordRead') + 400
    );
    expect(wordReadBody).toContain('getOwnStudentById');
  });

  it.each(routes)('$method $path → $handlerRef', ({ method, path: routePath, handlerRef }) => {
    if (COLLECTION_MODE_ROUTES.has(routePath)) {
      // Listed separately, not asserted against getOwnStudentById here —
      // already individually verified in collectionControllerAuthorization.test.js
      // (exportMlSamples is the sole documented exception).
      return;
    }

    const fnName = functionName(handlerRef);

    if (WORD_READ_FUNCTIONS.has(fnName)) {
      // Protected transitively via wordRead() — verified above.
      return;
    }

    // finalizeAssessment/completeCollectionSession-style endpoints derive
    // ownership from an already-loaded resource's own student_id rather
    // than a client-supplied param — still must contain the same
    // getOwnStudentById call, just with a different second argument.
    // liveSessionCtrl handlers delegate one level down into
    // liveSessionService — resolveEnforcingFunctionBody follows that.
    const fnBody = resolveEnforcingFunctionBody(handlerRef);
    expect(fnBody).toContain('getOwnStudentById');
  });
});

describe('Zero unprotected production student-scoped handwriting endpoints (summary count)', () => {
  it('every non-collection-mode route resolves to a function containing getOwnStudentById, directly or via wordRead', () => {
    const productionRoutes = routes.filter((r) => !COLLECTION_MODE_ROUTES.has(r.path));
    let unprotected = 0;

    for (const { handlerRef } of productionRoutes) {
      const fnName = functionName(handlerRef);
      if (WORD_READ_FUNCTIONS.has(fnName)) continue; // protected via wordRead, verified above
      const fnBody = resolveEnforcingFunctionBody(handlerRef);
      if (!fnBody.includes('getOwnStudentById')) unprotected += 1;
    }

    expect(unprotected).toBe(0);
    expect(productionRoutes.length).toBeGreaterThan(0);
  });
});
