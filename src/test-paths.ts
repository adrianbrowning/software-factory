/** The path rule for a test file: a path under a `test`, `tests`, `spec`, `specs` or `__tests__` directory, a file name ending in `.`, `_` or `-` followed by `test` or `spec` and an extension (`a.test.ts`, `a_test.go`, `a-spec.ts`), or a `test_` prefixed file. */
export const TEST_PATH = /(^|\/)(__tests__|tests?|specs?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$/;
