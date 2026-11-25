/** The path rule for a test file: a path under a `test`, `tests`, `spec`, `specs` or `__tests__` directory, a `.test`/`.spec` file, or a `test_` file. */
export const TEST_PATH = /(^|\/)(__tests__|tests?|specs?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$/;
