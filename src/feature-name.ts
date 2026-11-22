const FEATURE_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function requireFeatureName(feature: string) {
  if (!FEATURE_PATTERN.test(feature)) throw new Error('feature must be kebab-case, at most 48 characters');
  return feature;
}
