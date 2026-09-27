# Structured review and remediation

The Factory adapts the CI-safe PR review contract into sequential, read-only domain reviews followed by a fresh independent validator and schema-validated output. Every validated Critical or High finding becomes its own Remediation Issue and is repaired sequentially with the original Issue Contract; Observations are grouped into one Deferred Review Issue, and incomplete review coverage can never produce Merge Ready.
