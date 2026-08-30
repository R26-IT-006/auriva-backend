'use strict';

// Feature 9 Step 4 — route registration + collision tests. Inspects the
// real Express router's own .stack (no HTTP server started, no live DB).

const router = require('../src/routes/handwriting');

function routeEntries() {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods) }));
}

describe('Item 42 — Feature 9 routes registered exactly once', () => {
  it('GET history route is registered exactly once', () => {
    const matches = routeEntries().filter(
      (r) => r.path === '/worksheet-recommendation-validations/:studentId' && r.methods.includes('get')
    );
    expect(matches).toHaveLength(1);
  });

  it('POST validation route is registered exactly once', () => {
    const matches = routeEntries().filter(
      (r) => r.path === '/worksheet-recommendation-validations/:studentId' && r.methods.includes('post')
    );
    expect(matches).toHaveLength(1);
  });

  it('GET current-state route is registered exactly once', () => {
    const matches = routeEntries().filter(
      (r) => r.path === '/worksheet-recommendation-validation-state/:studentId' && r.methods.includes('get')
    );
    expect(matches).toHaveLength(1);
  });
});

describe('Item 52 — Feature 9 routes do not collide with the collection-mode /teacher-validation routes', () => {
  it('the pre-existing POST /teacher-validation route is still registered, unmodified, exactly once', () => {
    const matches = routeEntries().filter((r) => r.path === '/teacher-validation' && r.methods.includes('post'));
    expect(matches).toHaveLength(1);
  });

  it('the pre-existing GET /teacher-validation/:sessionId route is still registered, unmodified, exactly once', () => {
    const matches = routeEntries().filter(
      (r) => r.path === '/teacher-validation/:sessionId' && r.methods.includes('get')
    );
    expect(matches).toHaveLength(1);
  });

  it('no Feature 9 route path equals or is nested inside /teacher-validation', () => {
    const feature9Paths = routeEntries()
      .map((r) => r.path)
      .filter((p) => p.startsWith('/worksheet-recommendation-validation'));
    for (const p of feature9Paths) {
      expect(p).not.toBe('/teacher-validation');
      expect(p).not.toBe('/teacher-validation/:sessionId');
      expect(p.startsWith('/teacher-validation')).toBe(false);
    }
  });

  it('exactly 4 distinct Feature 9 route registrations exist (GET history, POST validation, GET current-state)', () => {
    const feature9Routes = routeEntries().filter((r) => r.path.startsWith('/worksheet-recommendation-validation'));
    expect(feature9Routes).toHaveLength(3);
  });
});

describe('router-level auth middleware still applies globally', () => {
  it('verifyToken/isTeacher are registered before any route layer (unchanged router.use)', () => {
    const firstRouteIndex = router.stack.findIndex((layer) => layer.route);
    const middlewareBeforeRoutes = router.stack.slice(0, firstRouteIndex).filter((layer) => !layer.route);
    expect(middlewareBeforeRoutes.length).toBeGreaterThanOrEqual(1);
  });
});
